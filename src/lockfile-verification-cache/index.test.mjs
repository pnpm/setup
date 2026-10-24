import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{
    name: 'verification-cache-fixtures',
    setup (build) {
      build.onResolve({ filter: /^@actions\/(cache|core|exec)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents:
        args.path === '@actions/cache' ? `
          export async function restoreCache() { return undefined }
          export async function saveCache() { return globalThis.fixture.save() }
        ` : args.path === '@actions/core' ? `
          export const debug = () => {}
          export const info = () => {}
          export const warning = message => { globalThis.fixture.warnings.push(message) }
          export const getState = name => globalThis.fixture.state.get(name) ?? ''
          export const saveState = (name, value) => { globalThis.fixture.state.set(name, String(value)) }
        ` : `
          export async function getExecOutput(command) {
            return globalThis.fixture.exec?.(command) ?? { exitCode: 0, stdout: globalThis.fixture.cacheDir }
          }
        `,
      }))
    },
  }],
})

// The main and post steps run as separate processes that share only the
// action's state, so each step gets a fresh copy of the module.
function loadStep () {
  const bundled = { exports: {} }
  new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(import.meta.url), bundled, bundled.exports)
  return bundled.exports
}

function setup (testContext, save) {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'setup-verification-'))
  const fixture = { cacheDir, state: new Map(), warnings: [], saves: 0 }
  fixture.save = () => {
    fixture.saves++
    return save()
  }
  globalThis.fixture = fixture
  testContext.after(() => {
    rmSync(cacheDir, { recursive: true, force: true })
    delete globalThis.fixture
  })
  return { fixture, log: path.join(cacheDir, 'lockfile-verified.jsonl') }
}

// The runtime installs leave a record in the log before the snapshot, which is
// what bounds what the project install may add.
async function runMainStep (log, added) {
  const main = loadStep()
  await main.restoreVerificationCache('hash')
  writeFileSync(log, 'runtime\n')
  main.snapshotVerificationLog()
  appendFileSync(log, added.map(record => `${record}\n`).join(''))
  await main.saveVerificationCache(1)
}

test('a save that lost the race is not retried in the post step', async testContext => {
  const { fixture, log } = setup(testContext, () => -1)
  await runMainStep(log, ['a'])
  await loadStep().saveVerificationCache()
  assert.equal(fixture.saves, 1)
})

test('a save that failed is not retried in the post step', async testContext => {
  const { fixture, log } = setup(testContext, () => {
    throw new Error('offline')
  })
  await runMainStep(log, ['a'])
  await loadStep().saveVerificationCache()
  assert.equal(fixture.saves, 1)
  assert.equal(fixture.warnings.length, 1)
})

test('a log the main step rejected is not saved by the post step', async testContext => {
  const { fixture, log } = setup(testContext, () => 1)
  await runMainStep(log, ['a', 'b'])
  await loadStep().saveVerificationCache()
  assert.equal(fixture.saves, 0)
})

test('the post step saves the log when the job installs in a step of its own', async testContext => {
  const { fixture, log } = setup(testContext, () => 1)
  const main = loadStep()
  await main.restoreVerificationCache('hash')
  writeFileSync(log, 'runtime\n')
  main.snapshotVerificationLog()
  appendFileSync(log, 'a\n')
  await loadStep().saveVerificationCache()
  assert.equal(fixture.saves, 1)
})

const restoredPath = fixture => fixture.state.get('lockfile_verification_cache_path')

test('a warning printed ahead of the cache path is not part of the path', async testContext => {
  const { fixture, log } = setup(testContext, () => 1)
  fixture.exec = () => ({
    exitCode: 0,
    stdout: `[WARN] This project requires Node.js 26.10.0. Your current Node.js is v24.18.0\n${fixture.cacheDir}\n`,
  })
  await loadStep().restoreVerificationCache('hash')
  assert.equal(restoredPath(fixture), log)
  writeFileSync(log, 'a\n')
  await loadStep().saveVerificationCache()
  assert.equal(fixture.saves, 1)
})

test('usage text from a pnpm without `cache path` falls back to the configured directory', async testContext => {
  const { fixture, log } = setup(testContext, () => 1)
  fixture.exec = command => command === 'pnpm cache path'
    ? { exitCode: 0, stdout: 'Usage: pnpm cache <command>\n\nInspect and manage the metadata cache\n' }
    : { exitCode: 0, stdout: `[WARN] some warning\n${fixture.cacheDir}\n` }
  await loadStep().restoreVerificationCache('hash')
  assert.equal(restoredPath(fixture), log)
})

test('an unset cacheDir falls back to the default directory', async testContext => {
  const { fixture } = setup(testContext, () => 1)
  const previous = process.env.XDG_CACHE_HOME
  testContext.after(() => {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previous
  })
  process.env.XDG_CACHE_HOME = fixture.cacheDir
  fixture.exec = command => command === 'pnpm cache path'
    ? { exitCode: 1, stdout: '' }
    : { exitCode: 0, stdout: 'undefined\n' }
  await loadStep().restoreVerificationCache('hash')
  assert.equal(restoredPath(fixture), path.join(fixture.cacheDir, 'pnpm', 'lockfile-verified.jsonl'))
})

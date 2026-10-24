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
    setup(build) {
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
          export async function getExecOutput() { return { exitCode: 0, stdout: globalThis.fixture.cacheDir } }
        `,
      }))
    },
  }],
})

// The main and post steps run as separate processes that share only the
// action's state, so each step gets a fresh copy of the module.
function loadStep() {
  const bundled = { exports: {} }
  new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(import.meta.url), bundled, bundled.exports)
  return bundled.exports
}

function setup(t, save) {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'setup-verification-'))
  const fixture = { cacheDir, state: new Map(), warnings: [], saves: 0 }
  fixture.save = () => {
    fixture.saves++
    return save()
  }
  globalThis.fixture = fixture
  t.after(() => {
    rmSync(cacheDir, { recursive: true, force: true })
    delete globalThis.fixture
  })
  return { fixture, log: path.join(cacheDir, 'lockfile-verified.jsonl') }
}

// The runtime installs leave a record in the log before the snapshot, which is
// what bounds what the project install may add.
async function runMainStep(log, added) {
  const main = loadStep()
  await main.restoreVerificationCache('hash')
  writeFileSync(log, 'runtime\n')
  main.snapshotVerificationLog()
  appendFileSync(log, added.map(record => `${record}\n`).join(''))
  await main.saveVerificationCache(1)
}

test('a save that lost the race is not retried in the post step', async t => {
  const { fixture, log } = setup(t, () => -1)
  await runMainStep(log, ['a'])
  await loadStep().saveVerificationCache()
  assert.equal(fixture.saves, 1)
})

test('a save that failed is not retried in the post step', async t => {
  const { fixture, log } = setup(t, () => { throw new Error('offline') })
  await runMainStep(log, ['a'])
  await loadStep().saveVerificationCache()
  assert.equal(fixture.saves, 1)
  assert.equal(fixture.warnings.length, 1)
})

test('a log the main step rejected is not saved by the post step', async t => {
  const { fixture, log } = setup(t, () => 1)
  await runMainStep(log, ['a', 'b'])
  await loadStep().saveVerificationCache()
  assert.equal(fixture.saves, 0)
})

test('the post step saves the log when the job installs in a step of its own', async t => {
  const { fixture, log } = setup(t, () => 1)
  const main = loadStep()
  await main.restoreVerificationCache('hash')
  writeFileSync(log, 'runtime\n')
  main.snapshotVerificationLog()
  appendFileSync(log, 'a\n')
  await loadStep().saveVerificationCache()
  assert.equal(fixture.saves, 1)
})

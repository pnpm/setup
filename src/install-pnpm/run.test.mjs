import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('./run.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{
    name: 'installer-fixtures',
    setup (build) {
      // Only run.ts's own child_process: get-pnpm, bundled in, imports it too.
      build.onResolve({ filter: /^(@actions\/core|\.\/download\.js|node:child_process)$/ }, args =>
        args.path === 'node:child_process' && !args.importer.endsWith('run.ts') ? undefined : { path: args.path, namespace: 'fixture' })
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents:
        args.path === '@actions/core' ? 'export const info = () => {}; export const addPath = () => {}; export const exportVariable = () => {}' :
          args.path === './download.js' ? `
          export async function installPnpm(spec) {
            globalThis.selectedSpec = spec
            const version = /^\\d+\\.\\d+\\.\\d+$/.test(spec) ? spec : '12.8.2'
            return { version, binPath: version }
          }
        ` : `
          import { EventEmitter } from 'node:events'
          export function spawn(version, args) {
            globalThis.versionArgs = args
            const cp = new EventEmitter(); cp.stdout = new EventEmitter()
            process.nextTick(() => { cp.stdout.emit('data', version); cp.emit('close', 0) })
            return cp
          }
        `,
      }))
    },
  }],
})
const bundled = { exports: {} }
new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(import.meta.url), bundled, bundled.exports)

test('installer selects the lock, preserves explicit input, and isolates its sanity check', async testContext => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'setup-installer-'))
  const previous = process.env.GITHUB_WORKSPACE
  testContext.after(() => {
    rmSync(root, { recursive: true, force: true })
    if (previous === undefined) delete process.env.GITHUB_WORKSPACE
    else process.env.GITHUB_WORKSPACE = previous
    delete globalThis.selectedSpec
    delete globalThis.versionArgs
  })
  process.env.GITHUB_WORKSPACE = root
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devEngines: { packageManager: { name: 'pnpm', version: '>=12.0.0 <13.0.0' } } }))
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), `---
importers:
  .:
    packageManagerDependencies:
      pnpm:
        specifier: '>=12.0.0 <13.0.0'
        version: 12.8.1
---
importers: {}
`)
  const inputs = { dest: path.join(root, 'tools'), packageJsonFile: 'package.json' }
  await bundled.exports.runSelfInstaller(inputs)
  assert.equal(globalThis.selectedSpec, '12.8.1')
  assert.deepEqual(globalThis.versionArgs, ['--config.pm-on-fail=ignore', '--version'])
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages: ['packages/*', '!packages/excluded']\n")
  for (const name of ['app', 'excluded']) {
    const directory = path.join(root, 'packages', name)
    mkdirSync(directory, { recursive: true })
    // An included member can omit its pin; an excluded project owns its pin.
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify(name === 'app'
      ? {} : { devEngines: { packageManager: { name: 'pnpm', version: '12.8.2' } } }))
    if (name === 'app') writeFileSync(path.join(directory, 'pnpm-lock.yaml'), '---\nimporters: [\n')
  }
  await bundled.exports.runSelfInstaller({ ...inputs, packageJsonFile: 'packages/app/package.json' })
  assert.equal(globalThis.selectedSpec, '12.8.1')
  await bundled.exports.runSelfInstaller({ ...inputs, packageJsonFile: 'packages/excluded/package.json' })
  assert.equal(globalThis.selectedSpec, '12.8.2')
  // pnpm reads the root's lockfile for the pin even when each project keeps its own.
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages: ['packages/*']\nsharedWorkspaceLockfile: false\n")
  writeFileSync(path.join(root, 'packages/app/pnpm-lock.yaml'), '---\nimporters:\n  .:\n    packageManagerDependencies:\n      pnpm:\n        version: 12.7.0\n')
  await bundled.exports.runSelfInstaller({ ...inputs, packageJsonFile: 'packages/app/package.json' })
  assert.equal(globalThis.selectedSpec, '12.8.1')
  rmSync(path.join(root, 'packages/app/pnpm-lock.yaml'))
  // The pin is read from `lockfileDir`, for a member and for the root itself.
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages: ['packages/*']\nlockfileDir: locks\n")
  mkdirSync(path.join(root, 'locks'))
  writeFileSync(path.join(root, 'locks/pnpm-lock.yaml'), '---\nimporters:\n  .:\n    packageManagerDependencies:\n      pnpm:\n        version: 12.6.0\n')
  await bundled.exports.runSelfInstaller({ ...inputs, packageJsonFile: 'packages/app/package.json' })
  assert.equal(globalThis.selectedSpec, '12.6.0')
  await bundled.exports.runSelfInstaller(inputs)
  assert.equal(globalThis.selectedSpec, '12.6.0')
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: [')
  await bundled.exports.runSelfInstaller({ ...inputs, version: '12.8.2', packageJsonFile: 'packages/app/package.json' })
  assert.equal(globalThis.selectedSpec, '12.8.2')
  rmSync(path.join(root, 'pnpm-workspace.yaml'))
  await bundled.exports.runSelfInstaller({ ...inputs, version: '12.8.2' })
  assert.equal(globalThis.selectedSpec, '12.8.2')
  // Exact manifest pins must not depend on a dependency lockfile being readable.
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), '---\nimporters: [\n')
  for (const manifest of [
    { packageManager: 'pnpm@12.8.1+sha512.example' },
    { devEngines: { packageManager: { name: 'pnpm', version: '12.8.1' } } },
  ]) {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest))
    // eslint-disable-next-line no-await-in-loop -- each manifest is written to the same file before it is read
    await bundled.exports.runSelfInstaller(inputs)
    assert.equal(globalThis.selectedSpec, '12.8.1')
  }
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devEngines: { packageManager: { name: 'pnpm', version: '>=12.0.0 <13.0.0' } } }))
  rmSync(path.join(root, 'pnpm-lock.yaml'))
  await bundled.exports.runSelfInstaller(inputs)
  assert.equal(globalThis.selectedSpec, '>=12.0.0 <13.0.0')
})

test('a member keeps its own pnpm declaration when the workspace root has none', async testContext => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'setup-installer-'))
  const previous = process.env.GITHUB_WORKSPACE
  testContext.after(() => {
    rmSync(root, { recursive: true, force: true })
    if (previous === undefined) delete process.env.GITHUB_WORKSPACE
    else process.env.GITHUB_WORKSPACE = previous
    delete globalThis.selectedSpec
    delete globalThis.versionArgs
  })
  process.env.GITHUB_WORKSPACE = root
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }))
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages: ['packages/*']\n")
  mkdirSync(path.join(root, 'packages/app'), { recursive: true })
  writeFileSync(path.join(root, 'packages/app/package.json'), JSON.stringify({ packageManager: 'pnpm@12.8.2' }))
  const inputs = { dest: path.join(root, 'tools'), packageJsonFile: 'packages/app/package.json' }
  await bundled.exports.runSelfInstaller(inputs)
  assert.equal(globalThis.selectedSpec, '12.8.2')

  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@12.8.1' }))
  await bundled.exports.runSelfInstaller(inputs)
  assert.equal(globalThis.selectedSpec, '12.8.1')
})

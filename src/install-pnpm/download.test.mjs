import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

// The real tool cache runs against a temporary RUNNER_TOOL_CACHE. get-pnpm is
// stubbed with one that writes a fake executable and records each download.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('./download.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{
    name: 'download-fixtures',
    setup (build) {
      build.onResolve({ filter: /^(get-pnpm|\.\/musl\.js|@actions\/core)$/ }, args =>
        args.path === '@actions/core' && !args.importer.endsWith('download.ts') ? undefined : { path: args.path, namespace: 'fixture' })
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents:
        args.path === '@actions/core' ? 'export const info = () => {}' :
          args.path === './musl.js' ? 'export const isMusl = () => globalThis.musl === true' : `
          import { mkdirSync, writeFileSync } from 'node:fs'
          import path from 'node:path'
          export async function downloadPnpm ({ versionSpec, dest }) {
            const version = /^\\d+\\.\\d+\\.\\d+$/.test(versionSpec) ? versionSpec : globalThis.resolvesTo
            globalThis.downloads.push(versionSpec)
            const binPath = path.join(dest, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm')
            writeFileSync(binPath, 'pnpm ' + version)
            mkdirSync(path.join(dest, 'dist'))
            writeFileSync(path.join(dest, 'dist', 'pnpm.cjs'), '')
            writeFileSync(path.join(dest, 'package.json'), '{}')
            return { version, binPath }
          }
        `,
      }))
    },
  }],
})
const bundled = { exports: {} }
new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(import.meta.url), bundled, bundled.exports)
const { installPnpm } = bundled.exports

const registry = 'https://registry.npmjs.org/'
const exe = name => process.platform === 'win32' ? `${name}.exe` : name
const aliases = ['pnpx', 'pn', 'pnx']

let root
let toolCache
let dest
const previousEnv = { RUNNER_TOOL_CACHE: process.env.RUNNER_TOOL_CACHE, RUNNER_TEMP: process.env.RUNNER_TEMP }

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'setup-download-'))
  toolCache = path.join(root, 'tool-cache')
  dest = path.join(root, 'dest')
  mkdirSync(path.join(root, 'temp'))
  process.env.RUNNER_TOOL_CACHE = toolCache
  process.env.RUNNER_TEMP = path.join(root, 'temp')
  globalThis.downloads = []
  globalThis.musl = false
  globalThis.resolvesTo = undefined
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  delete globalThis.downloads
  delete globalThis.musl
  delete globalThis.resolvesTo
})

/** Creates a complete tool cache entry the way `cacheDir` leaves one. */
function seedCacheEntry (version, arch = os.arch()) {
  const entry = path.join(toolCache, 'pnpm', version, arch)
  mkdirSync(entry, { recursive: true })
  writeFileSync(path.join(entry, exe('pnpm')), `cached pnpm ${version}`)
  writeFileSync(`${entry}.complete`, '')
  return entry
}

test('a miss downloads pnpm and adds it to the tool cache', async () => {
  const installed = await installPnpm('12.8.1', registry, dest)

  const entry = path.join(toolCache, 'pnpm', '12.8.1', os.arch())
  assert.deepEqual(installed, { version: '12.8.1', binPath: path.join(entry, exe('pnpm')) })
  assert.deepEqual(globalThis.downloads, ['12.8.1'])
  assert.ok(existsSync(`${entry}.complete`))
  assert.ok(existsSync(path.join(entry, 'dist', 'pnpm.cjs')))
  assert.ok(!existsSync(path.join(entry, 'package.json')))
  for (const alias of aliases) {
    assert.equal(readFileSync(path.join(entry, exe(alias)), 'utf8'), 'pnpm 12.8.1')
  }
  // The staging directory is removed, and nothing is written to dest.
  assert.deepEqual(readdirSync(process.env.RUNNER_TEMP), [])
  assert.ok(!existsSync(dest))
})

test('a hit uses the cached pnpm without downloading', async () => {
  await installPnpm('12.8.1', registry, dest)
  const installed = await installPnpm('12.8.1', registry, dest)

  assert.equal(installed.binPath, path.join(toolCache, 'pnpm', '12.8.1', os.arch(), exe('pnpm')))
  assert.deepEqual(globalThis.downloads, ['12.8.1'])
})

test('aliases are added to a cached entry, and existing ones are left alone', async () => {
  const entry = seedCacheEntry('12.8.1')
  writeFileSync(path.join(entry, exe('pnpx')), 'existing pnpx')

  await installPnpm('12.8.1', registry, dest)

  assert.deepEqual(globalThis.downloads, [])
  assert.equal(readFileSync(path.join(entry, exe('pnpx')), 'utf8'), 'existing pnpx')
  for (const alias of ['pn', 'pnx']) {
    assert.equal(readFileSync(path.join(entry, exe(alias)), 'utf8'), 'cached pnpm 12.8.1')
  }
})

test('musl hosts use the <arch>-musl tool cache entry', async () => {
  seedCacheEntry('12.8.1')
  globalThis.musl = true

  const installed = await installPnpm('12.8.1', registry, dest)

  assert.equal(installed.binPath, path.join(toolCache, 'pnpm', '12.8.1', `${os.arch()}-musl`, exe('pnpm')))
  assert.deepEqual(globalThis.downloads, ['12.8.1'])
})

test('a range is downloaded and cached under the version it resolved to', async () => {
  globalThis.resolvesTo = '12.8.2'

  const installed = await installPnpm('^12.0.0', registry, dest)

  assert.deepEqual(installed, { version: '12.8.2', binPath: path.join(toolCache, 'pnpm', '12.8.2', os.arch(), exe('pnpm')) })
  assert.deepEqual(globalThis.downloads, ['^12.0.0'])
})

test('a range that resolves to a cached version keeps the cached entry', async () => {
  const entry = seedCacheEntry('12.8.2')
  globalThis.resolvesTo = '12.8.2'

  const installed = await installPnpm('latest', registry, dest)

  assert.equal(installed.binPath, path.join(entry, exe('pnpm')))
  assert.equal(readFileSync(installed.binPath, 'utf8'), 'cached pnpm 12.8.2')
})

test('without RUNNER_TOOL_CACHE, pnpm is downloaded into dest', async () => {
  delete process.env.RUNNER_TOOL_CACHE

  const installed = await installPnpm('12.8.1', registry, dest)

  assert.deepEqual(installed, { version: '12.8.1', binPath: path.join(dest, exe('pnpm')) })
  assert.ok(!existsSync(path.join(dest, 'package.json')))
  for (const alias of aliases) {
    assert.ok(existsSync(path.join(dest, exe(alias))))
  }
  assert.ok(!existsSync(toolCache))
})

test('an exact version older than v11 is rejected before downloading', async () => {
  await assert.rejects(installPnpm('10.0.0', registry, dest), /only installs pnpm v11 or newer/)
  assert.deepEqual(globalThis.downloads, [])
})

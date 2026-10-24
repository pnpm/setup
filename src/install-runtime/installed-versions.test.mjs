import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', outputFiles[0].text)(
  createRequire(import.meta.url), bundledModule, bundledModule.exports
)
const { getInstalledRuntimeVersions } = bundledModule.exports

function fakePnpm (testContext, body) {
  const binDest = mkdtempSync(path.join(tmpdir(), 'pnpm-installed-versions-'))
  testContext.after(() => rmSync(binDest, { recursive: true, force: true }))
  const bin = path.join(binDest, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm')
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return binDest
}

// The runner reports through stdout too, so the capture has to pass every
// write along to it.
function captureStdout (testContext) {
  const written = []
  const original = process.stdout.write
  process.stdout.write = function (chunk, ...rest) {
    written.push(String(chunk))
    return original.call(this, chunk, ...rest)
  }
  testContext.after(() => {
    process.stdout.write = original
  })
  return written
}

test('reports the signal when the listing is terminated', { skip: process.platform === 'win32' }, async testContext => {
  const binDest = fakePnpm(testContext, 'kill -TERM $$\nsleep 5')
  const logged = captureStdout(testContext)

  const versions = await getInstalledRuntimeVersions(['node'], binDest)

  assert.deepEqual([...versions], [])
  assert.match(logged.join(''), /::warning::Unable to determine the installed runtime versions: pnpm .*list --global --json --depth 0 exited with SIGTERM/)
})

test('reports the exit code when the listing fails', { skip: process.platform === 'win32' }, async testContext => {
  const binDest = fakePnpm(testContext, 'exit 3')
  const logged = captureStdout(testContext)

  const versions = await getInstalledRuntimeVersions(['node'], binDest)

  assert.deepEqual([...versions], [])
  assert.match(logged.join(''), /exited with code 3/)
})

test('reads the version out of a successful listing', { skip: process.platform === 'win32' }, async testContext => {
  const listing = JSON.stringify([{ dependencies: { node: { version: '24.9.0' } } }])
  const binDest = fakePnpm(testContext, `cat <<'JSON'\n${listing}\nJSON`)
  captureStdout(testContext)

  const versions = await getInstalledRuntimeVersions(['node'], binDest)

  assert.deepEqual([...versions], [['node', '24.9.0']])
})

for (const [label, preamble] of [
  ['a warning', '[WARN] Using --global skips the package manager check for this project'],
  ['progress output', 'Installing pnpm@12.8.1...'],
]) {
  test(`reads the listing when ${label} is printed ahead of it`, { skip: process.platform === 'win32' }, async testContext => {
    const listing = JSON.stringify([{ dependencies: { node: { version: '24.9.0' } } }], null, 2)
    const binDest = fakePnpm(testContext, `cat <<'JSON'\n${preamble}\n${listing}\nJSON`)
    captureStdout(testContext)

    const versions = await getInstalledRuntimeVersions(['node'], binDest)

    assert.deepEqual([...versions], [['node', '24.9.0']])
  })
}

test('keeps pnpm from switching versions or printing warnings while listing', { skip: process.platform === 'win32' }, async testContext => {
  const listing = JSON.stringify([{ dependencies: { node: { version: '24.9.0' } } }])
  const binDest = fakePnpm(testContext, `case "$*" in *--config.pm-on-fail=ignore*--reporter=silent*) cat <<'JSON'\n${listing}\nJSON\n;; *) exit 9;; esac`)
  captureStdout(testContext)

  const versions = await getInstalledRuntimeVersions(['node'], binDest)

  assert.deepEqual([...versions], [['node', '24.9.0']])
})

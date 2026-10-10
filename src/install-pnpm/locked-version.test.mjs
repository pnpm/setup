import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { afterEach, test } from 'node:test'
import { readLockedPnpmVersion } from './locked-version.ts'

const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture(specifier = '>=12.0.0 <13.0.0', version = '12.8.1') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-locked-pnpm-'))
  directories.push(directory)
  fs.writeFileSync(path.join(directory, 'pnpm-lock.yaml'), `---
lockfileVersion: '9.0'
importers:
  .:
    packageManagerDependencies:
      pnpm:
        specifier: '${specifier}'
        version: ${version}
---
lockfileVersion: '9.0'
importers:
  .: {}
`)
  return directory
}

test('uses the locked version for a matching range, without resolving latest', () => {
  assert.equal(readLockedPnpmVersion(fixture(), '>=12.0.0 <13.0.0'), '12.8.1')
})

test('reuses a satisfying locked version after the manifest range changes', () => {
  assert.equal(readLockedPnpmVersion(fixture('12'), '>=12.0.0 <13.0.0'), '12.8.1')
  assert.equal(readLockedPnpmVersion(fixture('12.8.1'), '^12.0.0'), '12.8.1')
})

test('reuses a locked prerelease with pnpm package-manager range semantics', () => {
  assert.equal(readLockedPnpmVersion(fixture('12', '12.0.0-alpha.18'), '12'), '12.0.0-alpha.18')
  assert.equal(readLockedPnpmVersion(fixture('12', '12.0.0-alpha.18'), '>=12.0.0'), undefined)
  assert.equal(readLockedPnpmVersion(fixture('13', '13.0.0-alpha.1'), '12'), undefined)
})

test('does not reuse a version outside the requested range', () => {
  assert.equal(readLockedPnpmVersion(fixture('>=12.0.0 <13.0.0', '11.28.1'), '>=12.0.0 <13.0.0'), undefined)
})

test('does not interpret a dist-tag as a semver range', () => {
  assert.equal(readLockedPnpmVersion(fixture('latest'), 'latest'), undefined)
})

test('falls back when no lockfile or package-manager document exists', () => {
  const directory = fixture()
  fs.unlinkSync(path.join(directory, 'pnpm-lock.yaml'))
  assert.equal(readLockedPnpmVersion(directory, '12'), undefined)
  fs.writeFileSync(path.join(directory, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n")
  assert.equal(readLockedPnpmVersion(directory, '12'), undefined)
})

test('rejects a malformed package-manager document rather than silently selecting latest', () => {
  const directory = fixture()
  fs.writeFileSync(path.join(directory, 'pnpm-lock.yaml'), "---\nimporters: [\n---\nlockfileVersion: '9.0'\n")
  assert.throws(() => readLockedPnpmVersion(directory, '12'))
})

test('reads only the leading document, as pnpm does', () => {
  const directory = fixture()
  const lockfile = path.join(directory, 'pnpm-lock.yaml')
  // The dependency document is never parsed, so it cannot fail the lookup.
  fs.appendFileSync(lockfile, 'packages: [\n')
  assert.equal(readLockedPnpmVersion(directory, '12'), '12.8.1')
  fs.writeFileSync(lockfile, `\uFEFF${fs.readFileSync(lockfile, 'utf8').replace(/\n/g, '\r\n')}`)
  assert.equal(readLockedPnpmVersion(directory, '12'), '12.8.1')
  // Without the leading separator there is no package-manager document.
  fs.writeFileSync(lockfile, fs.readFileSync(lockfile, 'utf8').replace(/^\uFEFF---\r\n/, ''))
  assert.equal(readLockedPnpmVersion(directory, '12'), undefined)
})

test('reads a lockfile that holds only the package-manager document', () => {
  const directory = fixture()
  const lockfile = path.join(directory, 'pnpm-lock.yaml')
  fs.writeFileSync(lockfile, fs.readFileSync(lockfile, 'utf8').replace(/\n---\n[\s\S]*$/, '\n'))
  assert.equal(readLockedPnpmVersion(directory, '12'), '12.8.1')
})

test('recognizes separators at every position across a read boundary', () => {
  const directory = fixture()
  const lockfile = path.join(directory, 'pnpm-lock.yaml')
  const env = fs.readFileSync(lockfile, 'utf8').split('\n---\n')[0]
  for (const newline of ['\n', '\r\n']) {
    for (const bom of ['', '\uFEFF']) {
      const prefix = bom + env.replace(/\n/g, newline) + newline + '# '
      for (let offset = -7; offset <= 1; offset++) {
        const padding = 64 * 1024 + offset - Buffer.byteLength(prefix)
        fs.writeFileSync(lockfile, prefix + 'x'.repeat(padding) + newline + '---' + newline + 'packages: [')
        assert.equal(readLockedPnpmVersion(directory, '12'), '12.8.1', `${JSON.stringify({ newline, bom, offset })}`)
      }
    }
  }
})

test('preserves UTF-8 split across reads and env-only closing separators', () => {
  const directory = fixture()
  const lockfile = path.join(directory, 'pnpm-lock.yaml')
  const env = fs.readFileSync(lockfile, 'utf8').split('\n---\n')[0]
  for (const ending of ['', '\n', '\n---', '\n---\n']) {
    const prefix = '---\n# '
    fs.writeFileSync(lockfile, prefix + 'x'.repeat(65535 - prefix.length) + 'é🦀\n' + env.slice(4) + ending)
    assert.equal(readLockedPnpmVersion(directory, '12'), '12.8.1')
  }
  const prefix = '---\n# '
  const anchor = '\npin: &'
  fs.writeFileSync(lockfile, prefix + 'x'.repeat(65535 - prefix.length - anchor.length) +
    anchor + 'é 12.8.1\n' + env.slice(4).replace('version: 12.8.1', 'version: *é') + '\n---\n')
  assert.equal(readLockedPnpmVersion(directory, '12'), '12.8.1')
  fs.writeFileSync(lockfile, env + '\n# ' + 'x'.repeat(65536) + '\ninvalid: [')
  assert.throws(() => readLockedPnpmVersion(directory, '12'))
})

test('handles short reads without changing document-start or boundary semantics', t => {
  const originalRead = fs.readSync
  let limit = 1
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) =>
    originalRead(fd, buffer, offset, Math.min(length, limit), position))
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const directory = fixture()
  const lockfile = path.join(directory, 'pnpm-lock.yaml')
  const valid = fs.readFileSync(lockfile, 'utf8')
  for (limit = 1; limit <= 8; limit++) {
    for (const content of [valid, '\uFEFF' + valid.replace(/\n/g, '\r\n')]) {
      fs.writeFileSync(lockfile, content)
      assert.equal(readLockedPnpmVersion(directory, '12'), '12.8.1')
    }
    for (const content of ['', '---', '\uFEFF\uFEFF' + valid, '--- # comment\n' + valid, '---\n---\n']) {
      fs.writeFileSync(lockfile, content)
      assert.equal(readLockedPnpmVersion(directory, '12'), undefined)
    }
  }
})

test('bounds reads for dependency documents and closes the file after read errors', t => {
  const originalRead = fs.readSync, originalClose = fs.closeSync
  let bytes = 0, closed = 0, failure
  t.mock.method(fs, 'readSync', (...args) => {
    if (failure) throw failure
    const count = originalRead(...args)
    bytes += count
    return count
  })
  t.mock.method(fs, 'closeSync', fd => { closed++; return originalClose(fd) })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const directory = fixture()
  const lockfile = path.join(directory, 'pnpm-lock.yaml')
  fs.appendFileSync(lockfile, '# ' + 'x'.repeat(1024 * 1024))
  closed = 0
  assert.equal(readLockedPnpmVersion(directory, '12'), '12.8.1')
  assert.equal(bytes, 64 * 1024)
  assert.equal(closed, 1)
  fs.writeFileSync(lockfile, '# ' + 'x'.repeat(1024 * 1024))
  bytes = 0
  closed = 0
  assert.equal(readLockedPnpmVersion(directory, '12'), undefined)
  assert.equal(bytes, 64 * 1024)
  assert.equal(closed, 1)
  failure = Object.assign(new Error('read failed'), { code: 'EIO' })
  assert.throws(() => readLockedPnpmVersion(directory, '12'), error => error === failure)
  assert.equal(closed, 2)
})

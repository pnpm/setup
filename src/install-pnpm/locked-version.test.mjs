import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

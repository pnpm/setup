import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { getPnpmVersionFromFile, parsePnpmVersionFile } from '../src/version-file'

test('reads pnpm from .tool-versions', () => {
  const contents = `nodejs 24.6.0
pnpm 12.0.0-rc.2
python 3.13.5
`

  assert.equal(parsePnpmVersionFile(contents, '.tool-versions'), '12.0.0-rc.2')
})

test('uses the first version from a .tool-versions pnpm entry', () => {
  assert.equal(parsePnpmVersionFile('pnpm 12.0.0 11.17.0\n', '.tool-versions'), '12.0.0')
})

test('reads the complete trimmed contents of a plain version file', () => {
  assert.equal(parsePnpmVersionFile('  >=11 <13\n', '.pnpm-version'), '>=11 <13')
  assert.equal(parsePnpmVersionFile('next-12\n', '.pnpm-version'), 'next-12')
})

test('returns undefined when no pnpm version is present', () => {
  assert.equal(parsePnpmVersionFile('nodejs 24.6.0\n', '.tool-versions'), undefined)
  assert.equal(parsePnpmVersionFile('  \n', '.pnpm-version'), undefined)
})

test('reports a missing version file', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pnpm-missing-version-file-'))
  const missing = path.join(directory, '.tool-versions')
  try {
    assert.throws(
      () => getPnpmVersionFromFile(missing),
      new Error(`The specified pnpm version file at: ${missing} does not exist`),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reports a .tool-versions file without pnpm', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pnpm-version-file-'))
  const versionFile = path.join(directory, '.tool-versions')
  try {
    writeFileSync(versionFile, 'nodejs 24.6.0\n')
    assert.throws(
      () => getPnpmVersionFromFile(versionFile),
      new Error(`Could not determine a pnpm version from ${versionFile}. Ensure it contains an entry such as \`pnpm 12\`.`),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

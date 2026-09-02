import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parseNodeVersionFile, readNodeVersionFile } from './node-version-file.ts'

test('plain version files accept comments and normalize common nvm selectors', () => {
  assert.equal(parseNodeVersionFile('\uFEFF  v24.19.0 # current release\r\n', '.nvmrc'), '24.19.0')
  assert.equal(parseNodeVersionFile('node\n', '.nvmrc'), 'latest')
  assert.equal(parseNodeVersionFile('lts/*\n', '.nvmrc'), 'lts')
  assert.equal(parseNodeVersionFile('lts/jod\n', '.nvmrc'), 'jod')
  assert.equal(parseNodeVersionFile('>=22 <25\n', '.node-version'), '>=22 <25')
})

test('.tool-versions reads node or nodejs and uses the first declared version', () => {
  assert.equal(
    parseNodeVersionFile('ruby 3.4.5\nnodejs 24.19.0 22.22.0 system\n', '.tool-versions'),
    '24.19.0',
  )
  assert.equal(parseNodeVersionFile('node 22.22.0 # project runtime\n', '.tool-versions'), '22.22.0')
})

test('invalid or unsupported version files fail clearly', () => {
  assert.throws(
    () => parseNodeVersionFile('ruby 3.4.5\n', '.tool-versions'),
    /does not declare a Node\.js version/,
  )
  assert.throws(
    () => parseNodeVersionFile('22.22.0\n24.19.0\n', '.node-version'),
    /must contain exactly one/,
  )
  assert.throws(
    () => parseNodeVersionFile('system\n', '.node-version'),
    /pnpm cannot install/,
  )
  assert.throws(
    () => parseNodeVersionFile('lts/\n', '.nvmrc'),
    /invalid Node\.js version selector/,
  )
})

test('node-version-file resolves relative to working-directory', t => {
  const workspace = createWorkspace(t)
  mkdirSync(path.join(workspace, 'web'))
  writeFileSync(path.join(workspace, 'web', '.node-version'), '24.19.0\n')

  assert.equal(readNodeVersionFile(inputs({ workingDirectory: 'web', nodeVersionFile: '.node-version' })), '24.19.0')
})

test('a missing node-version-file fails with its resolved path', t => {
  const workspace = createWorkspace(t)
  const expectedPath = path.join(workspace, 'web', '.node-version')

  assert.throws(
    () => readNodeVersionFile(inputs({ workingDirectory: 'web', nodeVersionFile: '.node-version' })),
    error => {
      assert.equal(error.message, `The specified Node version file does not exist: ${expectedPath}`)
      return true
    },
  )
})

function createWorkspace(t) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'pnpm-setup-node-version-'))
  const previousWorkspace = process.env.GITHUB_WORKSPACE
  process.env.GITHUB_WORKSPACE = workspace
  t.after(() => {
    if (previousWorkspace === undefined) {
      delete process.env.GITHUB_WORKSPACE
    } else {
      process.env.GITHUB_WORKSPACE = previousWorkspace
    }
    rmSync(workspace, { recursive: true, force: true })
  })
  return workspace
}

function inputs(overrides = {}) {
  return {
    dest: 'setup-pnpm',
    cache: false,
    cacheDependencyPath: 'pnpm-lock.yaml',
    workingDirectory: '.',
    packageJsonFile: 'package.json',
    install: false,
    requireLockfile: false,
    ...overrides,
  }
}

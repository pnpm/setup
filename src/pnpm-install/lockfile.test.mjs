import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { findLockfile } from './lockfile.ts'

/**
 * A workspace whose `packages` leave `docs` out, installed from the root: the
 * lockfile sits at the root and nowhere else.
 */
function prepareWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-')))
  fs.mkdirSync(path.join(root, 'packages/pkg-1'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '')
  return root
}

test('a project the workspace contains finds the lockfile above it', () => {
  const root = prepareWorkspace()
  const member = path.join(root, 'packages/pkg-1')

  assert.equal(findLockfile(member, root, root), path.join(root, 'pnpm-lock.yaml'))
})

test('a project the workspace leaves out does not borrow the lockfile above it', () => {
  const root = prepareWorkspace()
  const standalone = path.join(root, 'docs')

  // `searchRoot` is the directory itself, which is what `pnpm root -w` failing
  // reports: pnpm installs this project on its own, so the root's lockfile
  // does not describe the install (pnpm/pnpm#3561).
  assert.equal(findLockfile(standalone, standalone, root), undefined)
})

test('a project the workspace leaves out finds a lockfile of its own', () => {
  const root = prepareWorkspace()
  const standalone = path.join(root, 'docs')
  fs.writeFileSync(path.join(standalone, 'pnpm-lock.yaml'), '')

  assert.equal(
    findLockfile(standalone, standalone, root),
    path.join(standalone, 'pnpm-lock.yaml'),
  )
})

test('the climb stops at the checkout even when pnpm reports a root above it', () => {
  const root = prepareWorkspace()
  const checkout = path.join(root, 'packages')
  const member = path.join(checkout, 'pkg-1')

  assert.equal(findLockfile(member, root, checkout), undefined)
})

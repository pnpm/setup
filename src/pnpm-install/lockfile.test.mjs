import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  chooseLockfileDir,
  findWorkspaceRoot,
  keepsLockfilePerProject,
  lockfileDir,
} from './lockfile.ts'

function prepareWorkspace({ packages = "['packages/**']", settings = '' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-')))
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), `packages: ${packages}\n${settings}`)
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"root","version":"0.0.0"}')
  for (const project of ['packages/pkg-1', 'standalone']) {
    fs.mkdirSync(path.join(root, project), { recursive: true })
    fs.writeFileSync(
      path.join(root, project, 'package.json'),
      `{"name":"${path.basename(project)}","version":"0.0.0"}`,
    )
  }
  return root
}

test('a project the workspace contains reads the root lockfile, not one beside itself', () => {
  const root = prepareWorkspace()
  const member = path.join(root, 'packages/pkg-1')

  assert.equal(chooseLockfileDir(member, root, false), root)
})

test('a workspace keeping a lockfile per project reads its own', () => {
  const root = prepareWorkspace()
  const member = path.join(root, 'packages/pkg-1')

  assert.equal(chooseLockfileDir(member, root, true), member)
})

test('a project no workspace contains reads its own lockfile', () => {
  const root = prepareWorkspace()
  const standalone = path.join(root, 'standalone')

  assert.equal(chooseLockfileDir(standalone, undefined, false), standalone)
})

test('pnpm reports the workspace root from a project it contains', () => {
  const root = prepareWorkspace()

  assert.equal(findWorkspaceRoot(path.join(root, 'packages/pkg-1')), root)
})

test('pnpm reports no workspace from a directory outside one', () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-')))
  fs.writeFileSync(path.join(outside, 'package.json'), '{"name":"alone","version":"0.0.0"}')

  assert.equal(findWorkspaceRoot(outside), undefined)
})

test('the lockfile directory follows sharedWorkspaceLockfile', () => {
  const shared = prepareWorkspace()
  const perProject = prepareWorkspace({ settings: 'sharedWorkspaceLockfile: false\n' })

  assert.equal(keepsLockfilePerProject(path.join(shared, 'packages/pkg-1')), false)
  assert.equal(lockfileDir(path.join(shared, 'packages/pkg-1')), shared)

  assert.equal(keepsLockfilePerProject(path.join(perProject, 'packages/pkg-1')), true)
  assert.equal(
    lockfileDir(path.join(perProject, 'packages/pkg-1')),
    path.join(perProject, 'packages/pkg-1'),
  )
})

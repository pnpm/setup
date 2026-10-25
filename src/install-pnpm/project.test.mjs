import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import { packageManagerLockfileDirectory, packageManagerManifest } from './project.ts'

const fixtures = []
afterEach(() => {
  for (const directory of fixtures.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function workspace (settings = "packages: ['packages/*', '!packages/excluded/**']\n") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-project-')))
  fixtures.push(root)
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), settings)
  const manifest = project(root, '.')
  return { root, manifest }
}

function project (root, relative) {
  const directory = path.join(root, relative)
  fs.mkdirSync(directory, { recursive: true })
  const manifest = path.join(directory, 'package.json')
  fs.writeFileSync(manifest, '{}')
  return manifest
}

test('workspace members use the root package-manager manifest', () => {
  const { root, manifest } = workspace()
  const member = project(root, 'packages/app')
  assert.equal(packageManagerManifest(member, root), manifest)
  assert.equal(packageManagerManifest(manifest, root), manifest)
})

test('excluded and unrelated projects keep their own manifest', () => {
  const { root } = workspace()
  for (const directory of ['packages/excluded', 'packages/excluded/nested', 'standalone', 'packages/.hidden']) {
    const manifest = project(root, directory)
    assert.equal(packageManagerManifest(manifest, root), manifest)
  }
})

test('patterns support braces, a leading dot slash, and a trailing slash', () => {
  const { root, manifest } = workspace("packages: ['./{packages,apps}/*/']\n")
  for (const directory of ['packages/app', 'apps/web']) {
    assert.equal(packageManagerManifest(project(root, directory), root), manifest)
  }
})

test('absent patterns include projects but an empty list includes only the root', () => {
  for (const [settings, included] of [['{}\n', true], ['packages: []\n', false]]) {
    const { root, manifest } = workspace(settings)
    const child = project(root, 'app')
    assert.equal(packageManagerManifest(child, root), included ? manifest : child)
    const ignored = project(root, 'node_modules/app')
    assert.equal(packageManagerManifest(ignored, root), ignored)
  }
})

test('does not cross the checkout boundary or borrow an unmarked parent manifest', () => {
  const { root } = workspace()
  const manifest = project(root, 'packages/app')
  const checkout = path.dirname(manifest)
  assert.equal(packageManagerManifest(manifest, checkout), manifest)
  fs.unlinkSync(path.join(root, 'pnpm-workspace.yaml'))
  assert.equal(packageManagerManifest(manifest, root), manifest)
})

test('the nearest workspace stops lookup even when its project is excluded', () => {
  const { root } = workspace("packages: ['**']\n")
  const nested = path.join(root, 'nested')
  project(root, 'nested')
  fs.writeFileSync(path.join(nested, 'pnpm-workspace.yaml'), "packages: ['included/*']\n")
  const child = project(nested, 'excluded/app')
  assert.equal(packageManagerManifest(child, root), child)
})

test('supports a root package.yaml and never borrows a root without a manifest', () => {
  const { root, manifest } = workspace()
  const child = project(root, 'packages/app')
  fs.unlinkSync(manifest)
  assert.equal(packageManagerManifest(child, root), child)
  const yaml = path.join(root, 'package.yaml')
  fs.writeFileSync(yaml, '{}')
  assert.equal(packageManagerManifest(child, root), yaml)
})

test('missing project directories retain the existing selection behavior', () => {
  const { root } = workspace()
  const manifest = path.join(root, 'missing/package.json')
  assert.equal(packageManagerManifest(manifest, root), manifest)
})

test('a matching directory without a project manifest is not a workspace member', () => {
  const { root } = workspace()
  const manifest = project(root, 'packages/missing')
  fs.unlinkSync(manifest)
  assert.equal(packageManagerManifest(manifest, root), manifest)
})

test('a symlink outside the checkout cannot borrow an external workspace pin', () => {
  const { root } = workspace()
  const external = workspace()
  const child = project(external.root, 'packages/app')
  const link = path.join(root, 'linked')
  fs.symlinkSync(path.dirname(child), link, process.platform === 'win32' ? 'junction' : 'dir')
  const manifest = path.join(link, 'package.json')
  assert.equal(packageManagerManifest(manifest, root), manifest)
})

test('invalid workspace patterns fail with a clear error', () => {
  const { root } = workspace('packages: [42]\n')
  const child = project(root, 'packages/app')
  assert.throws(() => packageManagerManifest(child, root), /Invalid packages patterns/)
})

test('the lockfile directory follows the workspace lockfile settings', () => {
  const { root, manifest } = workspace("packages: ['packages/*']\n")
  const member = project(root, 'packages/app')
  assert.equal(packageManagerLockfileDirectory(member, manifest), root)
  assert.equal(packageManagerLockfileDirectory(manifest, manifest), root)

  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages: ['packages/*']\nsharedWorkspaceLockfile: false\n")
  assert.equal(packageManagerLockfileDirectory(member, manifest), path.dirname(member))
})

test('an explicit lockfileDir is resolved against the workspace root', () => {
  const { root, manifest } = workspace("packages: ['packages/*']\nlockfileDir: locks\n")
  const member = project(root, 'packages/app')
  assert.equal(packageManagerLockfileDirectory(member, manifest), path.join(root, 'locks'))
  assert.equal(packageManagerLockfileDirectory(manifest, manifest), path.join(root, 'locks'))

  // It wins over a lockfile per project, as in pnpm.
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages: ['packages/*']\nsharedWorkspaceLockfile: false\nlockfileDir: ../locks\n")
  assert.equal(packageManagerLockfileDirectory(member, manifest), path.join(path.dirname(root), 'locks'))
})

test('a project without pnpm-workspace.yaml reads its own lockfile', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-project-')))
  fixtures.push(root)
  const manifest = project(root, '.')
  assert.equal(packageManagerLockfileDirectory(manifest, manifest), root)
})

test('a lockfileDir delegated to an included file is measured from that file', () => {
  const { root, manifest } = workspace("packages: ['packages/*']\ninclude:\n  ./cfg/locks.yaml:\n    - lockfileDir\n")
  const member = project(root, 'packages/app')
  fs.mkdirSync(path.join(root, 'cfg'))
  fs.writeFileSync(path.join(root, 'cfg/locks.yaml'), 'lockfileDir: locks\n')
  assert.equal(packageManagerLockfileDirectory(member, manifest), path.join(root, 'cfg/locks'))
  assert.equal(packageManagerLockfileDirectory(manifest, manifest), path.join(root, 'cfg/locks'))

  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages: ['packages/*']\ninclude:\n  ./cfg/locks.yaml: '*'\n")
  assert.equal(packageManagerLockfileDirectory(member, manifest), path.join(root, 'cfg/locks'))
})

test('only settings an include delegates are read from the included file', () => {
  const { root, manifest } = workspace("packages: ['packages/*']\ninclude:\n  ./cfg/policies.yaml:\n    - minimumReleaseAge\n")
  const member = project(root, 'packages/app')
  fs.mkdirSync(path.join(root, 'cfg'))
  fs.writeFileSync(path.join(root, 'cfg/policies.yaml'), 'lockfileDir: locks\nsharedWorkspaceLockfile: false\n')
  assert.equal(packageManagerLockfileDirectory(member, manifest), root)

  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages: ['packages/*']\ninclude:\n  ./cfg/policies.yaml:\n    - sharedWorkspaceLockfile\n")
  assert.equal(packageManagerLockfileDirectory(member, manifest), path.dirname(member))
})

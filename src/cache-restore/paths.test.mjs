import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveCacheDependencyPath } from './paths.ts'

test('the repository root is left exactly as configured', () => {
  assert.equal(resolveCacheDependencyPath('pnpm-lock.yaml', '.'), 'pnpm-lock.yaml')
})

test('a project one level down looks for its own lockfile', () => {
  assert.equal(resolveCacheDependencyPath('pnpm-lock.yaml', 'docs'), 'docs/pnpm-lock.yaml')
})

test('every pattern in a multi-line value is rebased', () => {
  assert.equal(
    resolveCacheDependencyPath('pnpm-lock.yaml\npackages/*/pnpm-lock.yaml', 'docs'),
    'docs/pnpm-lock.yaml\ndocs/packages/*/pnpm-lock.yaml',
  )
})

test('exclusions keep excluding', () => {
  assert.equal(
    resolveCacheDependencyPath('**/pnpm-lock.yaml\n!**/fixtures/**', 'docs'),
    'docs/**/pnpm-lock.yaml\n!docs/**/fixtures/**',
  )
})

test('absolute patterns are left alone', () => {
  const absolute = process.platform === 'win32' ? 'C:\\tmp\\pnpm-lock.yaml' : '/tmp/pnpm-lock.yaml'
  assert.equal(resolveCacheDependencyPath(absolute, 'docs'), absolute)
})

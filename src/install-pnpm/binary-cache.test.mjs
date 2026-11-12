import assert from 'node:assert/strict'
import { test } from 'node:test'

import { binaryCacheKey } from './binary-cache.ts'

test('an exact version is cached per platform and tool cache architecture', () => {
  assert.equal(binaryCacheKey('12.16.1', 'x64', 'linux'), 'pnpm-binary-linux-x64-12.16.1')
  assert.equal(binaryCacheKey('12.16.1', 'x64-musl', 'linux'), 'pnpm-binary-linux-x64-musl-12.16.1')
  assert.equal(binaryCacheKey('12.16.1', 'arm64', 'win32'), 'pnpm-binary-win32-arm64-12.16.1')
  assert.equal(binaryCacheKey('v12.16.1', 'x64', 'linux'), 'pnpm-binary-linux-x64-12.16.1')
})

test('a range or dist-tag is not cached, since it names no executable yet', () => {
  assert.equal(binaryCacheKey('^12.0.0', 'x64', 'linux'), undefined)
  assert.equal(binaryCacheKey('next-12', 'x64', 'linux'), undefined)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { binaryCacheKey } from './binary-cache.ts'

test('an exact version is cached per platform, architecture and libc', () => {
  assert.equal(binaryCacheKey('12.16.1', 'linux', 'x64', false), 'pnpm-binary-linux-x64-12.16.1')
  assert.equal(binaryCacheKey('12.16.1', 'linux', 'x64', true), 'pnpm-binary-linux-x64-musl-12.16.1')
  assert.equal(binaryCacheKey('12.16.1', 'win32', 'arm64', false), 'pnpm-binary-win32-arm64-12.16.1')
})

test('a range or dist-tag is not cached, since it names no executable yet', () => {
  assert.equal(binaryCacheKey('^12.0.0', 'linux', 'x64', false), undefined)
  assert.equal(binaryCacheKey('next-12', 'linux', 'x64', false), undefined)
})

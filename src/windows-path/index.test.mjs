import assert from 'node:assert/strict'
import test from 'node:test'

import { removeWindowsExtendedPathPrefix } from './index.ts'

test('strips the extended-length prefix from a drive path', () => {
  assert.equal(removeWindowsExtendedPathPrefix('\\\\?\\D:\\.pnpm-store\\v11'), 'D:\\.pnpm-store\\v11')
})

test('converts an extended-length UNC path back to a regular UNC path', () => {
  assert.equal(removeWindowsExtendedPathPrefix('\\\\?\\UNC\\server\\share\\.pnpm-store'), '\\\\server\\share\\.pnpm-store')
  assert.equal(removeWindowsExtendedPathPrefix('\\\\?\\unc\\server\\share'), '\\\\server\\share')
})

test('leaves paths without the prefix unchanged', () => {
  assert.equal(removeWindowsExtendedPathPrefix('D:\\.pnpm-store\\v11'), 'D:\\.pnpm-store\\v11')
  assert.equal(removeWindowsExtendedPathPrefix('\\\\server\\share'), '\\\\server\\share')
  assert.equal(removeWindowsExtendedPathPrefix('/home/runner/.pnpm-store'), '/home/runner/.pnpm-store')
})

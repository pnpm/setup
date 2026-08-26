import assert from 'node:assert/strict'
import test from 'node:test'
import { getCacheKeyPrefix, getPrimaryCacheKey } from './keys.ts'

test('moving runtime selectors use the resolved version in the primary key', () => {
  const prefix = getCacheKeyPrefix('Linux', 'x64', { name: 'node', version: 'lts' })
  const previousKey = getPrimaryCacheKey(prefix, 'lockfile-hash', '22.22.0')
  const currentKey = getPrimaryCacheKey(prefix, 'lockfile-hash', '24.13.0')

  assert.notEqual(previousKey, currentKey)
  assert.ok(previousKey.startsWith(prefix))
  assert.ok(currentKey.startsWith(prefix))
})

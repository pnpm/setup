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

test('the provisional restore key is never a key a runtime run saves under', () => {
  const prefix = getCacheKeyPrefix('Linux', 'x64', { name: 'node', version: '24.19.0' })
  const provisional = getPrimaryCacheKey(prefix, 'lockfile-hash')
  const final = getPrimaryCacheKey(prefix, 'lockfile-hash', '24.19.0')

  // An exact hit on the provisional key would stop the restore falling back
  // to the prefix search that finds the versioned caches.
  assert.notEqual(provisional, final)
})

test('without a runtime the provisional key is the final key', () => {
  const prefix = getCacheKeyPrefix('Linux', 'x64', undefined)

  assert.equal(
    getPrimaryCacheKey(prefix, 'lockfile-hash'),
    getPrimaryCacheKey(prefix, 'lockfile-hash', undefined),
  )
})

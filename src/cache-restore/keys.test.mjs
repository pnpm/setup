import assert from 'node:assert/strict'
import test from 'node:test'
import { getCacheKeyPrefix, getSaveCacheKey } from './keys.ts'

test('moving runtime selectors produce distinct key prefixes', () => {
  const previous = getCacheKeyPrefix('Linux', 'x64', [{ name: 'node', version: 'lts' }])
  const current = getCacheKeyPrefix('Linux', 'x64', [{ name: 'node', version: 'next' }])

  assert.notEqual(previous, current)
})

test('save keys for the same run and lockfile differ by resolved runtime version', () => {
  const prefix = getCacheKeyPrefix('Linux', 'x64', [{ name: 'node', version: 'lts' }])
  const lockfileKeyPrefix = `${prefix}lockfile-hash-`

  const previousVersionKey = getSaveCacheKey(lockfileKeyPrefix, [{ name: 'node', version: '22.22.0' }], '123')
  const currentVersionKey = getSaveCacheKey(lockfileKeyPrefix, [{ name: 'node', version: '24.13.0' }], '123')

  assert.notEqual(previousVersionKey, currentVersionKey)
  assert.ok(previousVersionKey.startsWith(lockfileKeyPrefix))
  assert.ok(currentVersionKey.startsWith(lockfileKeyPrefix))
})

test('save keys for the same run and version differ by run id, so no save is ever restored within its own run', () => {
  const prefix = getCacheKeyPrefix('Linux', 'x64', [{ name: 'node', version: '24.19.0' }])
  const lockfileKeyPrefix = `${prefix}lockfile-hash-`

  const firstRun = getSaveCacheKey(lockfileKeyPrefix, [{ name: 'node', version: '24.19.0' }], '111')
  const secondRun = getSaveCacheKey(lockfileKeyPrefix, [{ name: 'node', version: '24.19.0' }], '222')

  assert.notEqual(firstRun, secondRun)
})

test('without a resolved runtime the save key is just the lockfile prefix and run id', () => {
  const prefix = getCacheKeyPrefix('Linux', 'x64', [])
  const lockfileKeyPrefix = `${prefix}lockfile-hash-`

  assert.equal(getSaveCacheKey(lockfileKeyPrefix, [], '123'), `${lockfileKeyPrefix}123`)
})

test('every requested runtime contributes to the key prefix', () => {
  const single = getCacheKeyPrefix('Linux', 'x64', [{ name: 'node', version: '24' }])
  const both = getCacheKeyPrefix('Linux', 'x64', [
    { name: 'node', version: '24' },
    { name: 'bun', version: '1.3.13' },
  ])

  assert.notEqual(single, both)
})

test('declaration order does not change the key prefix', () => {
  const nodeFirst = getCacheKeyPrefix('Linux', 'x64', [
    { name: 'node', version: '24' },
    { name: 'bun', version: '1.3.13' },
  ])
  const bunFirst = getCacheKeyPrefix('Linux', 'x64', [
    { name: 'bun', version: '1.3.13' },
    { name: 'node', version: '24' },
  ])

  // The same set of runtimes produces the same store, so it should share a cache.
  assert.equal(nodeFirst, bunFirst)
})

test('a version change in any runtime changes the save key', () => {
  const prefix = getCacheKeyPrefix('Linux', 'x64', [
    { name: 'node', version: 'lts' },
    { name: 'bun', version: 'latest' },
  ])
  const lockfileKeyPrefix = `${prefix}lockfile-hash-`

  const before = getSaveCacheKey(
    lockfileKeyPrefix,
    [
      { name: 'node', version: '24.19.0' },
      { name: 'bun', version: '1.3.13' },
    ],
    '123',
  )
  const after = getSaveCacheKey(
    lockfileKeyPrefix,
    [
      { name: 'node', version: '24.19.0' },
      { name: 'bun', version: '1.3.14' },
    ],
    '123',
  )

  assert.notEqual(before, after)
})

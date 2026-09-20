import assert from 'node:assert/strict'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { beforeEach, test } from 'node:test'
import { build } from 'esbuild'
import { getCacheKeyPrefix } from './keys.ts'

// Bundle the production flow with fake service boundaries, so tests exercise
// the actual state handoff between the main action and its post step.
const mocks = {
  '@actions/cache': `
    import { mock } from 'node:test'
    export const restoreCache = mock.fn(async () => undefined)
    export const saveCache = mock.fn(async () => 1)
  `,
  '@actions/core': `
    export const state = new Map()
    export const outputs = new Map()
    export const saveState = (key, value) => state.set(key, value)
    export const getState = key => state.get(key) ?? ''
    export const setOutput = (key, value) => outputs.set(key, value)
    export const debug = () => {}
    export const info = () => {}
  `,
  '@actions/exec': String.raw`export const getExecOutput = async () => ({ stdout: '/pnpm-store\n' })`,
  '@actions/glob': `export const hashFiles = async () => 'lockfile-hash'`,
  '../lockfile-verification-cache': `export const restoreVerificationCache = async () => {}`,
}
const bundle = await build({
  stdin: {
    contents: `
      export { runRestoreCache, finalizeCache } from './run.ts'
      export { runSaveCache } from '../cache-save/run.ts'
      export * as cache from '@actions/cache'
      export * as core from '@actions/core'
    `,
    resolveDir: fileURLToPath(new URL('.', import.meta.url)),
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [{
    name: 'fake-cache-services',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (Object.hasOwn(mocks, args.path)) return { path: args.path, namespace: 'mock' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path] }))
    },
  }],
})
const { runRestoreCache, finalizeCache, runSaveCache, cache, core } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)

const inputs = { cache: true, cacheDependencyPath: 'pnpm-lock.yaml' }
const runtimes = [{ name: 'node', version: '24.19.0' }]
const keyPrefix = getCacheKeyPrefix(process.env.RUNNER_OS, os.arch(), runtimes)
const lockfileKeyPrefix = `${keyPrefix}lockfile-hash-`

beforeEach(() => {
  core.state.clear()
  core.outputs.clear()
  cache.restoreCache.mock.resetCalls()
  cache.restoreCache.mock.mockImplementation(async () => undefined)
  cache.saveCache.mock.resetCalls()
})

test('restore asks for the current lockfile before the broader runtime fallback', async () => {
  await runRestoreCache(inputs, runtimes)
  assert.deepEqual(cache.restoreCache.mock.calls[0].arguments, [
    ['/pnpm-store'], lockfileKeyPrefix, [lockfileKeyPrefix, keyPrefix],
  ])
})

for (const [label, restoredKey, expectedHit] of [
  ['same lockfile', `${lockfileKeyPrefix}previous-invocation`, true],
  ['different lockfile', `${keyPrefix}other-lockfile-previous-invocation`, false],
  ['cache miss', undefined, false],
]) {
  test(`${label}: reports cache-hit and publishes a fresh store`, async () => {
    cache.restoreCache.mock.mockImplementation(async () => restoredKey)
    const restored = await runRestoreCache(inputs, runtimes)
    finalizeCache(restored, runtimes)
    assert.equal(core.outputs.get('cache-hit'), expectedHit)

    await runSaveCache()
    const primaryKey = core.state.get('cache_primary_key')
    assert.ok(primaryKey.startsWith(lockfileKeyPrefix))
    assert.notEqual(primaryKey, restoredKey)
    assert.deepEqual(cache.saveCache.mock.calls[0].arguments, [['/pnpm-store'], primaryKey])
  })
}

test('a failure before finalization does not save the restored store', async () => {
  await runRestoreCache(inputs, runtimes)
  await runSaveCache()
  assert.equal(cache.saveCache.mock.callCount(), 0)
})

test('equivalent invocations in one workflow attempt publish distinct save keys', async t => {
  const previous = [process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT]
  t.after(() => {
    for (const [index, name] of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'].entries()) {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    }
  })
  process.env.GITHUB_RUN_ID = '555'
  process.env.GITHUB_RUN_ATTEMPT = '1'

  for (let invocation = 0; invocation < 2; invocation++) {
    const restored = await runRestoreCache(inputs, runtimes)
    finalizeCache(restored, runtimes)
    await runSaveCache()
  }
  const keys = cache.saveCache.mock.calls.map(call => call.arguments[1])
  assert.equal(keys.length, 2)
  assert.notEqual(keys[0], keys[1])
  for (const key of keys) assert.match(key, /-555-1-[0-9a-f-]{36}$/)
})

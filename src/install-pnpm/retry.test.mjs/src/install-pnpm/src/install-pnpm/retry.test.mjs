import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isTransientNetworkError, withRetries } from './retry.ts'

const noSleep = () => Promise.resolve()

test('returns the result without retrying on first success', async () => {
  let calls = 0
  const result = await withRetries('job', async () => {
    calls++
    return 'ok'
  }, { sleep: noSleep })
  assert.equal(result, 'ok')
  assert.equal(calls, 1)
})

test('retries a transient timeout and then succeeds', async () => {
  let calls = 0
  const result = await withRetries('Downloading pnpm', async () => {
    calls++
    if (calls < 3) {
      throw new Error('Could not reach https://registry.npmjs.org/@pnpm/exe.linux-x64/12.14.0: timed out after 30s')
    }
    return 'done'
  }, { sleep: noSleep })
  assert.equal(result, 'done')
  assert.equal(calls, 3)
})

test('does not retry a signature verification failure', async () => {
  let calls = 0
  await assert.rejects(
    withRetries('Downloading pnpm', async () => {
      calls++
      throw new Error('The npm registry signature for pnpm is not valid. Refusing to install.')
    }, { sleep: noSleep }),
    /signature/,
  )
  assert.equal(calls, 1)
})

test('does not retry a 404 or an unknown version', async () => {
  for (const message of [
    'Could not download https://registry.npmjs.org/pnpm: 404 Not Found',
    'Sorry! pnpm version "9.0.0" could not be found. Available tags: latest',
  ]) {
    let calls = 0
    await assert.rejects(
      withRetries('Fetching', async () => {
        calls++
        throw new Error(message)
      }, { sleep: noSleep }),
    )
    assert.equal(calls, 1, message)
  }
})

test('gives up after maxAttempts on persistent transient failures', async () => {
  let calls = 0
  await assert.rejects(
    withRetries('job', async () => {
      calls++
      throw new Error('fetch failed')
    }, { maxAttempts: 3, sleep: noSleep }),
    /fetch failed/,
  )
  assert.equal(calls, 3)
})

test('retries HTTP 429 and 5xx statuses but not 400', async () => {
  for (const [statusCode, transient] of [[429, true], [500, true], [503, true], [400, false], [404, false]]) {
    assert.equal(isTransientNetworkError({ statusCode }), transient, `statusCode ${statusCode}`)
    assert.equal(isTransientNetworkError({ status: statusCode }), transient, `status ${statusCode}`)
  }
})

test('matches connection-level error codes and cause chains', () => {
  assert.equal(isTransientNetworkError(Object.assign(new Error('request failed'), { code: 'ECONNRESET' })), true)
  assert.equal(isTransientNetworkError(new Error('socket hang up')), true)
  assert.equal(isTransientNetworkError(new Error('Could not reach https://r.example.com: ETIMEDOUT')), true)
  const wrapped = new Error('Could not reach https://r.example.com: fetch failed', { cause: new Error('getaddrinfo ENOTFOUND r.example.com') })
  assert.equal(isTransientNetworkError(wrapped), true)
  assert.equal(isTransientNetworkError(new Error('The download does not match the checksum the npm registry published for it.')), false)
  assert.equal(isTransientNetworkError('a plain string'), false)
  assert.equal(isTransientNetworkError(null), false)
})

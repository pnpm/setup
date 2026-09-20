import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateRegistryInputs } from './index.ts'

describe('validateRegistryInputs', () => {
  it('throws when registry-url is set without registry-token', () => {
    assert.throws(
      () => validateRegistryInputs('https://example.jfrog.io/', ''),
      /registry-token.*required.*registry-url/i,
    )
  })

  it('throws when registry-token is set without registry-url', () => {
    assert.throws(
      () => validateRegistryInputs('', 'mytoken'),
      /registry-url.*required.*registry-token/i,
    )
  })

  it('returns undefined when neither is set', () => {
    assert.equal(validateRegistryInputs('', ''), undefined)
  })

  it('returns registry config when both are set', () => {
    const result = validateRegistryInputs('https://example.jfrog.io/', 'mytoken')
    assert.deepEqual(result, {
      registryUrl: 'https://example.jfrog.io/',
      registryToken: 'mytoken',
    })
  })
})

for (const url of [
  'not-a-url', 'http://registry.example.com/', 'ftp://registry.example.com/',
  'https://user:password@registry.example.com/', 'https://registry.example.com/?secret=value',
  'https://registry.example.com/#fragment', 'https://registry.example.com/path=value',
  'https://registry.example.com/\n', 'http://localhost.attacker.example/',
]) {
  it(`rejects invalid registry URL ${JSON.stringify(url)} without echoing it`, () => {
    assert.throws(() => validateRegistryInputs(url, 'test-token'), error => {
      assert.match(error.message, /registry-url/)
      assert.ok(!error.message.includes(url))
      assert.ok(!error.message.includes('test-token'))
      return true
    })
  })
}

for (const url of ['http://localhost:4873/', 'http://127.0.0.1:4873/', 'http://[::1]:4873/']) {
  it(`accepts local HTTP registry ${url}`, () => {
    assert.equal(validateRegistryInputs(url, 'test-token').registryUrl, url)
  })
}

it('rejects invalid token characters', () => {
  for (const token of ['line\nbreak', 'line\rbreak', 'null\0byte']) {
    assert.throws(() => validateRegistryInputs('https://registry.example.com', token), /registry-token/)
  }
})

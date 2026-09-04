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

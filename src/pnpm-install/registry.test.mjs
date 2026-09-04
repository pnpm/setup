import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRegistryAuthArgs } from './registry.ts'

describe('buildRegistryAuthArgs', () => {
  it('returns config set args for the given registry and token', () => {
    const args = buildRegistryAuthArgs('https://example.jfrog.io/npm/', 'mytoken')
    assert.deepEqual(args, ['config', 'set', 'https://example.jfrog.io/npm//:_authToken', 'mytoken'])
  })

  it('appends trailing slash to registry URL if missing', () => {
    const args = buildRegistryAuthArgs('https://example.jfrog.io/npm', 'mytoken')
    assert.deepEqual(args, ['config', 'set', 'https://example.jfrog.io/npm//:_authToken', 'mytoken'])
  })
})

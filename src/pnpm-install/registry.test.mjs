import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRegistryAuthArgs } from './registry.ts'

describe('buildRegistryAuthArgs', () => {
  it('uses protocol-relative key form with trailing slash', () => {
    const args = buildRegistryAuthArgs('https://example.jfrog.io/npm/', 'mytoken')
    assert.deepEqual(args, ['config', 'set', '//example.jfrog.io/npm/:_authToken', 'mytoken'])
  })

  it('normalises missing trailing slash on the path', () => {
    const args = buildRegistryAuthArgs('https://example.jfrog.io/npm', 'mytoken')
    assert.deepEqual(args, ['config', 'set', '//example.jfrog.io/npm/:_authToken', 'mytoken'])
  })

  it('works with a bare hostname registry', () => {
    const args = buildRegistryAuthArgs('https://registry.example.com/', 'tok')
    assert.deepEqual(args, ['config', 'set', '//registry.example.com/:_authToken', 'tok'])
  })
})

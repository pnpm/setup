import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_REGISTRY, resolveRegistry } from './registry.ts'

test('defaults to the npm registry', () => {
  assert.equal(resolveRegistry(''), DEFAULT_REGISTRY)
  assert.equal(resolveRegistry('  '), DEFAULT_REGISTRY)
})

test('ignores registry environment variables', t => {
  for (const name of ['pnpm_config_registry', 'npm_config_registry']) {
    const previous = process.env[name]
    process.env[name] = 'https://env.example.com/'
    t.after(() => {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    })
  }
  assert.equal(resolveRegistry(''), DEFAULT_REGISTRY)
})

test('keeps a subpath usable as a base URL', () => {
  const registry = resolveRegistry('https://artifactory.example.com/api/npm/npm-remote')
  assert.equal(registry, 'https://artifactory.example.com/api/npm/npm-remote/')
  assert.equal(new URL('pnpm', registry).href, 'https://artifactory.example.com/api/npm/npm-remote/pnpm')
})

test('rejects anything but an absolute http(s) URL', () => {
  assert.throws(() => resolveRegistry('registry.example.com'), /Invalid registry URL\. Expected/)
  assert.throws(() => resolveRegistry('file:///srv/registry'), /Only http and https/)
})

test('rejects credentials without echoing them', () => {
  assert.throws(
    () => resolveRegistry('https://user:s3cret@mirror.example.com/'),
    error => /must not contain credentials/.test(error.message) && !error.message.includes('s3cret'),
  )
})

test('accepts plain http registries', () => {
  assert.equal(resolveRegistry('http://mirror.internal/npm'), 'http://mirror.internal/npm/')
})

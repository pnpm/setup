import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_REGISTRY, resolveRegistry } from './registry.ts'

test('defaults to the npm registry', () => {
  assert.equal(resolveRegistry('', {}), DEFAULT_REGISTRY)
})

test('the input wins over registry variables', () => {
  assert.equal(
    resolveRegistry('https://input.example.com/', { pnpm_config_registry: 'https://env.example.com/' }),
    'https://input.example.com/',
  )
})

test('falls back to pnpm variables before npm ones', () => {
  assert.equal(
    resolveRegistry('', {
      npm_config_registry: 'https://npm.example.com/',
      PNPM_CONFIG_REGISTRY: 'https://pnpm.example.com/',
    }),
    'https://pnpm.example.com/',
  )
  assert.equal(resolveRegistry('', { NPM_CONFIG_REGISTRY: 'https://npm.example.com/' }), 'https://npm.example.com/')
})

test('ignores empty variables', () => {
  assert.equal(
    resolveRegistry('  ', { pnpm_config_registry: '', npm_config_registry: 'https://npm.example.com/' }),
    'https://npm.example.com/',
  )
})

test('keeps a subpath usable as a base URL', () => {
  const registry = resolveRegistry('https://artifactory.example.com/api/npm/npm-remote', {})
  assert.equal(registry, 'https://artifactory.example.com/api/npm/npm-remote/')
  assert.equal(new URL('pnpm', registry).href, 'https://artifactory.example.com/api/npm/npm-remote/pnpm')
})

test('rejects anything but an absolute http(s) URL', () => {
  assert.throws(() => resolveRegistry('registry.example.com', {}), /Invalid registry URL\. Expected/)
  assert.throws(() => resolveRegistry('file:///srv/registry', {}), /Only http and https/)
})

test('rejects credentials without echoing them', () => {
  assert.throws(
    () => resolveRegistry('https://user:s3cret@mirror.example.com/', {}),
    error => /must not contain credentials/.test(error.message) && !error.message.includes('s3cret'),
  )
})

test('accepts plain http registries', () => {
  assert.equal(resolveRegistry('http://mirror.internal/npm', {}), 'http://mirror.internal/npm/')
})

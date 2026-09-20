import test from 'node:test'
import assert from 'node:assert/strict'
import { registryInstallEnv } from './registry.ts'

for (const [url, key] of [
  ['https://example.jfrog.io/npm/', 'pnpm_config_//example.jfrog.io/npm/:_authToken'],
  ['https://example.jfrog.io/npm', 'pnpm_config_//example.jfrog.io/npm/:_authToken'],
  ['https://registry.example.com/', 'pnpm_config_//registry.example.com/:_authToken'],
  ['https://registry.example.com:8443/MyRegistry/', 'pnpm_config_//registry.example.com:8443/MyRegistry/:_authToken'],
]) {
  test(`scopes authentication to ${url}`, () => {
    const environment = { PATH: '/bin', 'INPUT_REGISTRY-TOKEN': 'secret', unrelated: 'keep' }
    assert.deepEqual(registryInstallEnv({ registryUrl: url, registryToken: 'secret' }, environment), {
      PATH: '/bin', unrelated: 'keep', [key]: 'secret',
    })
    assert.equal(environment['INPUT_REGISTRY-TOKEN'], 'secret')
    assert.equal(environment[key], undefined)
  })
}

test('removes the raw input even when no registry is configured', () => {
  assert.deepEqual(registryInstallEnv(undefined, { 'INPUT_REGISTRY-TOKEN': 'secret', 'input_registry-token': 'secret', PATH: '/bin' }), { PATH: '/bin' })
})

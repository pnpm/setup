import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const mocks = {
  '@actions/core': `
    import { mock } from 'node:test'
    export const info = mock.fn()
    export const setFailed = mock.fn()
    export const setSecret = mock.fn()
    export const startGroup = mock.fn()
    export const endGroup = mock.fn()
  `,
  child_process: `
    import { mock } from 'node:test'
    export const spawnSync = mock.fn()
  `,
}
const { outputFiles } = await build({
  stdin: {
    contents: `export { runPnpmInstall } from './index.ts'; export * as core from '@actions/core'; export { spawnSync } from 'child_process'`,
    resolveDir: fileURLToPath(new URL('.', import.meta.url)),
  },
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{
    name: 'mock-process-boundary',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (Object.hasOwn(mocks, args.path)) return { path: args.path, namespace: 'mock' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path] }))
    },
  }],
})
const { runPnpmInstall, core, spawnSync } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
)
const token = 'test-token-$(must-not-run)'
const inputs = {
  workingDirectory: '.', packageJsonFile: 'package.json',
  registry: { registryUrl: 'https://registry.example/npm/', registryToken: token },
}

beforeEach(t => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'setup-registry-install-'))
  writeFileSync(path.join(workspace, 'package.json'), '{}')
  const previous = [process.env.GITHUB_WORKSPACE, process.env['INPUT_REGISTRY-TOKEN']]
  process.env.GITHUB_WORKSPACE = workspace
  process.env['INPUT_REGISTRY-TOKEN'] = token
  t.after(() => {
    for (const [i, key] of ['GITHUB_WORKSPACE', 'INPUT_REGISTRY-TOKEN'].entries()) {
      if (previous[i] === undefined) delete process.env[key]
      else process.env[key] = previous[i]
    }
    rmSync(workspace, { recursive: true, force: true })
  })
  for (const fn of Object.values(core)) fn.mock.resetCalls()
  spawnSync.mock.resetCalls()
  spawnSync.mock.mockImplementation((_bin, args) => args[0] === '--version'
    ? { status: 0, stdout: '12.5.1\n' }
    : { status: 0 })
})

for (const [name, result, failed] of [
  ['success', { status: 0 }, false],
  ['failure', { status: 1 }, true],
  ['signal', { status: null, signal: 'SIGTERM' }, true],
  ['spawn error', { error: new Error('Unable to spawn pnpm') }, true],
]) {
  test(`install ${name} keeps credentials in the install child only`, () => {
    spawnSync.mock.mockImplementation((_bin, args) => args[0] === '--version'
      ? { status: 0, stdout: '11.6.0' } : result)
    runPnpmInstall(inputs)
    assert.equal(spawnSync.mock.callCount(), 2)
    const versionEnv = spawnSync.mock.calls[0].arguments[2].env
    const [bin, args, options] = spawnSync.mock.calls[1].arguments
    assert.equal(bin, 'pnpm')
    assert.deepEqual(args, ['install'])
    assert.equal(options.shell, undefined)
    assert.equal(options.env['pnpm_config_//registry.example/npm/:_authToken'], token)
    assert.equal(options.env['INPUT_REGISTRY-TOKEN'], undefined)
    assert.ok(!Object.values(versionEnv).includes(token))
    assert.equal(process.env['pnpm_config_//registry.example/npm/:_authToken'], undefined)
    assert.equal(core.setFailed.mock.callCount(), failed ? 1 : 0)
    assert.deepEqual(core.setSecret.mock.calls[0].arguments, [token])
    for (const fn of [core.info, core.startGroup, core.setFailed]) {
      assert.ok(!JSON.stringify(fn.mock.calls).includes(token))
    }
  })
}

test('older pnpm cannot silently attempt an unauthenticated install', () => {
  spawnSync.mock.mockImplementation(() => ({ status: 0, stdout: '11.5.0' }))
  runPnpmInstall(inputs)
  assert.equal(spawnSync.mock.callCount(), 1)
  assert.match(core.setFailed.mock.calls[0].arguments[0], /11\.6\.0/)
})

test('an install without registry credentials retains existing flags and environment', () => {
  runPnpmInstall({ ...inputs, registry: undefined, requireLockfile: false }, true)
  assert.equal(spawnSync.mock.callCount(), 1)
  assert.deepEqual(spawnSync.mock.calls[0].arguments[1], ['install', '--no-runtime'])
  assert.equal(spawnSync.mock.calls[0].arguments[2].env.PATH, process.env.PATH)
})

test('a missing required lockfile never starts an authenticated process', () => {
  runPnpmInstall({ ...inputs, requireLockfile: true })
  assert.equal(spawnSync.mock.callCount(), 0)
  assert.equal(core.setFailed.mock.callCount(), 1)
})

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', outputFiles[0].text)(
  createRequire(import.meta.url), bundledModule, bundledModule.exports,
)
const { resolveRuntimeRequests } = bundledModule.exports

const node = version => ({ name: 'node', version })
const bun = { name: 'bun', version: '1.3.13' }

const scenarios = [
  {
    name: 'no runtime sources leaves runtimes empty',
    files: {}, expected: [],
  },
  {
    name: 'an automatically detected file supplies Node',
    files: { '.node-version': '24' }, expected: [node('24')],
  },
  {
    name: 'an automatically detected file adds Node alongside manifest runtimes',
    manifest: [bun], files: { '.nvmrc': '24' }, expected: [node('24'), bun],
  },
  {
    name: 'the manifest takes precedence over an invalid auto-detected file',
    manifest: [bun, node('22')], files: { '.node-version': '' }, expected: [bun, node('22')],
  },
  {
    name: 'an explicit file overrides manifest Node and retains other runtimes',
    manifest: [bun, node('22')], files: { '.nvmrc': '24' },
    inputs: { nodeVersionFile: '.nvmrc' }, expected: [node('24'), bun],
  },
  {
    name: 'an explicit runtime version ignores a missing explicit file',
    manifest: [node('24')], files: {},
    inputs: { runtime: node('22'), nodeVersionFile: 'missing' }, expected: [node('22')],
  },
  {
    name: 'runtime node prefers the explicit file to the manifest',
    manifest: [node('22')], files: { '.nvmrc': '24' },
    inputs: { runtime: { name: 'node' }, nodeVersionFile: '.nvmrc' }, expected: [node('24')],
  },
  {
    name: 'runtime node prefers the manifest to automatic detection',
    manifest: [node('22')], files: { '.node-version': '' },
    inputs: { runtime: { name: 'node' } }, expected: [node('22')],
  },
  {
    name: 'runtime node uses automatic detection before its LTS default',
    files: { '.nvmrc': '24' }, inputs: { runtime: { name: 'node' } }, expected: [node('24')],
  },
  {
    name: 'runtime node retains its LTS default when no file exists',
    files: {}, inputs: { runtime: { name: 'node' } }, expected: [node('lts')],
  },
  {
    name: 'an explicit non-Node runtime ignores detected Node files',
    files: { '.node-version': '' }, inputs: { runtime: bun }, expected: [bun],
  },
  {
    name: 'an explicit non-Node runtime ignores a missing explicit Node file',
    files: {}, inputs: { runtime: bun, nodeVersionFile: 'missing' }, expected: [bun],
  },
  {
    name: 'opting out ignores detected files',
    files: { '.node-version': '' }, inputs: { nodeVersionFile: false }, expected: [],
  },
  {
    name: 'opting out preserves manifest runtimes',
    manifest: [bun, node('22')], files: { '.node-version': '' },
    inputs: { nodeVersionFile: false }, expected: [bun, node('22')],
  },
  {
    name: 'opting out preserves explicit runtime installation',
    files: { '.node-version': '' },
    inputs: { runtime: node('22'), nodeVersionFile: false }, expected: [node('22')],
  },
  {
    name: 'runtime node with detection disabled still defaults to LTS',
    files: { '.node-version': '' },
    inputs: { runtime: { name: 'node' }, nodeVersionFile: false }, expected: [node('lts')],
  },
]

for (const scenario of scenarios) {
  test(scenario.name, t => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'pnpm-runtime-requests-'))
    const previous = process.env.GITHUB_WORKSPACE
    process.env.GITHUB_WORKSPACE = workspace
    t.after(() => {
      if (previous === undefined) delete process.env.GITHUB_WORKSPACE
      else process.env.GITHUB_WORKSPACE = previous
      rmSync(workspace, { recursive: true, force: true })
    })
    if (scenario.manifest) {
      writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ devEngines: { runtime: scenario.manifest } }))
    }
    for (const [file, contents] of Object.entries(scenario.files)) {
      writeFileSync(path.join(workspace, file), contents)
    }
    assert.deepEqual(resolveRuntimeRequests({
      workingDirectory: '.', packageJsonFile: 'package.json', ...scenario.inputs,
    }), scenario.expected)
  })
}

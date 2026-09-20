import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: `
      export { getInputs } from './inputs/index.ts'
      export { runPnpmInstall } from './pnpm-install/index.ts'
      export { pruneStore } from './pnpm-store-prune/index.ts'
    `,
    resolveDir: fileURLToPath(new URL('.', import.meta.url)),
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
})
const bundledModule = { exports: {} }
new Function('require', 'module', 'exports', outputFiles[0].text)(
  createRequire(import.meta.url), bundledModule, bundledModule.exports,
)
const { getInputs, runPnpmInstall, pruneStore } = bundledModule.exports

const root = mkdtempSync(path.join(process.cwd(), '.pnpm-commands-test-'))
const dest = path.join(root, 'pnpm home & tools')
const project = path.join(root, 'project')
const record = path.join(root, 'command.json')
mkdirSync(path.join(dest, 'bin'), { recursive: true })
mkdirSync(project)
writeFileSync(path.join(project, 'package.json'), '{}')
writeFileSync(path.join(project, 'pnpm-lock.yaml'), '')

// A native executable named pnpm proves direct spawning works even when the
// destination contains spaces or shell metacharacters. Node consumes the
// fixture named "install" as its script, then passes through the install flags.
copyFileSync(process.execPath, path.join(dest, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm'))
const recorder = `
  const fs = require('node:fs')
  setTimeout(() => {
    fs.writeFileSync(process.env.PNPM_TEST_RECORD, JSON.stringify({
      args: process.argv.slice(2), cwd: process.cwd(), executable: process.execPath,
    }))
    process.exitCode = Number(process.env.PNPM_TEST_EXIT_CODE || 0)
  }, 25)
`
writeFileSync(path.join(project, 'install'), recorder)
const shimScript = path.join(dest, 'record.cjs')
writeFileSync(shimScript, recorder)
const quoteShell = value => `'${value.replaceAll("'", "'\\''")}'`
const shim = process.platform === 'win32'
  ? `@"${process.execPath}" "${shimScript}" %*\r\n`
  : `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(shimScript)} "$@"\n`
writeFileSync(path.join(dest, 'bin', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'), shim, { mode: 0o755 })
after(() => rmSync(root, { recursive: true, force: true }))

beforeEach(t => {
  const previousEnv = { ...process.env }
  const previousExitCode = process.exitCode
  t.after(() => {
    for (const name of Object.keys(process.env)) {
      if (!(name in previousEnv)) delete process.env[name]
    }
    Object.assign(process.env, previousEnv)
    process.exitCode = previousExitCode
  })
  Object.assign(process.env, {
    GITHUB_WORKSPACE: root,
    INPUT_DEST: path.relative(process.cwd(), dest),
    INPUT_CACHE: 'true',
    INPUT_INSTALL: 'true',
    'INPUT_REQUIRE-LOCKFILE': 'true',
    'INPUT_WORKING-DIRECTORY': 'project',
    'INPUT_PACKAGE-JSON-FILE': '',
    'INPUT_NODE-VERSION-FILE': '',
    INPUT_RUNTIME: '',
    PNPM_TEST_RECORD: record,
    PNPM_TEST_EXIT_CODE: '0',
  })
  // Simulate the PATH prepared by setup, with self-update's shim first.
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  process.env[pathKey] = [path.join(dest, 'bin'), dest, process.env[pathKey]].join(path.delimiter)
  rmSync(record, { force: true })
})

test('install uses the native binary with a relative dest and a separate project directory', () => {
  const inputs = getInputs()
  assert.equal(inputs.dest, dest)
  runPnpmInstall(inputs, true)
  const actual = JSON.parse(readFileSync(record, 'utf8'))
  assert.deepEqual(actual.args, ['--frozen-lockfile', '--no-runtime'])
  assert.equal(actual.cwd, project)
  assert.equal(path.dirname(actual.executable), dest)
})

test('pruning awaits the self-updated shim ahead of the original executable on PATH', async () => {
  await pruneStore(getInputs())
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')).args, ['store', 'prune'])
})

test('pruning is skipped when caching is disabled', async () => {
  await pruneStore({ ...getInputs(), cache: false })
  assert.throws(() => readFileSync(record), { code: 'ENOENT' })
})

test('pruning failure warns without failing the action', async t => {
  process.env.PNPM_TEST_EXIT_CODE = '7'
  const output = []
  const write = process.stdout.write.bind(process.stdout)
  t.mock.method(process.stdout, 'write', (chunk, ...args) => {
    output.push(String(chunk))
    return write(chunk, ...args)
  })
  const previousExitCode = process.exitCode
  await pruneStore(getInputs())
  assert.match(output.join(''), /::warning::.*exit code 7/)
  assert.equal(process.exitCode, previousExitCode)
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')).args, ['store', 'prune'])
})

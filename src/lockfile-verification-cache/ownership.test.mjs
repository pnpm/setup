import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Main/post really run in separate processes. Only external setup/cache services
// are replaced; the entry point, install exit handling and verification log are real.
const temporary = mkdtempSync(join(tmpdir(), 'pnpm-setup-owner-'))
after(() => rmSync(temporary, { recursive: true, force: true }))
const source = fileURLToPath(new URL('..', import.meta.url))
const mocks = {
  '@actions/core': `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs'
    const path = process.env.TEST_STATE
    const incoming = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
    const outgoing = { ...incoming }
    export const getState = key => incoming[key] ?? ''
    export const saveState = (key, value) => {
      outgoing[key] = typeof value === 'string' ? value : JSON.stringify(value)
      writeFileSync(path, JSON.stringify(outgoing))
    }
    export const setFailed = message => { process.exitCode = 1; console.error(message) }
    export const debug = () => {}
    export const info = () => {}
    export const warning = message => console.error(message)
    export const startGroup = () => {}
    export const endGroup = () => {}
  `,
  '@actions/cache': `
    import { appendFileSync, readFileSync } from 'node:fs'
    export const restoreCache = async (_paths, key) => process.env.TEST_HIT === 'true' ? key : undefined
    export const saveCache = async ([path], key) => {
      appendFileSync(process.env.TEST_SAVES, JSON.stringify({ key, log: readFileSync(path, 'utf8') }) + '\\n')
      if (process.env.TEST_SAVE === 'error') throw new Error('cache transport unavailable')
      return process.env.TEST_SAVE === 'collision' ? -1 : 1
    }
  `,
  '@actions/exec': `export const getExecOutput = async () => ({ exitCode: 0, stdout: process.env.GITHUB_WORKSPACE })`,
  './inputs': `export default () => JSON.parse(process.env.TEST_INPUTS)`,
  './install-pnpm': `export default async () => ({ binDest: process.env.GITHUB_WORKSPACE })`,
  './install-runtime': `
    export const resolveRuntimeRequests = () => []
    export const getInstalledRuntimeVersions = async () => new Map()
    export const installRuntime = async () => undefined
    export const keepInstalledRuntimesAuthoritative = () => {}
    export const logSkippedRuntime = () => {}
  `,
  './outputs': `export default () => {}`,
  './cache-restore': `
    import { restoreVerificationCache } from ${JSON.stringify(join(source, 'lockfile-verification-cache/index.ts'))}
    export default async () => { await restoreVerificationCache('same-lockfile') }
    export const finalizeCache = () => {}
  `,
  './cache-save': `export default async () => {}`,
  './pnpm-store-prune': `export default async () => {}`,
}
const bundle = join(temporary, 'action.cjs')
await build({
  entryPoints: [join(source, 'index.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  plugins: [
    {
      name: 'external-action-services',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (Object.hasOwn(mocks, args.path)) return { path: args.path, namespace: 'mock' }
        })
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
          contents: mocks[args.path],
          resolveDir: source,
        }))
      },
    },
  ],
})

for (const scenario of [
  { name: 'successful immediate publication', saves: 1 },
  { name: 'reservation collision', save: 'collision', saves: 1 },
  { name: 'cache transport failure', save: 'error', saves: 1 },
  { name: 'exact restored verdict', hit: true, saves: 0 },
  { name: 'failed install', status: 3, saves: 0 },
  { name: 'terminated install', signal: true, saves: 0 },
  { name: 'missing required lockfile', missingLockfile: true, saves: 0 },
  { name: 'missing manifest', missingManifest: true, saves: 0 },
  { name: 'rejected verification growth', records: 2, saves: 0 },
  { name: 'later-step install owns post publication', later: true, saves: 1 },
]) {
  test(
    scenario.name,
    { skip: process.platform === 'win32' ? 'POSIX executable fixture' : false },
    () => {
      const root = mkdtempSync(join(temporary, 'workspace-'))
      const log = join(root, 'lockfile-verified.jsonl')
      const saves = join(root, 'saves.jsonl')
      writeFileSync(log, '{"before":"verified"}\n')
      writeFileSync(saves, '')
      if (!scenario.missingManifest) writeFileSync(join(root, 'package.json'), '{}')
      writeFileSync(
        join(root, 'pnpm'),
        `#!/usr/bin/env node
      if (process.argv[2] !== 'install') process.exit(0)
      require('node:fs').appendFileSync(${JSON.stringify(log)}, '{"install":"verified"}\\n'.repeat(${scenario.records ?? 1}))
      ${scenario.signal ? "process.kill(process.pid, 'SIGTERM')" : `process.exit(${scenario.status ?? 0})`}
    `,
        { mode: 0o755 },
      )
      const env = {
        ...process.env,
        GITHUB_WORKSPACE: root,
        TEST_STATE: join(root, 'state.json'),
        TEST_SAVES: saves,
        TEST_SAVE: scenario.save ?? '',
        TEST_HIT: String(scenario.hit ?? false),
        TEST_INPUTS: JSON.stringify({
          install: !scenario.later,
          requireLockfile: !!scenario.missingLockfile,
          dest: root,
          packageJsonFile: 'package.json',
          workingDirectory: '.',
        }),
      }
      const main = spawnSync(process.execPath, [bundle], { env, encoding: 'utf8' })
      assert.equal(
        main.status,
        scenario.status || scenario.signal || scenario.missingLockfile ? 1 : 0,
        main.stderr,
      )
      const immediate = readFileSync(saves, 'utf8')
      assert.equal(
        immediate.trim().split('\n').filter(Boolean).length,
        scenario.later ? 0 : scenario.saves,
      )

      // Later job steps can append records. For action-owned installation, even a
      // collision/error/growth rejection must not reopen the publication window.
      writeFileSync(log, '{"before":"verified"}\n{"later":"verified"}\n{"another":"verified"}\n')
      const post = spawnSync(process.execPath, [bundle], { env, encoding: 'utf8' })
      assert.equal(post.status, 0, post.stderr)
      const final = readFileSync(saves, 'utf8')
      assert.equal(final.trim().split('\n').filter(Boolean).length, scenario.saves)
      if (scenario.later) assert.equal(JSON.parse(final).log, readFileSync(log, 'utf8'))
      else assert.equal(final, immediate)
    },
  )
}

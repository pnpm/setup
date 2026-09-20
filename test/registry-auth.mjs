import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = mkdtempSync(path.join(tmpdir(), 'setup-registry-integration-'))
const token = 'local-registry-test-token'
const manifest = { name: 'setup-registry-fixture', version: '1.0.0' }
const requests = []
let registry
let tarball
const server = createServer((request, response) => {
  requests.push({ path: request.url, authorization: request.headers.authorization })
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end('Authentication required')
    return
  }
  if (request.url === '/npm/fixture.tgz') {
    response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(tarball)
    return
  }
  if (request.url !== '/npm/setup-registry-fixture') {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    name: manifest.name,
    'dist-tags': { latest: manifest.version },
    time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
    versions: {
      '1.0.0': { ...manifest, dist: {
        tarball: `${registry}fixture.tgz`,
        integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
      } },
    },
  }))
})

try {
  mkdirSync(path.join(root, 'package'))
  writeFileSync(path.join(root, 'package/package.json'), JSON.stringify(manifest))
  const archive = path.join(root, 'fixture.tgz')
  const packed = spawnSync('tar', ['-czf', archive, '-C', root, 'package'], { encoding: 'utf8' })
  assert.equal(packed.status, 0, packed.stderr)
  tarball = readFileSync(archive)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  registry = `http://127.0.0.1:${server.address().port}/npm/`
  const userConfig = path.join(root, 'user.npmrc')
  const originalConfig = 'registry=https://registry.npmjs.org/\n'
  writeFileSync(userConfig, originalConfig)
  writeFileSync(path.join(root, '.npmrc'), `registry=${registry}\n`)
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { [manifest.name]: manifest.version } }))
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), JSON.stringify({
    storeDir: path.join(root, 'store'), cacheDir: path.join(root, 'cache'),
    enableGlobalVirtualStore: false, minimumReleaseAge: 0, fetchRetries: 0,
  }))

  const { outputFiles } = await build({
    stdin: {
      contents: `
        import { runPnpmInstall } from './src/pnpm-install/index.ts'
        runPnpmInstall({ workingDirectory: '.', packageJsonFile: 'package.json',
          registry: { registryUrl: process.env.TEST_REGISTRY_URL, registryToken: process.env['INPUT_REGISTRY-TOKEN'] } })
      `,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true, platform: 'node', format: 'cjs', write: false,
  })
  const script = path.join(root, 'install.cjs')
  writeFileSync(script, outputFiles[0].text)
  const env = { ...process.env, GITHUB_WORKSPACE: root, TEST_REGISTRY_URL: registry,
    'INPUT_REGISTRY-TOKEN': token, NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_userconfig: userConfig, PNPM_CONFIG_NPMRC_AUTH_FILE: userConfig,
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, output }))
  })
  assert.equal(result.code, 0, result.output)
  assert.equal(JSON.parse(readFileSync(path.join(root, 'node_modules', manifest.name, 'package.json'), 'utf8')).version, '1.0.0')
  assert.ok(requests.some(request => request.path === '/npm/setup-registry-fixture'))
  assert.ok(requests.some(request => request.path === '/npm/fixture.tgz'))
  assert.ok(requests.every(request => request.authorization === `Bearer ${token}`))
  assert.equal(readFileSync(userConfig, 'utf8'), originalConfig)
  assert.equal(readFileSync(path.join(root, '.npmrc'), 'utf8'), `registry=${registry}\n`)
  assert.equal(process.env[`pnpm_config_//127.0.0.1:${server.address().port}/npm/:_authToken`], undefined)
  console.log('Private registry install passed; metadata and tarball authenticated, existing config unchanged.')
} finally {
  await new Promise(resolve => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
}

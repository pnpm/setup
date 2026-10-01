import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('./flush-and-exit.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
})

const CHUNK = 'a'.repeat(400_000)

// A pipe holds 64 KiB, so a child writing more than that only keeps its tail
// when the exit waits for the drain.
function runChild(t, source) {
  const dir = mkdtempSync(path.join(tmpdir(), 'flush-and-exit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(path.join(dir, 'flush-and-exit.cjs'), outputFiles[0].text)
  const entry = path.join(dir, 'child.cjs')
  writeFileSync(entry, source)
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    cp.stdout.setEncoding('utf8')
    cp.stderr.setEncoding('utf8')
    cp.stdout.pause()
    cp.stderr.pause()
    setTimeout(() => {
      cp.stdout.resume()
      cp.stderr.resume()
    }, 300)
    cp.stdout.on('data', chunk => {
      stdout += chunk
    })
    cp.stderr.on('data', chunk => {
      stderr += chunk
    })
    cp.on('error', reject)
    cp.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }))
  })
}

test('writes queued on both pipes reach the parent before the exit', async t => {
  const { stdout, stderr, code } = await runChild(t, `
    const { flushAndExit } = require('./flush-and-exit.cjs')
    process.stdout.write(${JSON.stringify(CHUNK)})
    process.stderr.write(${JSON.stringify(CHUNK)})
    process.stdout.write('::error::install failed\\n')
    flushAndExit()
  `)

  assert.equal(stdout, `${CHUNK}::error::install failed\n`)
  assert.equal(stderr, CHUNK)
  assert.equal(code, 0)
})

test('keeps the exit code the failure handler set', async t => {
  const { stdout, code } = await runChild(t, `
    const { flushAndExit } = require('./flush-and-exit.cjs')
    process.exitCode = 1
    process.stdout.write(${JSON.stringify(CHUNK)})
    flushAndExit()
  `)

  assert.equal(stdout, CHUNK)
  assert.equal(code, 1)
})

test('exits while a handle keeps the loop alive', async t => {
  const { code } = await runChild(t, `
    const { flushAndExit } = require('./flush-and-exit.cjs')
    setInterval(() => {}, 1000)
    flushAndExit()
  `)

  assert.equal(code, 0)
})

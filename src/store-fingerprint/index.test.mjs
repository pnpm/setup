import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fingerprintStore } from './index.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'setup-store-fingerprint-'))
after(() => rmSync(root, { recursive: true, force: true }))

let stores = 0
function createStore() {
  const store = path.join(root, `store-${stores++}`)
  mkdirSync(path.join(store, 'files', '00'), { recursive: true })
  mkdirSync(path.join(store, 'tmp'))
  writeFileSync(path.join(store, 'index.db'), 'rows')
  writeFileSync(path.join(store, 'files', '00', 'abc'), 'content')
  return store
}

function touch(file) {
  const later = new Date(Date.now() + 60_000)
  utimesSync(file, later, later)
}

for (const [label, change] of [
  ['scratch files outside the package files', store => writeFileSync(path.join(store, 'tmp', 'abc'), 'scratch')],
  ['a rewritten index', store => {
    writeFileSync(path.join(store, 'index.db'), 'more rows')
    touch(path.join(store, 'index.db'))
  }],
  ['a new write-ahead log', store => writeFileSync(path.join(store, 'index.db-wal'), 'rows')],
  ['newer timestamps on the package files', store => {
    touch(path.join(store, 'files', '00', 'abc'))
    touch(path.join(store, 'files', '00'))
  }],
  ['a package file added and removed again', store => {
    const file = path.join(store, 'files', '00', 'def')
    writeFileSync(file, 'content')
    unlinkSync(file)
    touch(path.join(store, 'files', '00'))
  }],
]) {
  test(`${label} do not change the fingerprint`, async () => {
    const store = createStore()
    const before = await fingerprintStore(store)
    change(store)
    assert.equal(await fingerprintStore(store), before)
  })
}

for (const [label, change] of [
  ['a package file added', store => writeFileSync(path.join(store, 'files', '00', 'def'), 'content')],
  ['an executable package file added', store => writeFileSync(path.join(store, 'files', '00', 'def-exec'), 'content')],
  ['a package file removed', store => unlinkSync(path.join(store, 'files', '00', 'abc'))],
  ['a package file added in a new bucket', store => {
    mkdirSync(path.join(store, 'files', '01'))
    writeFileSync(path.join(store, 'files', '01', 'abc'), 'content')
  }],
  ['a package file moved to another bucket', store => {
    unlinkSync(path.join(store, 'files', '00', 'abc'))
    mkdirSync(path.join(store, 'files', '01'))
    writeFileSync(path.join(store, 'files', '01', 'abc'), 'content')
  }],
]) {
  test(`${label} changes the fingerprint`, async () => {
    const store = createStore()
    const before = await fingerprintStore(store)
    change(store)
    assert.notEqual(await fingerprintStore(store), before)
  })
}

test('a store without an index has no fingerprint', async () => {
  const store = createStore()
  unlinkSync(path.join(store, 'index.db'))
  assert.equal(await fingerprintStore(store), undefined)
})

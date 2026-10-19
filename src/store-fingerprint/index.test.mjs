import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { fingerprintStore, statStore } from './index.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'setup-store-fingerprint-'))
after(() => rmSync(root, { recursive: true, force: true }))

let stores = 0
function createStore() {
  const store = path.join(root, `store-${stores++}`)
  mkdirSync(path.join(store, 'files', '00'), { recursive: true })
  mkdirSync(path.join(store, 'tmp'))
  writeIndex(store, ['a@1'])
  writeFileSync(path.join(store, 'files', '00', 'abc'), 'content')
  return store
}

function writeIndex(store, keys, data = 'data') {
  const db = new DatabaseSync(path.join(store, 'index.db'))
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('CREATE TABLE IF NOT EXISTS package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID')
  db.exec('DELETE FROM package_index')
  const insert = db.prepare('INSERT INTO package_index (key, data) VALUES (?, ?)')
  for (const key of keys) insert.run(key, Buffer.from(data))
  db.close()
}

function touch(file) {
  const later = new Date(Date.now() + 60_000)
  utimesSync(file, later, later)
}

for (const [label, change] of [
  ['scratch files outside the package files', store => writeFileSync(path.join(store, 'tmp', 'abc'), 'scratch')],
  ['a rewritten index with the same packages', store => {
    writeIndex(store, ['a@1'])
    touch(path.join(store, 'index.db'))
  }],
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
  test(`fingerprint is unchanged after ${label}`, async () => {
    const store = createStore()
    const before = await fingerprintStore(store)
    change(store)
    assert.equal(await fingerprintStore(store), before)
  })
}

for (const [label, change] of [
  ['a package added to the index', store => writeIndex(store, ['a@1', 'b@1'])],
  ['a package removed from the index', store => writeIndex(store, [])],
  ['an index row rewritten under the same key', store => writeIndex(store, ['a@1'], 'rewritten')],
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
  test(`fingerprint changes after ${label}`, async () => {
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

test('an unreadable index has no fingerprint', async () => {
  const store = createStore()
  writeFileSync(path.join(store, 'index.db'), 'not a database')
  assert.equal(await fingerprintStore(store), undefined)
})

test('an index with writes still in the write-ahead log has no fingerprint', async () => {
  const store = createStore()
  const db = new DatabaseSync(path.join(store, 'index.db'))
  db.exec('PRAGMA wal_autocheckpoint=0')
  db.exec("INSERT INTO package_index (key, data) VALUES ('b@1', x'00')")
  try {
    assert.equal(await fingerprintStore(store), undefined)
  } finally {
    db.close()
  }
})

test('reading the index leaves no write-ahead log behind', async () => {
  const store = createStore()
  await fingerprintStore(store)
  assert.equal(existsSync(path.join(store, 'index.db-wal')), false)
  assert.equal(existsSync(path.join(store, 'index.db-shm')), false)
})

test('the stat fingerprint changes when the index is written', async () => {
  const store = createStore()
  const before = await statStore(store)
  writeIndex(store, ['a@1', 'b@1'])
  assert.notEqual(await statStore(store), before)
})

test('the stat fingerprint is unchanged by reading the store', async () => {
  const store = createStore()
  const before = await statStore(store)
  await fingerprintStore(store)
  assert.equal(await statStore(store), before)
})

test('a store without an index has no stat fingerprint', async () => {
  const store = createStore()
  unlinkSync(path.join(store, 'index.db'))
  assert.equal(await statStore(store), undefined)
})

test('a change in any bucket of a store with many buckets changes the fingerprint', async () => {
  const store = createStore()
  for (let i = 1; i < 40; i++) mkdirSync(path.join(store, 'files', String(i).padStart(2, '0')))
  const before = await fingerprintStore(store)
  assert.equal(await fingerprintStore(store), before)
  writeFileSync(path.join(store, 'files', '39', 'abc'), 'content')
  assert.notEqual(await fingerprintStore(store), before)
})

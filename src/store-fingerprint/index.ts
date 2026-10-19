import { createHash, type Hash } from 'crypto'
import { access, lstat, readdir } from 'fs/promises'
import { DatabaseSync } from 'node:sqlite'
import path from 'path'
import { pathToFileURL } from 'url'

const BUCKETS_PER_BATCH = 16

export async function statStore(storePath: string): Promise<string | undefined> {
  const buckets = await readdir(path.join(storePath, 'files')).catch(() => [])
  const entries = ['index.db', 'index.db-wal', ...buckets.sort().map(bucket => path.join('files', bucket))]
  const stats = await Promise.all(entries.map(entry => lstat(path.join(storePath, entry)).catch(() => undefined)))
  if (!stats[0]) return undefined
  if (stats[1]?.size === 0) stats[1] = undefined

  const hash = createHash('sha256')
  entries.forEach((entry, i) => {
    hash.update(`${entry}:${stats[i] ? `${stats[i].size}:${stats[i].mtimeMs}` : 'none'}\n`)
  })
  return hash.digest('hex')
}

export async function fingerprintStore(storePath: string): Promise<string | undefined> {
  const hash = createHash('sha256')
  if (!await hashIndex(path.join(storePath, 'index.db'), hash)) return undefined
  hash.update('files\n')

  const filesPath = path.join(storePath, 'files')
  const buckets = (await readdir(filesPath).catch(() => [])).sort()
  for (let i = 0; i < buckets.length; i += BUCKETS_PER_BATCH) {
    const batch = buckets.slice(i, i + BUCKETS_PER_BATCH)
    const names = await Promise.all(
      batch.map(async bucket => (await readdir(path.join(filesPath, bucket)).catch(() => [])).sort()),
    )
    batch.forEach((bucket, j) => {
      hash.update(`${bucket}:${names[j].join(',')}\n`)
    })
  }
  return hash.digest('hex')
}

async function hashIndex(indexPath: string, hash: Hash): Promise<boolean> {
  if (!await exists(indexPath)) return false
  if (await hasPendingWrites(`${indexPath}-wal`)) return false
  const before = await stampIndex(indexPath)
  const url = pathToFileURL(indexPath)
  url.searchParams.set('immutable', '1')
  try {
    const db = new DatabaseSync(url.href, { readOnly: true })
    try {
      hash.update('index\n')
      for (const row of db.prepare('SELECT key, data FROM package_index ORDER BY key').iterate()) {
        const data = row.data as Uint8Array
        hash.update(`${String(row.key)}\n${data.length}\n`)
        hash.update(data)
      }
    } finally {
      db.close()
    }
    return before === await stampIndex(indexPath)
  } catch {
    return false
  }
}

async function stampIndex(indexPath: string) {
  const stats = await Promise.all([indexPath, `${indexPath}-wal`].map(file => lstat(file).catch(() => undefined)))
  return stats.map(stat => stat ? `${stat.size}:${stat.mtimeMs}` : 'none').join('|')
}

async function hasPendingWrites(walPath: string) {
  const stat = await lstat(walPath).catch(() => undefined)
  return stat !== undefined && stat.size > 0
}

async function exists(file: string) {
  return access(file).then(() => true, () => false)
}

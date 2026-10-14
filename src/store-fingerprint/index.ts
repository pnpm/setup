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

  const hash = createHash('sha256')
  entries.forEach((entry, i) => {
    hash.update(`${entry}:${stats[i] ? `${stats[i].size}:${stats[i].mtimeMs}` : 'none'}\n`)
  })
  return hash.digest('hex')
}

export async function fingerprintStore(storePath: string): Promise<string | undefined> {
  const hash = createHash('sha256')
  if (!await hashIndexKeys(path.join(storePath, 'index.db'), hash)) return undefined

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

async function hashIndexKeys(indexPath: string, hash: Hash): Promise<boolean> {
  if (!await exists(indexPath)) return false
  const url = pathToFileURL(indexPath)
  url.searchParams.set('immutable', '1')
  try {
    const db = new DatabaseSync(url.href, { readOnly: true })
    try {
      hash.update('index\n')
      for (const row of db.prepare('SELECT key FROM package_index ORDER BY key').iterate()) {
        hash.update(`${String(row.key)}\n`)
      }
      return true
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

async function exists(file: string) {
  return access(file).then(() => true, () => false)
}

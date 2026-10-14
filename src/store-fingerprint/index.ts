import { createHash } from 'crypto'
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
  const indexKeys = await readIndexKeys(path.join(storePath, 'index.db'))
  if (!indexKeys) return undefined

  const hash = createHash('sha256')
  hash.update(`index:${indexKeys.join(',')}\n`)

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

async function readIndexKeys(indexPath: string): Promise<string[] | undefined> {
  if (!await exists(indexPath)) return undefined
  const url = pathToFileURL(indexPath)
  url.searchParams.set('immutable', '1')
  try {
    const db = new DatabaseSync(url.href, { readOnly: true })
    try {
      return db.prepare('SELECT key FROM package_index ORDER BY key').all().map(row => String(row.key))
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

async function exists(file: string) {
  return access(file).then(() => true, () => false)
}

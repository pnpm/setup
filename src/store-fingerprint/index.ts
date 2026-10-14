import { createHash } from 'crypto'
import { lstat, readdir } from 'fs/promises'
import path from 'path'

export async function fingerprintStore(storePath: string): Promise<string | undefined> {
  const buckets = await readdir(path.join(storePath, 'files')).catch(() => [])
  const entries = ['index.db', 'index.db-wal', ...buckets.sort().map(bucket => path.join('files', bucket))]
  const stats = await Promise.all(entries.map(entry => lstat(path.join(storePath, entry)).catch(() => undefined)))
  if (!stats[0]) return undefined
  // An empty write-ahead log holds no pages, and SQLite deletes it when the last connection closes.
  if (stats[1]?.size === 0) stats[1] = undefined

  const hash = createHash('sha256')
  entries.forEach((entry, i) => {
    hash.update(`${entry}:${stats[i] ? `${stats[i].size}:${stats[i].mtimeMs}` : 'none'}\n`)
  })
  return hash.digest('hex')
}

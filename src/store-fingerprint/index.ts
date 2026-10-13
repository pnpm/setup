import { createHash } from 'crypto'
import { access, readdir } from 'fs/promises'
import path from 'path'

export async function fingerprintStore(storePath: string): Promise<string | undefined> {
  if (!await exists(path.join(storePath, 'index.db'))) return undefined

  const filesPath = path.join(storePath, 'files')
  const buckets = (await readdir(filesPath).catch(() => [])).sort()
  const names = await Promise.all(
    buckets.map(async bucket => (await readdir(path.join(filesPath, bucket)).catch(() => [])).sort()),
  )

  const hash = createHash('sha256')
  buckets.forEach((bucket, i) => {
    hash.update(`${bucket}:${names[i].join(',')}\n`)
  })
  return hash.digest('hex')
}

async function exists(file: string) {
  return access(file).then(() => true, () => false)
}

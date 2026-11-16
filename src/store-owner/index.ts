import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Each invocation of the action keeps its own state, so the post step of an
 * earlier invocation cannot see that a later one in the same job restored and
 * installed into the same store. When the store is in `dest`, as it is by
 * default outside a container, that later invocation even deleted it. A marker file
 * per store path, outside the store so it is never cached, records the latest
 * invocation that claimed it.
 */
export async function claimStore (storePath: string, invocationId: string): Promise<void> {
  await writeFile(markerPath(storePath), invocationId)
}

/** True unless a later invocation claimed the store. */
export async function ownsStore (storePath: string, invocationId: string): Promise<boolean> {
  try {
    return await readFile(markerPath(storePath), 'utf8') === invocationId
  } catch {
    return true
  }
}

function markerPath (storePath: string): string {
  const storeHash = createHash('sha256').update(storePath).digest('hex')
  return path.join(process.env.RUNNER_TEMP || os.tmpdir(), `setup-pnpm-store-owner-${storeHash}`)
}

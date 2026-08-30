import { createHash } from 'crypto'
import type { RuntimeRequest } from '../install-runtime'

export function getCacheKeyPrefix(
  runnerOs: string | undefined,
  architecture: string,
  runtimes: readonly RuntimeRequest[],
): string {
  const runtimeKey = runtimes.length > 0 ? hashRuntimes(runtimes) : 'no-runtime'
  return `pnpm-cache-${runnerOs}-${architecture}-${runtimeKey}-`
}

export function getSaveCacheKey(
  lockfileKeyPrefix: string,
  resolvedRuntimes: readonly RuntimeRequest[],
  runId: string,
): string {
  const runtimeVersionKey = resolvedRuntimes.length > 0 ? `${hashRuntimes(resolvedRuntimes)}-` : ''
  return `${lockfileKeyPrefix}${runtimeVersionKey}${runId}`
}

/**
 * `restoreCache`'s fallback list, most specific first: an exact lockfile
 * match, then any store for this OS/arch/runtime combination regardless of
 * lockfile. `lockfileKeyPrefix` also has to be passed as the primary key —
 * see `getSaveCacheKey` — but it can never match there, since every save
 * appends a run id; the match always happens here, in the fallback search.
 */
export function getRestoreKeys(lockfileKeyPrefix: string, keyPrefix: string): string[] {
  return [lockfileKeyPrefix, keyPrefix]
}

/** True only when the restored store was cached for this exact lockfile, not a fallback match. */
export function isLockfileExactHit(restoredKey: string | undefined, lockfileKeyPrefix: string): boolean {
  return restoredKey?.startsWith(lockfileKeyPrefix) ?? false
}

/**
 * Sorted by name so that reordering `devEngines.runtime` — which produces the
 * same store — keeps hitting the same cache. Names are unique per request
 * list, so the sort is a total order.
 */
function hashRuntimes(runtimes: readonly RuntimeRequest[]): string {
  const identity = [...runtimes]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(runtime => `${runtime.name}@${runtime.version}`)
    .join('\n')
  return hashCacheKeyPart(identity)
}

function hashCacheKeyPart(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

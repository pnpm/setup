import { createHash } from 'crypto'
import type { RuntimeRequest } from '../install-runtime'

export function getCacheKeyPrefix(
  runnerOs: string | undefined,
  architecture: string,
  runtime: RuntimeRequest | undefined,
): string {
  const runtimeKey = runtime
    ? hashCacheKeyPart(`${runtime.name}@${runtime.version}`)
    : 'no-runtime'
  return `pnpm-cache-${runnerOs}-${architecture}-${runtimeKey}-`
}

export function getPrimaryCacheKey(
  keyPrefix: string,
  fileHash: string,
  resolvedRuntimeVersion?: string,
): string {
  const runtimeVersionKey = resolvedRuntimeVersion
    ? `${hashCacheKeyPart(resolvedRuntimeVersion)}-`
    : ''
  return `${keyPrefix}${runtimeVersionKey}${fileHash}`
}

function hashCacheKeyPart(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

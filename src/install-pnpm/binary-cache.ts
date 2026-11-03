import { restoreCache, saveCache } from '@actions/cache'
import { info, warning } from '@actions/core'
import semver from 'semver'

/**
 * The key the downloaded executable is cached under, or `undefined` when the
 * spec is a range or dist-tag: only an exact version names the executable
 * before the registry has been asked, and a cache that had to ask first would
 * save little.
 *
 * glibc and musl hosts get different executables from the same version, so
 * the libc is part of the key. The restore path is part of the cache version
 * that `@actions/cache` matches on, so a different `dest` never restores
 * another job's directory.
 */
export function binaryCacheKey (
  versionSpec: string,
  platform: string = process.platform,
  arch: string = process.arch,
  musl: boolean = isMusl()
): string | undefined {
  const version = semver.valid(versionSpec)
  if (!version) return undefined
  return `pnpm-binary-${platform}-${arch}${musl ? '-musl' : ''}-${version}`
}

/** Whether `dest` was restored from the cache. */
export async function restoreBinary (dest: string, key: string): Promise<boolean> {
  try {
    const restoredKey = await restoreCache([dest], key)
    if (restoredKey) {
      info(`pnpm restored from cache key: ${restoredKey}`)
      return true
    }
    info('pnpm executable cache is not found')
  } catch (error) {
    warning(`Failed to restore the pnpm executable from the cache: ${(error as Error).message}`)
  }
  return false
}

/**
 * Called right after the download is verified and before anything else runs
 * from `dest`, so the cache holds exactly what get-pnpm checked against npm's
 * signature, and not runtimes or shims installed into it later.
 */
export async function saveBinary (dest: string, key: string): Promise<void> {
  try {
    const cacheId = await saveCache([dest], key)
    if (cacheId === -1) return
    info(`pnpm executable cached with the key: ${key}`)
  } catch (error) {
    warning(`Failed to cache the pnpm executable: ${(error as Error).message}`)
  }
}

/** Mirrors get-pnpm's own probe, which picks the musl executable on these hosts. */
function isMusl (): boolean {
  if (process.platform !== 'linux') return false
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
    return report?.header != null && !report.header.glibcVersionRuntime
  } catch {
    return false
  }
}

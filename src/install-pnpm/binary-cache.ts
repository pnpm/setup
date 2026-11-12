import path from 'node:path'

import { isFeatureAvailable, restoreCache, saveCache } from '@actions/cache'
import { info, warning } from '@actions/core'
import semver from 'semver'

/**
 * The key the downloaded executable is cached under, or `undefined` when the
 * spec is a range or dist-tag: only an exact version names the executable
 * before the registry has been asked, and a cache that had to ask first would
 * save little.
 *
 * `arch` is the tool cache architecture, which has a `-musl` suffix on musl
 * hosts: glibc and musl hosts get different executables from the same
 * version.
 */
export function binaryCacheKey (
  versionSpec: string,
  arch: string,
  platform: string = process.platform
): string | undefined {
  const version = semver.valid(versionSpec)
  if (!version) return undefined
  return `pnpm-binary-${platform}-${arch}-${version}`
}

/**
 * The directory the executable is downloaded into and restored into when it
 * is cached, or `undefined` when the GitHub Actions cache is not available.
 *
 * `@actions/cache` matches entries on the paths they were saved from, so this
 * directory has to be the same in every job.
 */
export function binaryCacheDir (): string | undefined {
  if (!process.env.RUNNER_TEMP || !isFeatureAvailable()) return undefined
  return path.join(process.env.RUNNER_TEMP, 'setup-pnpm-executable')
}

/** Whether `dir` was restored from the cache. */
export async function restoreBinary (dir: string, key: string): Promise<boolean> {
  try {
    const restoredKey = await restoreCache([dir], key)
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
 * Called right after the download is verified and before anything runs from
 * `dir`, so the cache holds exactly what get-pnpm checked against npm's
 * signature.
 */
export async function saveBinary (dir: string, key: string): Promise<void> {
  try {
    const cacheId = await saveCache([dir], key)
    if (cacheId === -1) return
    info(`pnpm executable cached with the key: ${key}`)
  } catch (error) {
    warning(`Failed to cache the pnpm executable: ${(error as Error).message}`)
  }
}

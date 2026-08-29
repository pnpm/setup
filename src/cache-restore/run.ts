import { restoreCache } from '@actions/cache'
import { debug, info, saveState, setOutput } from '@actions/core'
import { getExecOutput } from '@actions/exec'
import { hashFiles } from '@actions/glob'
import os from 'os'
import { Inputs } from '../inputs'
import { RuntimeRequest } from '../install-runtime'
import { restoreVerificationCache } from '../lockfile-verification-cache'
import { removeWindowsExtendedPathPrefix } from '../windows-path'
import { getCacheKeyPrefix, getSaveCacheKey } from './keys'

export interface RestoredCache {
  readonly lockfileKeyPrefix: string
  readonly restoredKey: string | undefined
}

export async function runRestoreCache(
  inputs: Inputs,
  runtimes: readonly RuntimeRequest[],
): Promise<RestoredCache | undefined> {
  const fileHash = await hashFiles(inputs.cacheDependencyPath)
  if (!fileHash) {
    // Both caches are keyed on the lockfile, so neither can be restored
    // without one. Only the store cache was asked for by name.
    if (inputs.cache) {
      throw new Error('Some specified paths were not resolved, unable to cache dependencies.')
    }
    return
  }

  // Restored whether or not the store is cached: the log is a fraction of a
  // kilobyte, and without it pnpm re-checks every lockfile entry against the
  // registry on each run — seconds even on a repository that configures no
  // supply-chain policies.
  await restoreVerificationCache(fileHash)

  if (!inputs.cache) return

  return runRestoreStoreCache(fileHash, runtimes)
}

async function runRestoreStoreCache(
  fileHash: string,
  runtimes: readonly RuntimeRequest[],
): Promise<RestoredCache> {
  const cachePath = await getCacheDirectory()
  saveState('cache_path', cachePath)

  const keyPrefix = getCacheKeyPrefix(process.env.RUNNER_OS, os.arch(), runtimes)
  const lockfileKeyPrefix = `${keyPrefix}${fileHash}-`

  // We don't need to download everything again if only one dependency changed.
  // We can still re-use a previous store to cache the rest of the unchanged
  // dependencies. Saves are keyed by run id (see getSaveCacheKey), so
  // lockfileKeyPrefix itself never matches exactly: every restore falls
  // through to the prefix search and picks up the most recent matching entry.
  const restoreKeys = [lockfileKeyPrefix, keyPrefix]

  const restoredKey = await restoreCache([cachePath], lockfileKeyPrefix, restoreKeys)

  if (!restoredKey) {
    info(`Cache is not found`)
    return { lockfileKeyPrefix, restoredKey: undefined }
  }

  info(`Cache restored from key: ${restoredKey}`)
  return { lockfileKeyPrefix, restoredKey }
}

export function finalizeCache(cache: RestoredCache, resolvedRuntimes: readonly RuntimeRequest[]) {
  const runId = process.env.GITHUB_RUN_ID ?? ''
  const primaryKey = getSaveCacheKey(cache.lockfileKeyPrefix, resolvedRuntimes, runId)
  debug(`Primary key is ${primaryKey}`)
  saveState('cache_primary_key', primaryKey)

  // No save is ever restored within its own run, so "hit" here means the
  // lockfile matched exactly (best case), not that a save was skipped.
  setOutput('cache-hit', cache.restoredKey?.startsWith(cache.lockfileKeyPrefix) ?? false)
}

async function getCacheDirectory() {
  const { stdout } = await getExecOutput('pnpm store path')
  const cacheFolderPath = removeWindowsExtendedPathPrefix(stdout.trim())
  debug(`Cache folder is set to "${cacheFolderPath}"`)
  return cacheFolderPath
}

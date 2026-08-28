import { restoreCache } from '@actions/cache'
import { debug, info, saveState, setOutput } from '@actions/core'
import { getExecOutput } from '@actions/exec'
import { hashFiles } from '@actions/glob'
import os from 'os'
import { Inputs } from '../inputs'
import { RuntimeRequest } from '../install-runtime'
import { restoreVerificationCache } from '../lockfile-verification-cache'
import { removeWindowsExtendedPathPrefix } from '../windows-path'
import { getCacheKeyPrefix, getPrimaryCacheKey } from './keys'

export interface RestoredCache {
  readonly fileHash: string
  readonly keyPrefix: string
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
  const provisionalKey = getPrimaryCacheKey(keyPrefix, fileHash)
  debug(`Provisional cache key is ${provisionalKey}`)
  saveState('cache_provisional_key', provisionalKey)

  // We don't need to download everything again if only one dependency changed
  // We can still re-use previous store to cache the rest of the unchanged dependencies
  const restoreKeys = [keyPrefix]

  const restoredKey = await restoreCache([cachePath], provisionalKey, restoreKeys)

  if (!restoredKey) {
    info(`Cache is not found`)
    return { fileHash, keyPrefix, restoredKey: undefined }
  }

  saveState('cache_restored_key', restoredKey)
  info(`Cache restored from key: ${restoredKey}`)
  return { fileHash, keyPrefix, restoredKey }
}

export function finalizeCache(cache: RestoredCache, resolvedRuntimes: readonly RuntimeRequest[]) {
  const primaryKey = getPrimaryCacheKey(
    cache.keyPrefix,
    cache.fileHash,
    resolvedRuntimes,
  )
  debug(`Primary key is ${primaryKey}`)
  saveState('cache_primary_key', primaryKey)
  setOutput('cache-hit', cache.restoredKey === primaryKey)
}

async function getCacheDirectory() {
  const { stdout } = await getExecOutput('pnpm store path')
  const cacheFolderPath = removeWindowsExtendedPathPrefix(stdout.trim())
  debug(`Cache folder is set to "${cacheFolderPath}"`)
  return cacheFolderPath
}

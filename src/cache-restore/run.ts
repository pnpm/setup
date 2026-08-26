import { restoreCache } from '@actions/cache'
import { debug, info, saveState, setOutput } from '@actions/core'
import { getExecOutput } from '@actions/exec'
import { hashFiles } from '@actions/glob'
import os from 'os'
import { Inputs } from '../inputs'
import { RuntimeRequest } from '../install-runtime'
import { getCacheKeyPrefix, getPrimaryCacheKey } from './keys'

export interface RestoredCache {
  readonly fileHash: string
  readonly keyPrefix: string
  readonly restoredKey: string | undefined
}

export async function runRestoreCache(
  inputs: Inputs,
  runtime: RuntimeRequest | undefined,
): Promise<RestoredCache> {
  const cachePath = await getCacheDirectory()
  saveState('cache_path', cachePath)

  const fileHash = await hashFiles(inputs.cacheDependencyPath)
  if (!fileHash) {
    throw new Error('Some specified paths were not resolved, unable to cache dependencies.')
  }

  const keyPrefix = getCacheKeyPrefix(process.env.RUNNER_OS, os.arch(), runtime)
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

export function finalizeCache(cache: RestoredCache, resolvedRuntimeVersion: string | undefined) {
  const primaryKey = getPrimaryCacheKey(
    cache.keyPrefix,
    cache.fileHash,
    resolvedRuntimeVersion,
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

/**
 * `pnpm store path` may return an extended-length path on Windows. The `?` in
 * that prefix is interpreted as a wildcard by `@actions/cache`, which rejects
 * it as a glob in the root segment. Cache APIs do not need the extended-length
 * form, so convert it back to a regular drive or UNC path.
 */
export function removeWindowsExtendedPathPrefix(cachePath: string): string {
  const extendedPathPrefix = '\\\\?\\'
  if (!cachePath.startsWith(extendedPathPrefix)) return cachePath

  const pathWithoutPrefix = cachePath.slice(extendedPathPrefix.length)
  const uncPrefix = 'UNC\\'
  if (pathWithoutPrefix.toUpperCase().startsWith(uncPrefix)) {
    return `\\\\${pathWithoutPrefix.slice(uncPrefix.length)}`
  }
  return pathWithoutPrefix
}

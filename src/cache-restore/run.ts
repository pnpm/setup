import { restoreCache } from '@actions/cache'
import { debug, info, saveState, setOutput } from '@actions/core'
import { getExecOutput } from '@actions/exec'
import { hashFiles } from '@actions/glob'
import os from 'os'
import { Inputs } from '../inputs'

export async function runRestoreCache(inputs: Inputs) {
  const cachePath = await getCacheDirectory()
  saveState('cache_path', cachePath)

  const fileHash = await hashFiles(inputs.cacheDependencyPath)
  if (!fileHash) {
    throw new Error('Some specified paths were not resolved, unable to cache dependencies.')
  }

  const primaryKey = `pnpm-cache-${process.env.RUNNER_OS}-${os.arch()}-${fileHash}`
  debug(`Primary key is ${primaryKey}`)
  saveState('cache_primary_key', primaryKey)

  // We don't need to download everything again if only one dependency changed
  // We can still re-use previous store to cache the rest of the unchanged dependencies
  const restoreKeys = [
    `pnpm-cache-${process.env.RUNNER_OS}-${os.arch()}-`
  ];

  let cacheKey = await restoreCache([cachePath], primaryKey, restoreKeys)

  setOutput('cache-hit', cacheKey === primaryKey)

  if (!cacheKey) {
    info(`Cache is not found`)
    return
  }

  saveState('cache_restored_key', cacheKey)
  info(`Cache restored from key: ${cacheKey}`)
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

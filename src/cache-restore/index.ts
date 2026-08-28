import { isFeatureAvailable } from '@actions/cache'
import { endGroup, startGroup, warning } from '@actions/core'
import { Inputs } from '../inputs'
import { RuntimeRequest } from '../install-runtime'
import { finalizeCache, RestoredCache, runRestoreCache } from './run'

export async function restoreCache(
  inputs: Inputs,
  runtimes: readonly RuntimeRequest[],
): Promise<RestoredCache | undefined> {
  if (!isFeatureAvailable()) {
    // The lockfile verification cache is restored regardless of `cache`, so
    // this is not gated on it — but only a workflow that asked for a cache
    // by name should hear that it is unavailable.
    if (inputs.cache) {
      warning('Cache is not available, skipping cache restoration')
    }
    return
  }

  startGroup('Restoring cache...')
  const restoredCache = await runRestoreCache(inputs, runtimes)
  endGroup()
  return restoredCache
}

export { finalizeCache }
export default restoreCache

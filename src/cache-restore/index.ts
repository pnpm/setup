import { isFeatureAvailable } from '@actions/cache'
import { endGroup, startGroup, warning } from '@actions/core'
import { Inputs } from '../inputs'
import { RuntimeRequest } from '../install-runtime'
import { finalizeCache, RestoredCache, runRestoreCache } from './run'

export async function restoreCache(
  inputs: Inputs,
  runtime: RuntimeRequest | undefined,
): Promise<RestoredCache | undefined> {
  if (!inputs.cache) return

  if (!isFeatureAvailable()) {
    warning('Cache is not available, skipping cache restoration')
    return
  }

  startGroup('Restoring cache...')
  const restoredCache = await runRestoreCache(inputs, runtime)
  endGroup()
  return restoredCache
}

export { finalizeCache }
export default restoreCache

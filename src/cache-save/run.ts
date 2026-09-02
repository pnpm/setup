import { saveCache } from '@actions/cache'
import { getState, info } from '@actions/core'

export async function runSaveCache() {
  const primaryKey = getState('cache_primary_key')
  const cachePath = getState('cache_path')

  // The main step records the primary key only once the runtime version is
  // known. Without it the run failed before the key was settled, and the
  // store was left in whatever state that failure produced.
  if (!primaryKey) {
    info('No final cache key was recorded, not saving cache.')
    return
  }

  const cacheId = await saveCache([cachePath], primaryKey)
  if (cacheId == -1) return

  info(`Cache saved with the key: ${primaryKey}`)
}

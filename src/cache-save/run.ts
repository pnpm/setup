import { saveCache } from '@actions/cache'
import { getState, info } from '@actions/core'

export async function runSaveCache() {
  const state = getState('cache_restored_key')
  const primaryKey = getState('cache_primary_key')
  const cachePath = getState('cache_path')

  // The main step records the final key only once the runtime version is
  // known. Without it the run failed before the key was settled, and the
  // store was left in whatever state that failure produced. Saving it under
  // the provisional restore key would publish that store under a key later
  // runs match *exactly*, shadowing the complete cache held under the
  // versioned key — and cache keys are immutable, so it would not heal.
  if (!primaryKey) {
    info('No final cache key was recorded, not saving cache.')
    return
  }

  if (primaryKey === state) {
    info(`Cache hit occurred on the primary key ${primaryKey}, not saving cache.`)
    return
  }

  const cacheId = await saveCache([cachePath], primaryKey)
  if (cacheId == -1) return

  info(`Cache saved with the key: ${primaryKey}`)
}

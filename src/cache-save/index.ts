import { setFailed } from '@actions/core'

import { Inputs } from '../inputs/index.js'
import { runSaveCache } from './run.js'

export async function saveCache (inputs: Inputs): Promise<void> {
  if (!inputs.cache || !inputs.saveCache) return

  try {
    await runSaveCache(inputs)
  } catch (error) {
    setFailed((error as Error).message)
  }
}

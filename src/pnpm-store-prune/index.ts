import { warning, startGroup, endGroup } from '@actions/core'
import { exec } from '@actions/exec'
import { Inputs } from '../inputs'

export async function pruneStore(inputs: Inputs) {
  if (!inputs.cache) {
    // Without caching, the store is ephemeral with the runner — no need to prune.
    return
  }

  startGroup('Running pnpm store prune...')
  try {
    // A later `pnpm self-update` puts its shim ahead of the original binary
    // on PATH. The toolkit preserves that order and supports Windows .cmd
    // shims without Node's deprecated `shell: true` + args combination.
    await exec('pnpm', ['store', 'prune'])
  } catch (error) {
    warning(error instanceof Error ? error : String(error))
  } finally {
    endGroup()
  }
}

export default pruneStore

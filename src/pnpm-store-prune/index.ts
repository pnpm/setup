import { warning, startGroup, endGroup } from '@actions/core'
import { spawnSync } from 'child_process'
import { Inputs } from '../inputs'

export function pruneStore(inputs: Inputs) {
  if (!inputs.cache) {
    // Without caching, the store is ephemeral with the runner — no need to prune.
    return
  }

  startGroup('Running pnpm store prune...')
  const { error, status } = spawnSync('pnpm', ['store', 'prune'], {
    stdio: 'inherit',
    shell: true,
  })
  endGroup()

  if (error) {
    warning(error)
    return
  }

  if (status) {
    warning(`command pnpm store prune exits with code ${status}`)
    return
  }
}

export default pruneStore

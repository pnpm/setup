import { setFailed, saveState, getState } from '@actions/core'
import restoreCache from './cache-restore'
import saveCache from './cache-save'
import getInputs, { Inputs } from './inputs'
import installPnpm from './install-pnpm'
import { resolveRuntimeRequest, installRuntime, InstalledRuntime, logSkippedRuntime } from './install-runtime'
import setOutputs from './outputs'
import pnpmInstall from './pnpm-install'
import pruneStore from './pnpm-store-prune'

async function main() {
  if (getState('is_post') === 'true') {
    await runPost()
  } else {
    await runMain()
  }
}

async function runMain() {
  const inputs = getInputs()
  saveState('inputs', inputs)
  saveState('is_post', 'true')

  const result = await installPnpm(inputs)
  if (result === undefined) return
  console.log('Installation Completed!')

  let runtime: InstalledRuntime | undefined
  const request = resolveRuntimeRequest(inputs)
  if (request) {
    runtime = await installRuntime(request, result.binDest)
    if (runtime === undefined) return
  } else {
    logSkippedRuntime()
  }

  setOutputs(inputs, result.binDest, runtime)

  await restoreCache(inputs)

  pnpmInstall(inputs)
}

async function runPost() {
  const inputs = JSON.parse(getState('inputs')) as Inputs
  pruneStore(inputs)
  await saveCache(inputs)
}

main().catch(error => {
  console.error(error)
  setFailed(error)
})

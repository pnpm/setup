import { setFailed, saveState, getState } from '@actions/core'
import restoreCache from './cache-restore'
import saveCache from './cache-save'
import getInputs, { Inputs } from './inputs'
import installPnpm from './install-pnpm'
import {
  resolveRuntimeRequests,
  installRuntime,
  InstalledRuntime,
  keepInstalledRuntimesAuthoritative,
  logSkippedRuntime,
} from './install-runtime'
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
  console.log('Installation Completed!')

  const runtimes: InstalledRuntime[] = []
  const requests = resolveRuntimeRequests(inputs)
  for (const request of requests) {
    const runtime = await installRuntime(request, result.binDest)
    if (runtime === undefined) return
    runtimes.push(runtime)
  }
  if (runtimes.length > 0) {
    keepInstalledRuntimesAuthoritative(runtimes)
  } else {
    logSkippedRuntime()
  }

  setOutputs(inputs, result.binDest, runtimes)

  await restoreCache(inputs)

  if (inputs.install) {
    pnpmInstall(inputs, runtimes.length > 0)
  }
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

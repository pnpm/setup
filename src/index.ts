import { setFailed, saveState, getState } from '@actions/core'
import restoreCache, { finalizeCache } from './cache-restore'
import saveCache from './cache-save'
import getInputs, { Inputs } from './inputs'
import installPnpm from './install-pnpm'
import {
  getInstalledRuntimeVersions,
  resolveRuntimeRequests,
  installRuntime,
  InstalledRuntime,
  keepInstalledRuntimesAuthoritative,
  logSkippedRuntime,
} from './install-runtime'
import { saveVerificationCache, snapshotVerificationLog } from './lockfile-verification-cache'
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

  const requests = resolveRuntimeRequests(inputs)
  const restoredCache = await restoreCache(inputs, requests)

  const runtimes: InstalledRuntime[] = []
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

  // `pnpm runtime set` takes a selector, so `runtimes` holds what was asked
  // for — `node@lts`, `node@24`. Both the outputs and the cache key promise
  // the version that actually landed, so read it back once and use it for
  // both. Falling back to the selector also keeps the final cache key
  // distinct from the provisional key the restore probed with; that key must
  // never be written to, or later runs would match it exactly and stop
  // falling back to the prefix search that finds the versioned caches.
  const installedVersions = await getInstalledRuntimeVersions(
    runtimes.map(runtime => runtime.name),
    result.binDest,
  )
  const installed = runtimes.map(runtime => ({
    name: runtime.name,
    version: installedVersions.get(runtime.name) ?? runtime.version,
  }))

  if (restoredCache) {
    finalizeCache(restoredCache, installed)
  }

  setOutputs(inputs, result.binDest, installed)

  // Taken after the runtime installs, which append a verdict each, so the
  // bound below covers only the install this action is about to run.
  snapshotVerificationLog()

  if (inputs.install) {
    pnpmInstall(inputs, runtimes.length > 0)
    // Uploaded here rather than in the post step so that whatever the job runs
    // next cannot alter what later jobs restore. When `install` is false the
    // log is not complete yet — the job installs in a step of its own, and the
    // post step is the first moment it is known to be done.
    await saveVerificationCache(1)
  }
}

async function runPost() {
  const inputs = JSON.parse(getState('inputs')) as Inputs
  // Covers a job that installs in a later step of its own; when this action
  // installed, the log was already saved then. Runs before the prune because
  // pnpm versions before pnpm/pnpm#13893 delete the log during one.
  await saveVerificationCache()
  pruneStore(inputs)
  await saveCache(inputs)
}

main().catch(error => {
  console.error(error)
  setFailed(error)
})

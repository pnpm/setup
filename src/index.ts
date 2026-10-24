import { getState, saveState, setFailed } from '@actions/core'

import { finalizeCache, fingerprintRestoredStore, restoreCache } from './cache-restore/index.js'
import { saveCache } from './cache-save/index.js'
import { flushAndExit } from './flush-and-exit.js'
import { getInputs, Inputs } from './inputs/index.js'
import { install as installPnpm } from './install-pnpm/index.js'
import {
  getInstalledRuntimeVersions,
  InstalledRuntime,
  installRuntime,
  keepInstalledRuntimesAuthoritative,
  logSkippedRuntime,
  resolveRuntimeRequests,
} from './install-runtime/index.js'
import { saveVerificationCache, snapshotVerificationLog } from './lockfile-verification-cache/index.js'
import { setOutputs } from './outputs/index.js'
import { runPnpmInstall as pnpmInstall } from './pnpm-install/index.js'

async function main () {
  if (getState('is_post') === 'true') {
    await runPost()
  } else {
    await runMain()
  }
}

async function runMain () {
  const inputs = getInputs()
  saveState('inputs', inputs)
  saveState('is_post', 'true')

  const result = await installPnpm(inputs)
  console.log('Installation Completed!')

  const requests = resolveRuntimeRequests(inputs)
  const restoredCache = await restoreCache(inputs, requests)

  const runtimes: InstalledRuntime[] = []
  for (const request of requests) {
    // eslint-disable-next-line no-await-in-loop -- runtimes install one at a time, in declaration order
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
  // both. Fall back to the selector if the installed version cannot be read.
  const installedVersions = await getInstalledRuntimeVersions(
    runtimes.map(runtime => runtime.name),
    result.binDest
  )
  const installed = runtimes.map(runtime => ({
    name: runtime.name,
    version: installedVersions.get(runtime.name) ?? runtime.version,
  }))

  if (restoredCache) {
    finalizeCache(restoredCache, installed)
    if (inputs.saveCache) await fingerprintRestoredStore(restoredCache, installed)
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

async function runPost () {
  const inputs = JSON.parse(getState('inputs')) as Inputs
  // Covers a job that installs in a later step of its own; when this action
  // installed, the log was already saved then. Runs before saveCache, which
  // prunes the store, because pnpm versions before pnpm/pnpm#13893 delete the
  // log during a prune.
  await saveVerificationCache()
  await saveCache(inputs)
}

// A failed cache download leaves its remaining block requests open, and they
// keep node alive after `main` settles.
main()
  .catch(error => {
    console.error(error)
    setFailed(error)
  })
  .finally(flushAndExit)

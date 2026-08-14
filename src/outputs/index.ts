import { setOutput } from '@actions/core'
import { Inputs } from '../inputs'
import { InstalledRuntime } from '../install-runtime'

export function setOutputs(inputs: Inputs, binDest: string, runtimes: readonly InstalledRuntime[]) {
  // NOTE: addPath is already called in installPnpm — do not call it again
  // here, as a second addPath would shadow the correct entry on Windows.
  const firstRuntime = runtimes[0]
  setOutput('dest', inputs.dest)
  setOutput('bin-dest', binDest)
  setOutput('runtime-name', firstRuntime?.name ?? '')
  setOutput('runtime-version', firstRuntime?.version ?? '')
  setOutput('runtimes', JSON.stringify(runtimes))
}

export default setOutputs

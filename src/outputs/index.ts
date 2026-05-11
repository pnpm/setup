import { setOutput } from '@actions/core'
import { Inputs } from '../inputs'
import { InstalledRuntime } from '../install-runtime'

export function setOutputs(inputs: Inputs, binDest: string, runtime: InstalledRuntime | undefined) {
  // NOTE: addPath is already called in installPnpm — do not call it again
  // here, as a second addPath would shadow the correct entry on Windows.
  setOutput('dest', inputs.dest)
  setOutput('bin-dest', binDest)
  setOutput('runtime-name', runtime?.name ?? '')
  setOutput('runtime-version', runtime?.version ?? '')
}

export default setOutputs

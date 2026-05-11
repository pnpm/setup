import { setFailed, startGroup, endGroup } from '@actions/core'
import { Inputs } from '../inputs'
import runSelfInstaller, { SelfInstallerResult } from './run'

export { runSelfInstaller }

export async function install(inputs: Inputs): Promise<SelfInstallerResult | undefined> {
  startGroup('Running self-installer...')
  const result = await runSelfInstaller(inputs)
  endGroup()
  if (result.exitCode) {
    setFailed(`Something went wrong, self-installer exits with code ${result.exitCode}`)
    return undefined
  }
  return result
}

export default install

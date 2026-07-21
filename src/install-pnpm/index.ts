import { endGroup, startGroup } from '@actions/core'
import { Inputs } from '../inputs'
import runSelfInstaller, { SelfInstallerResult } from './run'

export { runSelfInstaller }

export async function install(inputs: Inputs): Promise<SelfInstallerResult> {
  startGroup('Installing pnpm...')
  try {
    return await runSelfInstaller(inputs)
  } finally {
    endGroup()
  }
}

export default install

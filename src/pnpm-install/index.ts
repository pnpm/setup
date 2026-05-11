import { info, setFailed, startGroup, endGroup } from '@actions/core'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { Inputs } from '../inputs'
import { patchPnpmEnv } from '../utils'

export function runPnpmInstall(inputs: Inputs) {
  // Skip if there's no package.json in the workspace — the action is also
  // useful for jobs that just want pnpm + a runtime on PATH (e.g. running
  // global tooling, ad-hoc scripts) and have no manifest to install.
  const { GITHUB_WORKSPACE } = process.env
  if (!GITHUB_WORKSPACE) {
    info('GITHUB_WORKSPACE is not set; skipping `pnpm install`.')
    return
  }
  const manifestPath = path.join(GITHUB_WORKSPACE, inputs.packageJsonFile)
  if (!existsSync(manifestPath)) {
    info(`No ${inputs.packageJsonFile} found in workspace; skipping \`pnpm install\`.`)
    return
  }

  startGroup('Running pnpm install...')
  const { error, status } = spawnSync('pnpm', ['install'], {
    stdio: 'inherit',
    cwd: GITHUB_WORKSPACE,
    shell: true,
    env: patchPnpmEnv(inputs),
  })
  endGroup()

  if (error) {
    setFailed(error)
    return
  }
  if (status) {
    setFailed(`pnpm install exited with status ${status}`)
  }
}

export default runPnpmInstall

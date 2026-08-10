import { info, setFailed, startGroup, endGroup } from '@actions/core'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { Inputs } from '../inputs'

export function runPnpmInstall(inputs: Inputs, runtimeInstalled = Boolean(inputs.runtime)) {
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

  // The requested runtimes were already installed via `pnpm runtime set`.
  // Prevent `pnpm install` from processing devEngines.runtime again.
  const args = ['install']
  if (runtimeInstalled) {
    args.push('--no-runtime')
  }

  // spawnSync inherits process.env, which already has $PNPM_HOME/bin and
  // $PNPM_HOME prepended via addPath() in install-pnpm — so the pnpm this
  // action installed (or a self-updated one) is the one that resolves.
  startGroup(`Running pnpm ${args.join(' ')}...`)
  const { error, status } = spawnSync('pnpm', args, {
    stdio: 'inherit',
    cwd: path.dirname(manifestPath),
    shell: true,
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

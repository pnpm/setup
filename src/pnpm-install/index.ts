import { info, setFailed, startGroup, endGroup } from '@actions/core'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { Inputs, InstallMode } from '../inputs'

export function runPnpmInstall(inputs: Inputs) {
  if (inputs.install === false) return

  const installArgs = buildArgs(inputs.install)
  const command = `pnpm ${installArgs.join(' ')}`

  // When the user pinned a runtime explicitly via the `runtime` input, we've
  // already installed it via `pnpm runtime set`. Pass `--no-runtime` to the
  // install so the explicit runtime isn't shadowed by a different version
  // from `devEngines.runtime` on the same install.
  const args = inputs.runtime ? [...installArgs, '--no-runtime'] : installArgs

  // Skip if there's no package.json in the workspace — the action is also
  // useful for jobs that just want pnpm + a runtime on PATH (e.g. running
  // global tooling, ad-hoc scripts) and have no manifest to install.
  const { GITHUB_WORKSPACE } = process.env
  if (!GITHUB_WORKSPACE) {
    info(`GITHUB_WORKSPACE is not set; skipping \`${command}\`.`)
    return
  }
  const manifestPath = path.join(GITHUB_WORKSPACE, inputs.packageJsonFile)
  if (!existsSync(manifestPath)) {
    info(`No ${inputs.packageJsonFile} found in workspace; skipping \`${command}\`.`)
    return
  }

  // spawnSync inherits process.env, which already has $PNPM_HOME/bin and
  // $PNPM_HOME prepended via addPath() in install-pnpm — so the pnpm this
  // action installed (or a self-updated one) is the one that resolves.
  startGroup(`Running pnpm ${args.join(' ')}...`)
  const { error, status } = spawnSync('pnpm', args, {
    stdio: 'inherit',
    cwd: GITHUB_WORKSPACE,
    shell: true,
  })
  endGroup()

  if (error) {
    setFailed(error)
    return
  }
  if (status) {
    setFailed(`${command} exited with status ${status}`)
  }
}

function buildArgs(mode: InstallMode): string[] {
  // `pnpm ci` is `pnpm clean` followed by `pnpm install --frozen-lockfile`;
  // it has been available since pnpm v11, the oldest version this action
  // installs, so no version gate is needed.
  const args = mode === 'ci' ? ['ci'] : ['install']
  if (mode === 'frozen-lockfile') {
    args.push('--frozen-lockfile')
  }
  return args
}

export default runPnpmInstall

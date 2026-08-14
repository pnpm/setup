import { info, setFailed, startGroup, endGroup } from '@actions/core'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { Inputs, InstallMode } from '../inputs'

export function runPnpmInstall(inputs: Inputs) {
  if (inputs.install === false) return

  const args = buildArgs(inputs.install)

  // When the user pinned a runtime explicitly via the `runtime` input, we've
  // already installed it via `pnpm runtime set`. Pass `--no-runtime` to the
  // install so the explicit runtime isn't shadowed by a different version
  // from `devEngines.runtime` on the same install.
  if (inputs.runtime) {
    args.push('--no-runtime')
  }

  // Every message below quotes this, so it has to be the command we actually
  // run — flags included.
  const command = `pnpm ${args.join(' ')}`

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
  startGroup(`Running ${command}...`)
  const { error, status, signal } = spawnSync('pnpm', args, {
    stdio: 'inherit',
    cwd: GITHUB_WORKSPACE,
    shell: true,
  })
  endGroup()

  if (error) {
    setFailed(error)
    return
  }
  // A process killed by a signal reports `status: null` with no `error`, so a
  // truthiness check on `status` alone would let that pass as a success.
  if (signal) {
    setFailed(`${command} was terminated by ${signal}`)
    return
  }
  if (status !== 0) {
    setFailed(`${command} exited with status ${status}`)
  }
}

function buildArgs(mode: InstallMode): string[] {
  // `pnpm ci` is `pnpm clean` followed by `pnpm install --frozen-lockfile`;
  // it has been available since pnpm v11, the oldest version this action
  // installs, so no version gate is needed.
  const args = mode === 'ci' ? ['ci'] : ['install']
  if (mode === 'require-lockfile') {
    args.push('--frozen-lockfile')
  }
  return args
}

export default runPnpmInstall

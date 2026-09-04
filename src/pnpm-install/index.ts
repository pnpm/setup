import { info, setFailed, startGroup, endGroup } from '@actions/core'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { Inputs } from '../inputs'

export function runPnpmInstall(inputs: Inputs, runtimeInstalled = Boolean(inputs.runtime)) {
  const args = ['install']
  if (inputs.requireLockfile) {
    args.push('--frozen-lockfile')
  }

  // The requested runtimes were already installed via `pnpm runtime set`.
  // Prevent `pnpm install` from processing devEngines.runtime again.
  if (runtimeInstalled) {
    args.push('--no-runtime')
  }

  // Every message below quotes this, so it has to name the command actually
  // run, flags included.
  const command = `pnpm ${args.join(' ')}`

  // Skip if there's no package.json in the workspace — the action is also
  // useful for jobs that just want pnpm + a runtime on PATH (e.g. running
  // global tooling, ad-hoc scripts) and have no manifest to install.
  const { GITHUB_WORKSPACE } = process.env
  if (!GITHUB_WORKSPACE) {
    info(`GITHUB_WORKSPACE is not set; skipping \`${command}\`.`)
    return
  }
  const manifestPath = path.resolve(GITHUB_WORKSPACE, inputs.packageJsonFile)
  if (!existsSync(manifestPath)) {
    info(`No ${inputs.packageJsonFile} found in workspace; skipping \`${command}\`.`)
    return
  }

  const workingDirectory = path.resolve(GITHUB_WORKSPACE, inputs.workingDirectory)

  // Answer this before running anything: a missing lockfile is the whole
  // reason `require-lockfile` exists, and pnpm's own error for it arrives
  // after an install that was never going to succeed.
  if (inputs.requireLockfile && !findLockfile(workingDirectory, GITHUB_WORKSPACE)) {
    setFailed(
      '`require-lockfile` is set but no pnpm-lock.yaml was found in ' +
      `${inputs.workingDirectory} or above it. Commit the lockfile, or unset ` +
      '`require-lockfile` to let pnpm resolve and write one.',
    )
    return
  }

  const pnpmBin = path.join(inputs.dest, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm')
  startGroup(`Running ${command}...`)
  const { error, status, signal } = spawnSync(pnpmBin, args, {
    stdio: 'inherit',
    cwd: workingDirectory,
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

/**
 * pnpm keeps the lockfile at the workspace root, which it finds by walking up
 * from wherever it runs — so a project that is a workspace member has its
 * lockfile above itself. Search the same way rather than only where the
 * install runs, or a member directory would be reported as having none.
 */
function findLockfile(from: string, workspaceRoot: string): string | undefined {
  let current = from
  for (;;) {
    const candidate = path.join(current, 'pnpm-lock.yaml')
    if (existsSync(candidate)) return candidate
    if (current === workspaceRoot) return undefined

    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export default runPnpmInstall

import { info, setFailed, startGroup, endGroup, warning } from '@actions/core'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { Inputs } from '../inputs'

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

  // When the user pinned a runtime explicitly via the `runtime` input, we've
  // already installed it via `pnpm runtime set` above. Pass `--no-runtime`
  // to `pnpm install` so the explicit node isn't shadowed by a different
  // version from `devEngines.runtime` on the same install. The flag was
  // introduced in pnpm v11.1.0 — older pnpm versions error on it, so we
  // gate the flag on the running pnpm's version.
  const args = ['install']
  if (inputs.runtime) {
    if (pnpmSupportsNoRuntime()) {
      args.push('--no-runtime')
    } else {
      warning(
        'The `runtime` input is set, but the active pnpm is < 11.1.0 and does not support `--no-runtime`. ' +
        'If `devEngines.runtime` is declared in package.json with `onFail: download`, `pnpm install` may shadow the runtime installed by the action. Upgrade pnpm to 11.1.0 or later to avoid this.',
      )
    }
  }

  // spawnSync inherits process.env, which already has $PNPM_HOME/bin and
  // $PNPM_HOME prepended via addPath() in install-pnpm. Do NOT pass a hand-
  // patched env that adds node_modules/.bin to the front — on Windows
  // standalone, .bin/pnpm.cmd is an npm shim pointing at the BOOTSTRAP pnpm,
  // which would shadow the self-updated one and break newer-pnpm-only flags
  // like --no-runtime.
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
    setFailed(`pnpm install exited with status ${status}`)
  }
}

function pnpmSupportsNoRuntime(): boolean {
  // Detect via `pnpm --version`. Spawn through shell to match how the install
  // step resolves pnpm — same PATH precedence, same binary.
  const result = spawnSync('pnpm', ['--version'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  })
  if (result.error || result.status !== 0) return false
  const out = (result.stdout?.toString() ?? '').trim()
  const m = out.match(/^(\d+)\.(\d+)\.\d+/)
  if (!m) return false
  const major = parseInt(m[1], 10)
  const minor = parseInt(m[2], 10)
  // --no-runtime landed in pnpm 11.1.0
  return major > 11 || (major === 11 && minor >= 1)
}

export default runPnpmInstall

import { exportVariable, setFailed, startGroup, endGroup, info } from '@actions/core'
import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import path from 'path'
import util from 'util'
import { parse as parseYaml } from 'yaml'
import { Inputs, RuntimeName } from '../inputs'

const SUPPORTED_RUNTIMES: ReadonlySet<RuntimeName> = new Set(['node', 'bun', 'deno'])

// The names pnpm reads the `globalShims` setting from, in the order pnpm
// itself checks them — the first one present wins, so a workflow that sets
// either of them must not be overridden by the other.
const GLOBAL_SHIMS_ENV_NAMES = ['PNPM_CONFIG_GLOBAL_SHIMS', 'pnpm_config_global_shims'] as const

export interface InstalledRuntime {
  readonly name: RuntimeName
  readonly version: string
}

export interface RuntimeRequest {
  readonly name: RuntimeName
  readonly version: string
}

export function resolveRuntimeRequests(inputs: Inputs): RuntimeRequest[] {
  // Explicit `runtime` input always wins. `runtime.version` falls back to
  // devEngines.runtime if not provided — useful for matrix workflows that
  // pick the runtime but keep the version pinned in the manifest.
  if (inputs.runtime) {
    const { name } = inputs.runtime
    const version = inputs.runtime.version ?? readDevEngineVersion(inputs, name) ?? defaultVersionFor(name)
    return [{ name, version }]
  }

  return readDevEngineRuntimes(inputs)
}

export async function installRuntime(
  request: RuntimeRequest,
  binDest: string,
): Promise<InstalledRuntime | undefined> {
  startGroup(`Installing runtime ${request.name}@${request.version}...`)
  let exitCode: number
  try {
    exitCode = await runPnpm(binDest, ['runtime', 'set', request.name, request.version, '-g'])
  } catch (err: unknown) {
    setFailed(`pnpm runtime set ${request.name} ${request.version} -g failed: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  } finally {
    endGroup()
  }

  if (exitCode !== 0) {
    setFailed(`pnpm runtime set ${request.name} ${request.version} -g exited with code ${exitCode}`)
    return undefined
  }
  return { name: request.name, version: request.version }
}

/**
 * pnpm 12 links global runtime bins as context-aware shims: running `node`
 * from `$PNPM_HOME/bin` inside a project switches to the version that
 * project pins in `devEngines.runtime`, fetching it on demand. That defeats
 * the version this action was asked to install — a matrix job asking for
 * `node@22` would run the repository's pinned version instead — and even
 * when the two agree it materializes a second copy outside `$PNPM_HOME`.
 * Turn the shims off for the runtimes we installed, leaving every other
 * runtime at pnpm's defaults. A value the workflow set itself always wins.
 */
export function keepInstalledRuntimesAuthoritative(runtimes: readonly InstalledRuntime[]) {
  if (runtimes.length === 0) return

  // An empty value counts as unset, the same rule pnpm applies when it reads
  // these — stepping aside for a value pnpm ignores would leave the shims on.
  const configured = GLOBAL_SHIMS_ENV_NAMES.find(envName => process.env[envName])
  if (configured) {
    info(`\`${configured}\` is already set; leaving pnpm's context-aware shims as configured.`)
    return
  }

  exportVariable(
    GLOBAL_SHIMS_ENV_NAMES[0],
    JSON.stringify(Object.fromEntries(runtimes.map(runtime => [runtime.name, false]))),
  )
}

export function logSkippedRuntime() {
  info('No runtime requested (no `runtime` input and no `devEngines.runtime` in package.json). Skipping runtime install.')
}

function defaultVersionFor(name: RuntimeName): string {
  return name === 'node' ? 'lts' : 'latest'
}

function readManifest(inputs: Inputs): Record<string, unknown> | undefined {
  const { GITHUB_WORKSPACE } = process.env
  if (!GITHUB_WORKSPACE) return undefined
  try {
    const content = readFileSync(path.join(GITHUB_WORKSPACE, inputs.packageJsonFile), 'utf8')
    return inputs.packageJsonFile.endsWith('.yaml')
      ? parseYaml(content, { merge: true })
      : JSON.parse(content)
  } catch (error: unknown) {
    if (util.types.isNativeError(error) && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

interface DevEngineRuntimeEntry {
  readonly name?: string
  readonly version?: string
}

function readDevEngineEntries(inputs: Inputs): DevEngineRuntimeEntry[] {
  const manifest = readManifest(inputs)
  const runtime = (manifest?.devEngines as { runtime?: unknown } | undefined)?.runtime
  if (!runtime) return []
  return Array.isArray(runtime) ? (runtime as DevEngineRuntimeEntry[]) : [runtime as DevEngineRuntimeEntry]
}

function readDevEngineVersion(inputs: Inputs, name: RuntimeName): string | undefined {
  const match = readDevEngineEntries(inputs).find(e => e.name === name)
  return match?.version
}

function readDevEngineRuntimes(inputs: Inputs): RuntimeRequest[] {
  return readDevEngineEntries(inputs).flatMap(entry => {
    if (!entry.name || !entry.version || !SUPPORTED_RUNTIMES.has(entry.name as RuntimeName)) return []
    return [{ name: entry.name as RuntimeName, version: entry.version }]
  })
}

function runPnpm(binDest: string, args: string[]): Promise<number> {
  const pnpmBin = path.join(binDest, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm')
  return new Promise<number>((resolve, reject) => {
    const cp = spawn(pnpmBin, args, {
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    cp.on('error', reject)
    cp.on('close', resolve)
  })
}

export default installRuntime

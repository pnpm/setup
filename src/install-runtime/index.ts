import { exportVariable, setFailed, startGroup, endGroup, info, warning } from '@actions/core'
import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import path from 'path'
import util from 'util'
import { parse as parseYaml } from 'yaml'
import { Inputs, RuntimeName } from '../inputs'
import { readNodeVersionFile } from './node-version-file'

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
  // node-version-file for Node, then devEngines.runtime if not provided.
  if (inputs.runtime) {
    const { name } = inputs.runtime
    if (inputs.nodeVersionFile && (name !== 'node' || inputs.runtime.version)) {
      warning(
        name === 'node'
          ? '`node-version-file` is ignored because `runtime` already includes a Node.js version.'
          : `\`node-version-file\` is ignored because \`runtime\` explicitly selects ${name}.`,
      )
    }
    const version = inputs.runtime.version
      ?? (name === 'node' ? readNodeVersionFile(inputs) : undefined)
      ?? readDevEngineVersion(inputs, name)
      ?? defaultVersionFor(name)
    return [{ name, version }]
  }

  const runtimes = readDevEngineRuntimes(inputs)
  const nodeVersion = readNodeVersionFile(inputs)
  if (!nodeVersion) return runtimes

  return [
    { name: 'node', version: nodeVersion },
    ...runtimes.filter(runtime => runtime.name !== 'node'),
  ]
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
 * Read the versions `pnpm runtime set` actually installed, so that a moving
 * selector such as `node@lts` is reported and cached under the version it
 * resolved to. One listing covers every runtime, so this stays a single
 * subprocess no matter how many `devEngines.runtime` declares.
 *
 * This only refines outputs and a cache key, so it must never fail the run:
 * a change in `pnpm list --json` output would otherwise break setup for every
 * workflow that installs a runtime. Report the problem and let the caller
 * fall back to the requested selector.
 */
export async function getInstalledRuntimeVersions(
  names: readonly RuntimeName[],
  binDest: string,
): Promise<Map<RuntimeName, string>> {
  const versions = new Map<RuntimeName, string>()
  if (names.length === 0) return versions

  try {
    const stdout = await runPnpmForOutput(binDest, ['list', '--global', '--json', '--depth', '0'])
    const listing = JSON.parse(stdout) as Array<{
      readonly dependencies?: Record<string, { readonly version?: string }>
    }>
    for (const name of names) {
      const version = listing[0]?.dependencies?.[name]?.version
      if (version) {
        versions.set(name, version)
      } else {
        warning(`Unable to determine the installed ${name} version from "pnpm list --global"`)
      }
    }
  } catch (err: unknown) {
    warning(`Unable to determine the installed runtime versions: ${err instanceof Error ? err.message : String(err)}`)
  }
  return versions
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
  info('No runtime requested (no `runtime`, `node-version-file`, or `devEngines.runtime`). Skipping runtime install.')
}

function defaultVersionFor(name: RuntimeName): string {
  return name === 'node' ? 'lts' : 'latest'
}

function readManifest(inputs: Inputs): Record<string, unknown> | undefined {
  const { GITHUB_WORKSPACE } = process.env
  if (!GITHUB_WORKSPACE) return undefined
  try {
    const content = readFileSync(path.resolve(GITHUB_WORKSPACE, inputs.packageJsonFile), 'utf8')
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

// Resolve through the deduped list so an explicit `runtime` input picks the
// same declaration the manifest-driven path would, and warns about the
// duplicate the same way.
function readDevEngineVersion(inputs: Inputs, name: RuntimeName): string | undefined {
  return readDevEngineRuntimes(inputs).find(runtime => runtime.name === name)?.version
}

function readDevEngineRuntimes(inputs: Inputs): RuntimeRequest[] {
  const runtimes = new Map<RuntimeName, RuntimeRequest>()
  for (const entry of readDevEngineEntries(inputs)) {
    if (!entry.name || !entry.version || !SUPPORTED_RUNTIMES.has(entry.name as RuntimeName)) continue

    const name = entry.name as RuntimeName
    const previous = runtimes.get(name)
    if (previous) {
      warning(
        `Duplicate ${name} runtime versions declared in devEngines.runtime (${previous.version} and ${entry.version}); using the last declared version ${entry.version}.`,
      )
    }
    runtimes.set(name, { name, version: entry.version })
  }
  return [...runtimes.values()]
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

function runPnpmForOutput(binDest: string, args: string[]): Promise<string> {
  const pnpmBin = path.join(binDest, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm')
  return new Promise<string>((resolve, reject) => {
    const cp = spawn(pnpmBin, args, {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    cp.stdout.setEncoding('utf8')
    cp.stdout.on('data', chunk => {
      stdout += chunk
    })
    cp.on('error', reject)
    cp.on('close', code => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(`pnpm ${args.join(' ')} exited with code ${code}`))
      }
    })
  })
}

export default installRuntime

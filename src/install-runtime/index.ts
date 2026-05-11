import { setFailed, startGroup, endGroup, info } from '@actions/core'
import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import path from 'path'
import util from 'util'
import { parse as parseYaml } from 'yaml'
import { Inputs, RuntimeName } from '../inputs'

const SUPPORTED_RUNTIMES: ReadonlySet<RuntimeName> = new Set(['node', 'bun', 'deno'])

export interface InstalledRuntime {
  readonly name: RuntimeName
  readonly version: string
}

export interface RuntimeRequest {
  readonly name: RuntimeName
  readonly version: string
}

export function resolveRuntimeRequest(inputs: Inputs): RuntimeRequest | undefined {
  // Explicit `runtime` input always wins. `runtime.version` falls back to
  // devEngines.runtime if not provided — useful for matrix workflows that
  // pick the runtime but keep the version pinned in the manifest.
  if (inputs.runtime) {
    const { name } = inputs.runtime
    const version = inputs.runtime.version ?? readDevEngineVersion(inputs, name) ?? defaultVersionFor(name)
    return { name, version }
  }

  return readFirstDevEngineRuntime(inputs)
}

export async function installRuntime(
  request: RuntimeRequest,
  binDest: string,
): Promise<InstalledRuntime | undefined> {
  startGroup(`Installing runtime ${request.name}@${request.version}...`)
  const exitCode = await runPnpm(binDest, ['runtime', 'set', request.name, request.version, '-g'])
  endGroup()

  if (exitCode !== 0) {
    setFailed(`pnpm runtime set ${request.name} ${request.version} -g exited with code ${exitCode}`)
    return undefined
  }
  return { name: request.name, version: request.version }
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

function readFirstDevEngineRuntime(inputs: Inputs): RuntimeRequest | undefined {
  for (const entry of readDevEngineEntries(inputs)) {
    if (!entry.name || !entry.version) continue
    if (!SUPPORTED_RUNTIMES.has(entry.name as RuntimeName)) continue
    return { name: entry.name as RuntimeName, version: entry.version }
  }
  return undefined
}

function runPnpm(binDest: string, args: string[]): Promise<number> {
  // No extension: on Windows, `pnpm self-update` may land the binary as
  // `pnpm.exe`, `pnpm.cmd`, or extensionless `pnpm` depending on the version
  // and the shim mechanism. With `shell: true`, cmd.exe resolves via PATHEXT
  // and finds whichever variant is present. On POSIX the file is always
  // named `pnpm` and shell is off, so the absolute path works directly.
  const pnpmBin = path.join(binDest, 'pnpm')
  return new Promise<number>((resolve, reject) => {
    const cp = spawn(pnpmBin, args, {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: process.platform === 'win32',
    })
    cp.on('error', reject)
    cp.on('close', resolve)
  })
}

export default installRuntime

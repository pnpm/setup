import { getBooleanInput, getInput, InputOptions } from '@actions/core'
import expandTilde from 'expand-tilde'
import { RunInstall, parseRunInstall } from './run-install'

export type RuntimeName = 'node' | 'bun' | 'deno'

export interface Inputs {
  readonly version?: string
  readonly dest: string
  readonly cache: boolean
  readonly cacheDependencyPath: string
  readonly runInstall: RunInstall[]
  readonly packageJsonFile: string
  readonly runtime?: RuntimeName
  readonly runtimeVersion?: string
}

const options: InputOptions = {
  required: true,
}

const parseInputPath = (name: string) => expandTilde(getInput(name, options))

const SUPPORTED_RUNTIMES: ReadonlySet<RuntimeName> = new Set(['node', 'bun', 'deno'])

function parseRuntime(): RuntimeName | undefined {
  const raw = getInput('runtime').trim().toLowerCase()
  if (!raw) return undefined
  if (!SUPPORTED_RUNTIMES.has(raw as RuntimeName)) {
    throw new Error(`Unsupported runtime "${raw}". Supported runtimes: ${[...SUPPORTED_RUNTIMES].join(', ')}.`)
  }
  return raw as RuntimeName
}

export const getInputs = (): Inputs => {
  const runtime = parseRuntime()
  const runtimeVersion = getInput('runtime_version').trim() || undefined
  if (runtimeVersion && !runtime) {
    throw new Error('`runtime_version` was provided without `runtime`. Specify which runtime to install (node, bun, or deno).')
  }
  return {
    version: getInput('version'),
    dest: parseInputPath('dest'),
    cache: getBooleanInput('cache'),
    cacheDependencyPath: parseInputPath('cache_dependency_path'),
    runInstall: parseRunInstall('run_install'),
    packageJsonFile: parseInputPath('package_json_file'),
    runtime,
    runtimeVersion,
  }
}

export default getInputs

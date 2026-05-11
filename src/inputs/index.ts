import { getBooleanInput, getInput, InputOptions } from '@actions/core'
import expandTilde from 'expand-tilde'

export type RuntimeName = 'node' | 'bun' | 'deno'

const SUPPORTED_RUNTIMES: readonly RuntimeName[] = ['node', 'bun', 'deno']

export interface RuntimeInput {
  readonly name: RuntimeName
  readonly version?: string
}

export interface Inputs {
  readonly version?: string
  readonly dest: string
  readonly cache: boolean
  readonly cacheDependencyPath: string
  readonly packageJsonFile: string
  readonly runtime?: RuntimeInput
}

const options: InputOptions = {
  required: true,
}

const parseInputPath = (name: string) => expandTilde(getInput(name, options))

function parseRuntime(): RuntimeInput | undefined {
  const raw = getInput('runtime').trim()
  if (!raw) return undefined

  const atIndex = raw.indexOf('@')
  const name = (atIndex === -1 ? raw : raw.slice(0, atIndex)).trim()
  const version = atIndex === -1 ? undefined : raw.slice(atIndex + 1).trim()

  if (!isSupportedRuntime(name)) {
    throw new Error(
      `Invalid \`runtime\` input "${raw}". Expected \`<name>\` or \`<name>@<version>\` where name is one of: ${SUPPORTED_RUNTIMES.join(', ')}.`,
    )
  }
  if (version !== undefined && version === '') {
    throw new Error(`Invalid \`runtime\` input "${raw}". Trailing \`@\` with no version.`)
  }

  return { name, version }
}

function isSupportedRuntime(name: string): name is RuntimeName {
  return (SUPPORTED_RUNTIMES as readonly string[]).includes(name)
}

export const getInputs = (): Inputs => ({
  version: getInput('version'),
  dest: parseInputPath('dest'),
  cache: getBooleanInput('cache'),
  cacheDependencyPath: parseInputPath('cache-dependency-path'),
  packageJsonFile: parseInputPath('package-json-file'),
  runtime: parseRuntime(),
})

export default getInputs

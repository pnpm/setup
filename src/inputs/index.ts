import { getBooleanInput, getInput, InputOptions } from '@actions/core'
import expandTilde from 'expand-tilde'

export type RuntimeName = 'node' | 'bun' | 'deno'

const SUPPORTED_RUNTIMES: readonly RuntimeName[] = ['node', 'bun', 'deno']

export interface RuntimeInput {
  readonly name: RuntimeName
  readonly version?: string
}

/** Which install the action runs once pnpm and the runtime are in place. */
export type InstallMode = 'install' | 'frozen-lockfile' | 'ci'

const INSTALL_MODES: readonly InstallMode[] = ['install', 'frozen-lockfile', 'ci']

export interface Inputs {
  readonly version?: string
  readonly dest: string
  readonly cache: boolean
  readonly cacheDependencyPath: string
  readonly packageJsonFile: string
  readonly runtime?: RuntimeInput
  readonly install: InstallMode | false
  readonly token?: string
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

function parseInstall(): InstallMode | false {
  const raw = getInput('install').trim()

  // An omitted input picks up the default from action.yml, so an empty value
  // here means it was set to one — usually an `${{ ... }}` expression that
  // resolved to nothing. Fail rather than silently installing.
  if (raw === '') {
    throw new Error(
      `The \`install\` input is empty. Expected one of: true, false, ${INSTALL_MODES.join(', ')}.`,
    )
  }

  // The input started out as a boolean, so `true`/`false` keep working — with
  // `true` meaning the plain `pnpm install` it has always meant. The casing
  // variants are the ones the Actions runner accepts for boolean inputs.
  const normalized = raw.toLowerCase()
  if (normalized === 'true') return 'install'
  if (normalized === 'false') return false
  if (isInstallMode(normalized)) return normalized

  throw new Error(
    `Invalid \`install\` input "${raw}". Expected one of: true, false, ${INSTALL_MODES.join(', ')}.`,
  )
}

function isInstallMode(value: string): value is InstallMode {
  return (INSTALL_MODES as readonly string[]).includes(value)
}

export const getInputs = (): Inputs => ({
  version: getInput('version'),
  dest: parseInputPath('dest'),
  cache: getBooleanInput('cache'),
  cacheDependencyPath: parseInputPath('cache-dependency-path'),
  packageJsonFile: parseInputPath('package-json-file'),
  runtime: parseRuntime(),
  install: parseInstall(),
  token: getInput('token') || undefined,
})

export default getInputs

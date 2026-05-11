import { getBooleanInput, getInput, InputOptions, error } from '@actions/core'
import expandTilde from 'expand-tilde'
import { parse as parseYaml } from 'yaml'
import { z, ZodError } from 'zod'

export type RuntimeName = 'node' | 'bun' | 'deno'

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

const RuntimeSchema = z.object({
  name: z.enum(['node', 'bun', 'deno']),
  version: z.string().optional(),
})

function parseRuntime(): RuntimeInput | undefined {
  const raw = getInput('runtime').trim()
  if (!raw) return undefined

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (exception: unknown) {
    error(`Error parsing input "runtime" = ${raw}`)
    throw exception
  }
  if (parsed === null || parsed === undefined) return undefined

  try {
    return RuntimeSchema.parse(parsed)
  } catch (exception: unknown) {
    error(`Invalid value for input "runtime" = ${raw}`)
    if (exception instanceof ZodError) {
      error(`Errors: ${JSON.stringify(exception.errors)}`)
    }
    error(`Expected: { name: node | bun | deno, version?: string }`)
    throw exception
  }
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

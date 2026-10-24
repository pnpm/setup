import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { Inputs } from '../inputs/index.js'

const TOOL_VERSION_NAMES = new Set(['node', 'nodejs'])
const NODE_VERSION_FILES = ['.node-version', '.nvmrc', '.tool-versions']

export function readNodeVersionFile (inputs: Inputs): string | undefined {
  if (inputs.nodeVersionFile === false) return undefined
  const workspace = workspaceDirectory(inputs)
  if (!workspace) return undefined

  const explicit = Boolean(inputs.nodeVersionFile)
  const candidates = inputs.nodeVersionFile ? [inputs.nodeVersionFile] : NODE_VERSION_FILES
  for (const candidate of candidates) {
    const filePath = path.resolve(workspace, inputs.workingDirectory, candidate)
    const contents = readVersionFile(filePath, explicit)
    if (contents === undefined) continue
    const fileName = path.basename(filePath)
    // A discovered .tool-versions that only lists other tools is passed over.
    if (!explicit && fileName === '.tool-versions' && !findToolVersion(cleanLines(contents))) continue
    return parseNodeVersionFile(contents, fileName)
  }
  return undefined
}

function workspaceDirectory (inputs: Inputs): string | undefined {
  const { GITHUB_WORKSPACE } = process.env
  if (GITHUB_WORKSPACE) return GITHUB_WORKSPACE
  if (!inputs.nodeVersionFile) return undefined
  throw new Error('GITHUB_WORKSPACE is not set; unable to resolve `node-version-file`.')
}

/** A missing file is skipped while discovering, but fails when it was named explicitly. */
function readVersionFile (filePath: string, explicit: boolean): string | undefined {
  try {
    return readFileSync(filePath, 'utf8')
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    if (!explicit) return undefined
    throw new Error(`The specified Node version file does not exist: ${filePath}`, { cause: error })
  }
}

export function parseNodeVersionFile (contents: string, fileName = 'Node version file'): string {
  const lines = cleanLines(contents)
  if (fileName === '.tool-versions') {
    const declaration = findToolVersion(lines)
    if (!declaration) {
      throw new Error(`${fileName} does not declare a Node.js version with \`node\` or \`nodejs\`.`)
    }

    const [, version] = declaration.split(/\s+/)
    if (!version) throw new Error(`${fileName} declares Node.js without a version.`)
    return normalizeNodeVersion(version, fileName)
  }

  const versions = lines.filter(line => !/^[A-Z][\w-]*\s*=/i.test(line))
  if (versions.length !== 1) {
    throw new Error(`${fileName} must contain exactly one Node.js version selector.`)
  }
  return normalizeNodeVersion(versions[0], fileName)
}

function findToolVersion (lines: string[]): string | undefined {
  return lines.find(line => TOOL_VERSION_NAMES.has(line.split(/\s+/, 1)[0]))
}

function cleanLines (contents: string): string[] {
  return contents
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(line => line.replace(/\s*#.*$/, '').trim())
    .filter(Boolean)
}

function normalizeNodeVersion (version: string, fileName: string): string {
  if (version.includes(',')) {
    throw new Error(`${fileName} contains an invalid Node.js version selector: ${version}`)
  }

  const lowered = version.toLowerCase()
  if (lowered === 'node' || lowered === 'stable') return 'latest'
  if (lowered.startsWith('lts/')) return normalizeLtsSelector(version, fileName)

  const unsupportedAlias = ['system', 'current', 'iojs', 'unstable'].includes(lowered)
  if (unsupportedAlias || /^(?:path|ref):/i.test(version)) {
    throw new Error(`${fileName} uses a Node.js version selector that pnpm cannot install: ${version}`)
  }

  return /^v\d/.test(version) ? version.slice(1) : version
}

/** `lts/*` is the latest LTS line; `lts/<codename>` names one. */
function normalizeLtsSelector (version: string, fileName: string): string {
  const ltsName = version.slice('lts/'.length)
  if (ltsName === '*') return 'lts'
  if (!ltsName || ltsName.includes('/')) {
    throw new Error(`${fileName} contains an invalid Node.js version selector: ${version}`)
  }
  return ltsName
}

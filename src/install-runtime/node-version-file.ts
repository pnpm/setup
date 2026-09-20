import { readFileSync } from 'fs'
import path from 'path'
import type { Inputs } from '../inputs'

const TOOL_VERSION_NAMES = new Set(['node', 'nodejs'])
const NODE_VERSION_FILES = ['.node-version', '.nvmrc', '.tool-versions']

export function readNodeVersionFile(inputs: Inputs): string | undefined {
  if (inputs.nodeVersionFile === false) return undefined

  const { GITHUB_WORKSPACE } = process.env
  if (!GITHUB_WORKSPACE) {
    if (!inputs.nodeVersionFile) return undefined
    throw new Error('GITHUB_WORKSPACE is not set; unable to resolve `node-version-file`.')
  }

  const candidates = inputs.nodeVersionFile ? [inputs.nodeVersionFile] : NODE_VERSION_FILES
  for (const candidate of candidates) {
    const filePath = path.resolve(GITHUB_WORKSPACE, inputs.workingDirectory, candidate)
    let contents: string
    try {
      contents = readFileSync(filePath, 'utf8')
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        if (!inputs.nodeVersionFile) continue
        throw new Error(`The specified Node version file does not exist: ${filePath}`)
      }
      throw error
    }

    const fileName = path.basename(filePath)
    if (!inputs.nodeVersionFile && fileName === '.tool-versions' && !findToolVersion(cleanLines(contents))) continue
    return parseNodeVersionFile(contents, fileName)
  }
  return undefined
}

export function parseNodeVersionFile(contents: string, fileName = 'Node version file'): string {
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

  const versions = lines.filter(line => !/^[A-Za-z][A-Za-z0-9_-]*\s*=/.test(line))
  if (versions.length !== 1) {
    throw new Error(`${fileName} must contain exactly one Node.js version selector.`)
  }
  return normalizeNodeVersion(versions[0], fileName)
}

function findToolVersion(lines: string[]): string | undefined {
  return lines.find(line => TOOL_VERSION_NAMES.has(line.split(/\s+/, 1)[0]))
}

function cleanLines(contents: string): string[] {
  return contents
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(line => line.replace(/\s*#.*$/, '').trim())
    .filter(Boolean)
}

function normalizeNodeVersion(version: string, fileName: string): string {
  if (version.includes(',')) {
    throw new Error(`${fileName} contains an invalid Node.js version selector: ${version}`)
  }

  const lowered = version.toLowerCase()
  if (lowered === 'node' || lowered === 'stable') return 'latest'
  if (lowered === 'lts/*') return 'lts'
  if (lowered.startsWith('lts/')) {
    const ltsName = version.slice(4)
    if (!ltsName || ltsName.includes('/')) {
      throw new Error(`${fileName} contains an invalid Node.js version selector: ${version}`)
    }
    return ltsName
  }

  const unsupportedAlias = ['system', 'current', 'iojs', 'unstable'].includes(lowered)
  if (unsupportedAlias || /^(?:path|ref):/i.test(version)) {
    throw new Error(`${fileName} uses a Node.js version selector that pnpm cannot install: ${version}`)
  }

  return /^v\d/.test(version) ? version.slice(1) : version
}

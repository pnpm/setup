import { readFileSync } from 'fs'
import path from 'path'
import util from 'util'

/**
 * Extracts a pnpm version spec from a supported version file.
 *
 * `.tool-versions` may contain several tools, so only its `pnpm` entry is
 * considered. For other files the complete trimmed contents are the version
 * spec, allowing exact versions, semver ranges, and npm dist-tags.
 */
export function parsePnpmVersionFile(contents: string, versionFilePath: string): string | undefined {
  if (path.basename(versionFilePath) === '.tool-versions') {
    const match = contents.match(/^\s*pnpm\s+(?<version>[^\s#]+)/m)
    return match?.groups?.version
  }

  return contents.trim() || undefined
}

export function getPnpmVersionFromFile(versionFilePath: string): string {
  let contents: string
  try {
    contents = readFileSync(versionFilePath, 'utf8')
  } catch (error: unknown) {
    if (util.types.isNativeError(error) && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`The specified pnpm version file at: ${versionFilePath} does not exist`)
    }
    throw error
  }

  const version = parsePnpmVersionFile(contents, versionFilePath)
  if (!version) {
    const hint = path.basename(versionFilePath) === '.tool-versions'
      ? ' Ensure it contains an entry such as `pnpm 12`.'
      : ''
    throw new Error(`Could not determine a pnpm version from ${versionFilePath}.${hint}`)
  }

  return version
}

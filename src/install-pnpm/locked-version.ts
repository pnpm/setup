import { readFileSync } from 'fs'
import path from 'path'
import semver from 'semver'
import { parseAllDocuments } from 'yaml'

/**
 * Reuse a compatible package-manager pin from the lockfile's environment
 * document. Exact versions and registry tags bypass lockfile selection.
 */
export function readLockedPnpmVersion(directory: string, spec: string): string | undefined {
  // Exact pins already identify the binary; tags need registry resolution.
  if (semver.valid(spec) || !semver.validRange(spec)) return undefined

  let content: string
  try {
    content = readFileSync(path.join(directory, 'pnpm-lock.yaml'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }

  // pnpm 11+ stores package-manager dependencies in the first YAML document.
  const document = parseAllDocuments(content)[0]
  if (!document) return undefined
  if (document.errors.length) throw document.errors[0]
  const locked = document.toJSON()?.importers?.['.']?.packageManagerDependencies?.pnpm
  // Match pnpm's version switching: keep a satisfying lock even after the
  // specifier changes, and include prereleases when testing the range.
  if (typeof locked?.version === 'string' && semver.valid(locked.version) &&
      semver.satisfies(locked.version, spec, { includePrerelease: true })) {
    return locked.version
  }
  return undefined
}

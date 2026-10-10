import { readFileSync } from 'fs'
import path from 'path'
import semver from 'semver'
import { parseDocument } from 'yaml'

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

  const envDocument = extractEnvDocument(content)
  if (envDocument === undefined) return undefined
  const document = parseDocument(envDocument)
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

/**
 * pnpm 11+ records package-manager dependencies in a document that leads the
 * lockfile. Slicing it out the way pnpm's `extractEnvDocument` does avoids
 * parsing the dependency document, which runs to megabytes in a monorepo.
 */
function extractEnvDocument(content: string): string | undefined {
  content = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!content.startsWith('---\n')) return undefined
  const end = content.indexOf('\n---\n', 4)
  return end === -1 ? content.slice(4).replace(/\n---\n?$/, '') : content.slice(4, end)
}

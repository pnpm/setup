import { closeSync, openSync, readSync } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import semver from 'semver'
import { parseDocument } from 'yaml'

/**
 * Reuse a compatible package-manager pin from the lockfile's environment
 * document. Exact versions and registry tags bypass lockfile selection.
 */
export function readLockedPnpmVersion (directory: string, spec: string): string | undefined {
  // Exact pins already identify the binary; tags need registry resolution.
  if (semver.valid(spec) || !semver.validRange(spec)) return undefined

  let envDocument: string | undefined
  try {
    envDocument = readEnvDocument(path.join(directory, 'pnpm-lock.yaml'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }

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

function readEnvDocument (filename: string): string | undefined {
  const fd = openSync(filename, 'r')
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    const decoder = new StringDecoder('utf8')
    const chunks: string[] = []
    const separator = /\r?\n---\r?\n/g
    let tail = ''
    let checkedStart = false
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead === 0) return extractEnvDocument(chunks.join('') + decoder.end())
      const chunk = decoder.write(buffer.subarray(0, bytesRead))
      chunks.push(chunk)
      const content = tail + chunk
      if (!checkedStart && content.length < 6) {
        tail = content
        continue
      }
      const start = checkedStart ? 0 : /^\uFEFF?---\r?\n/.exec(content)?.[0].length
      if (start === undefined) return undefined
      separator.lastIndex = start
      if (separator.test(content)) return extractEnvDocument(chunks.join(''))
      checkedStart = true
      // Retain enough text for a CRLF separator split across reads.
      tail = content.slice(Math.max(start, content.length - 6))
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * pnpm 11+ records package-manager dependencies in a document that leads the
 * lockfile. Slicing it out the way pnpm's `extractEnvDocument` does avoids
 * parsing the dependency document, which runs to megabytes in a monorepo.
 */
function extractEnvDocument (content: string): string | undefined {
  content = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!content.startsWith('---\n')) return undefined
  const end = content.indexOf('\n---\n', 4)
  return end === -1 ? content.slice(4).replace(/\n---\n?$/, '') : content.slice(4, end)
}

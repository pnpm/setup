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
    return scanEnvDocument(readChunks(fd))
  } finally {
    closeSync(fd)
  }
}

/** Decoded text of the file, read lazily so a scan that stops early reads no further. */
function * readChunks (fd: number): Generator<string> {
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const decoder = new StringDecoder('utf8')
  for (let bytesRead = readSync(fd, buffer, 0, buffer.length, null); bytesRead > 0;
    bytesRead = readSync(fd, buffer, 0, buffer.length, null)) {
    yield decoder.write(buffer.subarray(0, bytesRead))
  }
  yield decoder.end()
}

// The longest leading separator line, `\uFEFF---\r\n`.
const HEADER_MAX_LENGTH = 6

/**
 * Stops at the chunk that completes the separator ending the leading document,
 * or at once when the file does not start with one.
 */
function scanEnvDocument (chunks: Iterable<string>): string | undefined {
  const read: string[] = []
  const separator = /\r?\n---\r?\n/g
  let pending = ''
  let headerChecked = false
  for (const chunk of chunks) {
    read.push(chunk)
    const content = pending + chunk
    if (!headerChecked && content.length < HEADER_MAX_LENGTH) {
      pending = content
      continue
    }
    const searchFrom = headerChecked ? 0 : /^\uFEFF?---\r?\n/.exec(content)?.[0].length
    if (searchFrom === undefined) return undefined
    headerChecked = true
    separator.lastIndex = searchFrom
    if (separator.test(content)) return extractEnvDocument(read.join(''))
    // Retain enough text for a CRLF separator split across reads.
    pending = content.slice(Math.max(searchFrom, content.length - HEADER_MAX_LENGTH))
  }
  return extractEnvDocument(read.join(''))
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

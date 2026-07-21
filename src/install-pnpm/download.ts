import { HttpClient } from '@actions/http-client'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream, existsSync } from 'fs'
import { chmod, copyFile, link, mkdir, rename, rm } from 'fs/promises'
import path from 'path'
import { pipeline } from 'stream/promises'
import semver from 'semver'

// Since v12 pnpm is a standalone native executable, published per platform as
// `@pnpm/exe.<os>-<arch>`. Earlier versions are Node.js programs that this
// action cannot install.
const MIN_SUPPORTED_MAJOR = 12

const REGISTRY = 'https://registry.npmjs.org'
// Abbreviated packuments are much smaller than full ones and still carry the
// per-version dist metadata needed to download and verify tarballs.
const ABBREVIATED_PACKUMENT = 'application/vnd.npm.install-v1+json'

export interface ResolvedPnpm {
  readonly version: string
  readonly tarballUrl: string
  readonly integrity: string
}

interface AbbreviatedPackument {
  readonly versions: Record<string, { dist: { tarball: string; integrity?: string } }>
}

// HTTPS_PROXY/NO_PROXY are honored automatically by @actions/http-client.
const http = new HttpClient('pnpm/setup', undefined, { allowRetries: true, maxRetries: 3 })

export async function resolvePnpm(spec: string): Promise<ResolvedPnpm> {
  const platform = getPlatformKey()
  const exePackage = `@pnpm/exe.${platform}`
  const packument = await fetchJson<AbbreviatedPackument>(
    `${REGISTRY}/${exePackage.replace('/', '%2f')}`,
    { accept: ABBREVIATED_PACKUMENT },
  )

  const version = await resolveVersion(spec, Object.keys(packument.versions))
  if (semver.major(version) < MIN_SUPPORTED_MAJOR) {
    throw new Error(`The requested pnpm version "${spec}" resolved to ${version}, but this action only installs pnpm v12 or newer.
Since v12, pnpm is a standalone executable that needs no Node.js or npm; this action does not support the Node.js-based pnpm versions.
To install pnpm 11 or older, use the pnpm/action-setup action instead.`)
  }

  const entry = packument.versions[version]
  if (!entry) {
    throw new Error(`pnpm ${version} has no standalone executable published for ${platform} (${exePackage}).`)
  }
  const { tarball, integrity } = entry.dist
  if (!integrity?.startsWith('sha512-')) {
    throw new Error(`Unexpected integrity metadata for ${exePackage}@${version}: ${integrity ?? '<missing>'}`)
  }
  return { version, tarballUrl: tarball, integrity }
}

/**
 * Downloads the pnpm executable into `destDir` and returns its path.
 * Also links the `pnpx`, `pn`, and `pnx` aliases next to it — the binary
 * dispatches on the name it was invoked as.
 */
export async function downloadPnpm(resolved: ResolvedPnpm, destDir: string): Promise<string> {
  const tmpDir = path.join(destDir, '.download')
  await mkdir(tmpDir, { recursive: true })

  const tarball = path.join(tmpDir, 'pnpm.tgz')
  const response = await http.get(resolved.tarballUrl)
  if (response.message.statusCode !== 200) {
    response.message.resume()
    throw new Error(`Failed to download ${resolved.tarballUrl}: HTTP ${response.message.statusCode}`)
  }
  await pipeline(response.message, createWriteStream(tarball))
  await verifyIntegrity(tarball, resolved.integrity, resolved.tarballUrl)
  await extractTarball(tarball, tmpDir)

  const exe = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm'
  const pnpmBin = path.join(destDir, exe)
  await rename(path.join(tmpDir, 'package', exe), pnpmBin)
  if (process.platform !== 'win32') {
    await chmod(pnpmBin, 0o755)
  }
  await rm(tmpDir, { recursive: true, force: true })

  for (const alias of ['pnpx', 'pn', 'pnx']) {
    const aliasPath = path.join(destDir, process.platform === 'win32' ? `${alias}.exe` : alias)
    try {
      await link(pnpmBin, aliasPath)
    } catch {
      await copyFile(pnpmBin, aliasPath)
    }
  }

  return pnpmBin
}

function getPlatformKey(): string {
  const arch = process.arch
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported CPU architecture "${arch}". pnpm provides executables for x64 and arm64.`)
  }
  switch (process.platform) {
    case 'win32': return `win32-${arch}`
    case 'darwin': return `darwin-${arch}`
    case 'linux': return `linux-${arch}${isMusl() ? '-musl' : ''}`
    default:
      throw new Error(`Unsupported platform "${process.platform}". pnpm provides executables for Windows, macOS, and Linux.`)
  }
}

function isMusl(): boolean {
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header
  if (header) return !header.glibcVersionRuntime
  return existsSync('/etc/alpine-release')
}

async function resolveVersion(spec: string, available: string[]): Promise<string> {
  const exact = semver.valid(spec)
  if (exact) return exact

  if (semver.validRange(spec)) {
    // Prefer stable releases; fall back to prereleases so ranges like `12` or
    // `^12.0.0` resolve while v12 has only prerelease versions published.
    const resolved = semver.maxSatisfying(available, spec)
      ?? semver.maxSatisfying(available, spec, { includePrerelease: true })
    if (!resolved) {
      throw new Error(`No pnpm executable version matches "${spec}". Published versions: ${available.join(', ')}`)
    }
    return resolved
  }

  // Anything else is treated as a dist-tag (e.g. `next-12`). Dist-tags are
  // read from the main `pnpm` package — the authoritative source; the
  // per-platform packages carry stale tags.
  const distTags = await fetchJson<Record<string, string>>(`${REGISTRY}/-/package/pnpm/dist-tags`)
  const version = distTags[spec]
  if (!version) {
    throw new Error(`"${spec}" is neither a valid pnpm version, a semver range, nor a known dist-tag of pnpm.`)
  }
  return version
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const response = await http.getJson<T>(url, headers)
  if (response.result == null) {
    throw new Error(`Unexpected empty response from ${url}`)
  }
  return response.result
}

async function verifyIntegrity(file: string, expected: string, url: string): Promise<void> {
  const hash = createHash('sha512')
  await pipeline(createReadStream(file), hash)
  const actual = `sha512-${hash.digest('base64')}`
  if (actual !== expected) {
    throw new Error(`Integrity check failed for ${url}.
  Expected: ${expected}
  Actual:   ${actual}`)
  }
}

function extractTarball(tarball: string, destDir: string): Promise<void> {
  // A tar executable is available on all GitHub-hosted runners, including
  // Windows (bsdtar ships with Windows since 2019). Backslashes are converted
  // to forward slashes because MSYS-based tar implementations misread them.
  const args = ['-xzf', tarball.replace(/\\/g, '/'), '-C', destDir.replace(/\\/g, '/')]
  return new Promise<void>((resolve, reject) => {
    const cp = spawn('tar', args, { stdio: ['ignore', 'inherit', 'inherit'] })
    cp.on('error', reject)
    cp.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`tar exited with code ${code} while extracting ${tarball}`))
      }
    })
  })
}

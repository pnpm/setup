import { HttpClient } from '@actions/http-client'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream, existsSync } from 'fs'
import { chmod, copyFile, link, mkdir, rename, rm } from 'fs/promises'
import path from 'path'
import { pipeline } from 'stream/promises'
import semver from 'semver'

import { type PackageSignature, verifyRegistrySignature } from './verify-signature'

// The action downloads pnpm's self-contained release archive and uses
// `pnpm runtime` to install a JavaScript runtime. Both are available from v11
// onward, so that is the oldest major this action can install.
const MIN_SUPPORTED_MAJOR = 11

const REGISTRY = 'https://registry.npmjs.org'
// Abbreviated packuments are much smaller than full ones and still carry the
// per-version metadata needed to resolve a version spec.
const ABBREVIATED_PACKUMENT = 'application/vnd.npm.install-v1+json'

const GITHUB_API = 'https://api.github.com'

/**
 * Where the executable is fetched from, and what proves it is the right one.
 *
 * From v12 the packages on the npm registry hold the same executable as the
 * release assets, byte for byte, and npm signs a checksum for them with a key
 * this action pins — so a tampered download cannot pass. GitHub publishes a
 * digest but serves it from the same place as the asset, which catches
 * corruption rather than tampering, so it is used only where there is nothing
 * better: v11, whose `dist/` bundles dependencies the registry copy declares
 * instead.
 */
export type ResolvedPnpm =
  | {
    readonly source: 'github'
    readonly version: string
    readonly downloadUrl: string
    // Hex-encoded SHA-256 of the release archive, from the GitHub asset `digest`.
    readonly sha256: string
    readonly archive: 'tar.gz' | 'zip'
  }
  | {
    readonly source: 'registry'
    readonly version: string
    readonly packages: readonly RegistryPackage[]
  }

interface RegistryPackage {
  readonly name: string
  readonly tarball: string
  readonly integrity: string
  /** Entry to lift out of the tarball's `package/` root into the destination. */
  readonly keep: string
}

interface VersionMetadata {
  readonly dist: {
    readonly tarball: string
    readonly integrity?: string
    readonly signatures?: readonly PackageSignature[]
  }
}

interface AbbreviatedPackument {
  readonly versions: Record<string, unknown>
}

interface GitHubAsset {
  readonly name: string
  readonly digest?: string
  readonly browser_download_url: string
}

interface GitHubRelease {
  readonly assets: readonly GitHubAsset[]
}

// HTTPS_PROXY/NO_PROXY are honored automatically by @actions/http-client.
const http = new HttpClient('pnpm/setup', undefined, { allowRetries: true, maxRetries: 3 })

export async function resolvePnpm(spec: string, token?: string): Promise<ResolvedPnpm> {
  const version = await resolveVersion(spec)
  if (semver.major(version) < MIN_SUPPORTED_MAJOR) {
    throw new Error(`The requested pnpm version "${spec}" resolved to ${version}, but this action only installs pnpm v${MIN_SUPPORTED_MAJOR} or newer.
This action downloads pnpm's self-contained release binary and uses \`pnpm runtime\` to install a JavaScript runtime; both are available from v${MIN_SUPPORTED_MAJOR} onward.
To install older pnpm, use the pnpm/action-setup action instead.`)
  }

  const platform = getPlatform()
  if (semver.major(version) >= 12) {
    return resolveFromRegistry(version, platform)
  }

  const asset = assetName(platform)
  const release = await fetchRelease(version, token)
  const found = release.assets.find((a) => a.name === asset)
  if (!found) {
    const isIntelMac = semver.major(version) === 11 && platform.os === 'darwin' && platform.arch === 'x64'
    throw new Error(`pnpm ${version} has no ${asset} release asset for your platform. `
      + (isIntelMac
        ? 'pnpm v11 ships no binary for Intel macOS (darwin-x64); use v12 or newer there.'
        : `See https://github.com/pnpm/pnpm/releases/tag/v${version} for the available assets.`))
  }
  if (!found.digest?.startsWith('sha256:')) {
    throw new Error(`Release asset ${asset} for pnpm ${version} has no sha256 digest (got ${found.digest ?? '<missing>'}).`)
  }
  return {
    source: 'github',
    version,
    downloadUrl: found.browser_download_url,
    sha256: found.digest.slice('sha256:'.length),
    archive: platform.os === 'win32' ? 'zip' : 'tar.gz',
  }
}

/**
 * The executable and the `dist/` tree it loads are published as two packages:
 * the platform package holds the binary, `pnpm` holds `dist/`. Both are
 * verified the same way.
 */
async function resolveFromRegistry(version: string, platform: Platform): Promise<ResolvedPnpm> {
  const exe = platform.os === 'win32' ? 'pnpm.exe' : 'pnpm'
  const wanted = [
    { name: platformPackageName(platform), keep: exe },
    { name: 'pnpm', keep: 'dist' },
  ]
  const packages = await Promise.all(wanted.map(async ({ name, keep }) => {
    const meta = await fetchJson<VersionMetadata>(`${REGISTRY}/${name}/${version}`)
    const integrity = meta.dist.integrity
    if (!integrity) {
      throw new Error(`The npm registry published no checksum for ${name}@${version}.`)
    }
    verifyRegistrySignature({ name, version, integrity, signatures: meta.dist.signatures })
    return { name, tarball: meta.dist.tarball, integrity, keep }
  }))
  return { source: 'registry', version, packages }
}

// Platform packages are named `@pnpm/exe.<os>-<arch>[-musl]`.
function platformPackageName({ os, arch, musl }: Platform): string {
  return `@pnpm/exe.${os}-${arch}${musl ? '-musl' : ''}`
}

/**
 * Downloads and extracts the pnpm release archive into `destDir`, returning the
 * path to the `pnpm` executable. The archive holds the executable at its root
 * plus, for Node-SEA builds (v11), a sibling `dist/` it loads at runtime — the
 * whole archive is extracted so that layout is preserved. The `pnpx`, `pn`, and
 * `pnx` aliases are linked next to the binary, which dispatches on the name it
 * was invoked as.
 */
export async function downloadPnpm(resolved: ResolvedPnpm, destDir: string): Promise<string> {
  const tmpDir = path.join(destDir, '.download')
  await mkdir(tmpDir, { recursive: true })

  if (resolved.source === 'registry') {
    await downloadFromRegistry(resolved.packages, destDir, tmpDir)
  } else {
    const archivePath = path.join(tmpDir, resolved.archive === 'zip' ? 'pnpm.zip' : 'pnpm.tgz')
    const response = await http.get(resolved.downloadUrl)
    if (response.message.statusCode !== 200) {
      response.message.resume()
      throw new Error(`Failed to download ${resolved.downloadUrl}: HTTP ${response.message.statusCode}`)
    }
    await pipeline(response.message, createWriteStream(archivePath))
    await verifySha256(archivePath, resolved.sha256, resolved.downloadUrl)
    await extractArchive(archivePath, destDir, resolved.archive)
  }
  await rm(tmpDir, { recursive: true, force: true })

  const exe = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm'
  const pnpmBin = path.join(destDir, exe)
  if (process.platform !== 'win32') {
    await chmod(pnpmBin, 0o755)
  }

  for (const alias of ['pnpx', 'pn', 'pnx']) {
    const aliasPath = path.join(destDir, process.platform === 'win32' ? `${alias}.exe` : alias)
    await rm(aliasPath, { force: true })
    try {
      await link(pnpmBin, aliasPath)
    } catch {
      await copyFile(pnpmBin, aliasPath)
    }
  }

  return pnpmBin
}

interface Platform {
  readonly os: 'linux' | 'darwin' | 'win32'
  readonly arch: 'x64' | 'arm64'
  readonly musl: boolean
}

function getPlatform(): Platform {
  const arch = process.arch
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported CPU architecture "${arch}". pnpm provides executables for x64 and arm64.`)
  }
  const os = process.platform
  if (os !== 'linux' && os !== 'darwin' && os !== 'win32') {
    throw new Error(`Unsupported platform "${os}". pnpm provides executables for Windows, macOS, and Linux.`)
  }
  return { os, arch, musl: os === 'linux' && isMusl() }
}

// Release assets are named `pnpm-<os>-<arch>[-musl].tar.gz`, except Windows
// which ships a `.zip` (e.g. `pnpm-linux-x64.tar.gz`, `pnpm-linux-x64-musl.tar.gz`,
// `pnpm-darwin-arm64.tar.gz`, `pnpm-win32-x64.zip`).
function assetName(platform: Platform): string {
  const { os, arch, musl } = platform
  if (os === 'win32') return `pnpm-win32-${arch}.zip`
  return `pnpm-${os}-${arch}${musl ? '-musl' : ''}.tar.gz`
}

function isMusl(): boolean {
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header
  if (header) return !header.glibcVersionRuntime
  return existsSync('/etc/alpine-release')
}

async function fetchRelease(version: string, token?: string): Promise<GitHubRelease> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  }
  // A token lifts the anonymous 60-req/hour rate limit; the action defaults it
  // to the workflow's GITHUB_TOKEN. Anonymous requests still work without one.
  if (token) headers.authorization = `Bearer ${token}`

  const url = `${GITHUB_API}/repos/pnpm/pnpm/releases/tags/v${version}`
  const response = await http.getJson<GitHubRelease>(url, headers)
  if (response.statusCode === 404) {
    throw new Error(`pnpm ${version} has no GitHub release (tag v${version}). Some prerelease versions are published to npm but not released as downloadable binaries — pick a version with a published release: https://github.com/pnpm/pnpm/releases`)
  }
  // Any other non-200 (403 rate limit, 401 bad token, 5xx, …) still yields a
  // parsed JSON error body as `result`; reject on status so it never reaches
  // the caller as a bogus release.
  if (response.statusCode !== 200 || response.result == null) {
    throw new Error(`Failed to fetch the pnpm ${version} release from ${url}: HTTP ${response.statusCode}.`)
  }
  return response.result
}

async function resolveVersion(spec: string): Promise<string> {
  const exact = semver.valid(spec)
  if (exact) return exact

  if (semver.validRange(spec)) {
    // Resolve ranges against the `pnpm` packument, which lists every published
    // version. Prefer stable releases; fall back to prereleases so ranges like
    // `12` or `^12.0.0` resolve while v12 has only prerelease versions published.
    const available = await fetchPnpmVersions()
    const resolved = semver.maxSatisfying(available, spec)
      ?? semver.maxSatisfying(available, spec, { includePrerelease: true })
    if (!resolved) {
      throw new Error(`No pnpm version matches "${spec}".`)
    }
    return resolved
  }

  // Anything else is treated as a dist-tag (e.g. `next-12`), read from the main
  // `pnpm` package.
  const distTags = await fetchJson<Record<string, string>>(`${REGISTRY}/-/package/pnpm/dist-tags`)
  const version = distTags[spec]
  if (!version) {
    throw new Error(`"${spec}" is neither a valid pnpm version, a semver range, nor a known dist-tag of pnpm.`)
  }
  return version
}

async function fetchPnpmVersions(): Promise<string[]> {
  const packument = await fetchJson<AbbreviatedPackument>(
    `${REGISTRY}/pnpm`,
    { accept: ABBREVIATED_PACKUMENT },
  )
  return Object.keys(packument.versions)
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const response = await http.getJson<T>(url, headers)
  if (response.result == null) {
    throw new Error(`Unexpected empty response from ${url}`)
  }
  return response.result
}

/**
 * Fetches each package, checks it against the checksum npm signed for it, and
 * lifts the wanted entry out of the tarball's `package/` root. Unpacking
 * happens away from `destDir`, whose layout the executable depends on.
 */
async function downloadFromRegistry(
  packages: readonly RegistryPackage[],
  destDir: string,
  tmpDir: string,
): Promise<void> {
  for (const pkg of packages) {
    const safeName = pkg.name.replace(/[@/]/g, '_')
    const archivePath = path.join(tmpDir, `${safeName}.tgz`)
    const response = await http.get(pkg.tarball)
    if (response.message.statusCode !== 200) {
      response.message.resume()
      throw new Error(`Failed to download ${pkg.tarball}: HTTP ${response.message.statusCode}`)
    }
    await pipeline(response.message, createWriteStream(archivePath))
    await verifyIntegrity(archivePath, pkg)

    const unpackDir = path.join(tmpDir, safeName)
    await mkdir(unpackDir, { recursive: true })
    await extractArchive(archivePath, unpackDir, 'tar.gz')
    await rm(path.join(destDir, pkg.keep), { recursive: true, force: true })
    await rename(path.join(unpackDir, 'package', pkg.keep), path.join(destDir, pkg.keep))
  }
}

async function verifyIntegrity(file: string, pkg: RegistryPackage): Promise<void> {
  const [algorithm, expected] = pkg.integrity.split('-')
  const hash = createHash(algorithm)
  await pipeline(createReadStream(file), hash)
  const actual = hash.digest('base64')
  if (actual !== expected) {
    throw new Error(`${pkg.name}@${pkg.integrity} does not match the checksum the npm registry published for it. Refusing to install.
  Expected ${algorithm}: ${expected}
  Actual   ${algorithm}: ${actual}`)
  }
}

async function verifySha256(file: string, expectedHex: string, url: string): Promise<void> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  const actual = hash.digest('hex')
  if (actual !== expectedHex.toLowerCase()) {
    throw new Error(`Integrity check failed for ${url}.
  Expected sha256: ${expectedHex}
  Actual sha256:   ${actual}`)
  }
}

function extractArchive(archivePath: string, destDir: string, archive: 'tar.gz' | 'zip'): Promise<void> {
  // A tar executable is available on all GitHub-hosted runners. GNU tar
  // (Linux/macOS) handles the `.tar.gz` assets; the `tar` on Windows runners is
  // bsdtar, which also unpacks the `.zip` assets. Backslashes are converted to
  // forward slashes because MSYS-based tar implementations misread them.
  const flags = archive === 'zip' ? '-xf' : '-xzf'
  const args = [flags, archivePath.replace(/\\/g, '/'), '-C', destDir.replace(/\\/g, '/')]
  return new Promise<void>((resolve, reject) => {
    const cp = spawn('tar', args, { stdio: ['ignore', 'inherit', 'inherit'] })
    cp.on('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT'
        ? new Error('Could not find a `tar` executable on PATH. tar is preinstalled on all GitHub-hosted runners; on a self-hosted runner, install tar to use this action.')
        : error)
    })
    cp.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`tar exited with code ${code} while extracting ${archivePath}`))
      }
    })
  })
}

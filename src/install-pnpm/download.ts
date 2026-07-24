import { HttpClient } from '@actions/http-client'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream, existsSync } from 'fs'
import { chmod, copyFile, link, mkdir, rename, rm } from 'fs/promises'
import path from 'path'
import { pipeline } from 'stream/promises'
import semver from 'semver'

// This action downloads pnpm's native, per-platform executable and uses
// `pnpm runtime` to install a JavaScript runtime. Both are available from
// v11 onward, so that is the oldest major this action can install. The
// per-platform package name differs by major (see `exePackageName`).
const MIN_SUPPORTED_MAJOR = 11

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
  // Resolve the version first: the executable's package name depends on the
  // major (v11 and v12+ use different naming), so the major must be known
  // before the right per-platform package can be queried.
  const version = await resolveVersion(spec)
  const major = semver.major(version)
  if (major < MIN_SUPPORTED_MAJOR) {
    throw new Error(`The requested pnpm version "${spec}" resolved to ${version}, but this action only installs pnpm v${MIN_SUPPORTED_MAJOR} or newer.
This action downloads pnpm's native per-platform executable and uses \`pnpm runtime\` to install a JavaScript runtime; both are available from v${MIN_SUPPORTED_MAJOR} onward.
To install older pnpm, use the pnpm/action-setup action instead.`)
  }

  const platform = getPlatform()
  const exePackage = exePackageName(platform, major)
  const packument = await fetchJson<AbbreviatedPackument>(
    `${REGISTRY}/${exePackage.replaceAll('/', '%2f')}`,
    { accept: ABBREVIATED_PACKUMENT },
  )

  const entry = packument.versions[version]
  if (!entry) {
    throw new Error(`pnpm ${version} has no native executable published for your platform (${exePackage}). `
      + `Note that pnpm v11 ships no native binary for Intel macOS (darwin-x64); use v12 or newer there.`)
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

  const exe = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm'
  await extractTarball(tarball, tmpDir, `package/${exe}`)

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

// The per-platform executable is published under two different naming schemes:
//   • v12+  →  `@pnpm/exe.<os>-<arch>`, with a `-musl` suffix on Linux
//             (e.g. `@pnpm/exe.linux-x64`, `@pnpm/exe.linux-x64-musl`,
//              `@pnpm/exe.darwin-arm64`, `@pnpm/exe.win32-x64`).
//   • v11   →  `@pnpm/<os>-<arch>` with `macos`/`win` names and a dedicated
//             `linuxstatic-<arch>` package for the musl build
//             (e.g. `@pnpm/linux-x64`, `@pnpm/linuxstatic-x64`,
//              `@pnpm/macos-arm64`, `@pnpm/win-x64`).
// Both tarballs share the same internal layout (`package/pnpm[.exe]`), so only
// the package name differs. Note: v11 ships no `@pnpm/macos-x64` (Intel macOS).
function exePackageName(platform: Platform, major: number): string {
  const { os, arch, musl } = platform
  if (major >= 12) {
    return `@pnpm/exe.${os}-${arch}${musl ? '-musl' : ''}`
  }
  const osName = os === 'win32' ? 'win' : os === 'darwin' ? 'macos' : (musl ? 'linuxstatic' : 'linux')
  return `@pnpm/${osName}-${arch}`
}

function isMusl(): boolean {
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header
  if (header) return !header.glibcVersionRuntime
  return existsSync('/etc/alpine-release')
}

async function resolveVersion(spec: string): Promise<string> {
  const exact = semver.valid(spec)
  if (exact) return exact

  if (semver.validRange(spec)) {
    // Resolve ranges against the authoritative `pnpm` packument, which lists
    // every published version across all majors — the per-platform executable
    // packages only cover a single naming scheme. Prefer stable releases; fall
    // back to prereleases so ranges like `12` or `^12.0.0` resolve while v12
    // has only prerelease versions published.
    const available = await fetchPnpmVersions()
    const resolved = semver.maxSatisfying(available, spec)
      ?? semver.maxSatisfying(available, spec, { includePrerelease: true })
    if (!resolved) {
      throw new Error(`No pnpm version matches "${spec}".`)
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

function extractTarball(tarball: string, destDir: string, entry: string): Promise<void> {
  // A tar executable is available on all GitHub-hosted runners, including
  // Windows (bsdtar ships with Windows since 2019). Only the pnpm binary
  // entry is extracted — the archive holds nothing else the action needs.
  // Backslashes are converted to forward slashes because MSYS-based tar
  // implementations misread them.
  const args = ['-xzf', tarball.replace(/\\/g, '/'), '-C', destDir.replace(/\\/g, '/'), entry]
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
        reject(new Error(`tar exited with code ${code} while extracting ${entry} from ${tarball}`))
      }
    })
  })
}

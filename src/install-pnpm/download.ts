import { info } from '@actions/core'
import { HttpClient } from '@actions/http-client'
import { cacheDir, find } from '@actions/tool-cache'
import { existsSync } from 'fs'
import { chmod, copyFile, link, mkdir, mkdtemp, rename, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import semver from 'semver'
import { downloadPnpm as downloadVerifiedPnpm, isMusl } from 'get-pnpm'

// The action installs pnpm's self-contained executable and uses `pnpm runtime`
// to install a JavaScript runtime. Both are available from v11 onward, so that
// is the oldest major this action can install.
const MIN_SUPPORTED_MAJOR = 11

// Abbreviated packuments are much smaller than full ones and still carry the
// per-version metadata needed to resolve a version spec.
const ABBREVIATED_PACKUMENT = 'application/vnd.npm.install-v1+json'

interface AbbreviatedPackument {
  readonly versions: Record<string, unknown>
}

// HTTPS_PROXY/NO_PROXY are honored automatically by @actions/http-client.
const http = new HttpClient('pnpm/setup', undefined, { allowRetries: true, maxRetries: 3 })

/**
 * A resolved version, and the registry it was resolved against — the download
 * comes from the same one.
 *
 * The registry packages hold the same executable as the GitHub release assets,
 * byte for byte, and npm signs a checksum for them with a key `get-pnpm` pins —
 * so a tampered download cannot pass. GitHub publishes a digest, but serves it
 * from the same place as the asset it describes, which catches corruption
 * rather than tampering.
 */
export interface ResolvedPnpm {
  readonly version: string
  readonly registry: string
}

/**
 * `registry` must end in a slash (see `resolveRegistry`). A mirror has to pass
 * npm's metadata through unchanged: the signature check needs `dist.signatures`.
 */
export async function resolvePnpm(spec: string, registry: string): Promise<ResolvedPnpm> {
  const version = await resolveVersion(spec, registry)
  if (semver.major(version) < MIN_SUPPORTED_MAJOR) {
    throw new Error(`The requested pnpm version "${spec}" resolved to ${version}, but this action only installs pnpm v${MIN_SUPPORTED_MAJOR} or newer.
This action downloads pnpm's self-contained release binary and uses \`pnpm runtime\` to install a JavaScript runtime; both are available from v${MIN_SUPPORTED_MAJOR} onward.
To install older pnpm, use the pnpm/action-setup action instead.`)
  }
  return { version, registry }
}

/**
 * Returns the path to the resolved pnpm executable in the runner's tool cache,
 * downloading it first if the cache does not have that version.
 *
 * The download goes into a temporary directory, and `cacheDir` copies it into
 * the tool cache. `cacheDir` writes the `.complete` marker that `find` checks
 * only after the copy finishes, so a failed download or copy leaves no entry
 * for a later run to find.
 */
export async function installPnpm(resolved: ResolvedPnpm): Promise<string> {
  const arch = toolCacheArch()
  let toolDir = find('pnpm', resolved.version, arch)
  if (toolDir) {
    info(`Found pnpm ${resolved.version} in the tool cache`)
  } else {
    info(`Downloading pnpm ${resolved.version} from ${resolved.registry}`)
    const staging = await mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'setup-pnpm-'))
    try {
      await downloadPnpm(resolved, staging)
      toolDir = await cacheDir(staging, 'pnpm', resolved.version, arch)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  // `cacheDir` copies files instead of preserving hard links, so aliases
  // created before caching would each become a full copy of the executable.
  // They are linked inside the tool cache directory instead.
  const pnpmBin = path.join(toolDir, executableName('pnpm'))
  await linkAliases(pnpmBin)
  return pnpmBin
}

/**
 * pnpm publishes separate executables for musl and glibc Linux on the same
 * CPU, so musl hosts use a separate `<arch>-musl` tool cache entry.
 */
function toolCacheArch(): string {
  return isMusl() ? `${os.arch()}-musl` : os.arch()
}

/**
 * Places the pnpm executable in `destDir`.
 *
 * `get-pnpm` resolves the platform package, checks npm's signature over its
 * checksum against a pinned key, checks the download against that checksum, and
 * places the executable beside the `dist/` tree it loads.
 */
async function downloadPnpm(resolved: ResolvedPnpm, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  await downloadVerifiedPnpm({ versionSpec: resolved.version, registry: resolved.registry, dest: destDir })
  // Up to v11 get-pnpm writes a manifest so that `pnpm setup` installs the
  // wrapper's dependencies. This action never runs setup. It adds this
  // directory to PATH itself, so the manifest would only be a stray project
  // file in a directory on PATH.
  await rm(path.join(destDir, 'package.json'), { force: true })

  if (process.platform !== 'win32') {
    await chmod(path.join(destDir, executableName('pnpm')), 0o755)
  }
}

/**
 * Links the `pnpx`, `pn` and `pnx` aliases next to the executable. The
 * executable checks the name it was invoked by to decide what to run.
 *
 * A cached entry that an earlier job set up already has its aliases, so this
 * skips aliases that exist. Replacing them would also fail on Windows while
 * another process runs the alias.
 */
async function linkAliases(pnpmBin: string): Promise<void> {
  for (const alias of ['pnpx', 'pn', 'pnx']) {
    const aliasPath = path.join(path.dirname(pnpmBin), executableName(alias))
    if (existsSync(aliasPath)) continue
    try {
      await link(pnpmBin, aliasPath)
    } catch {
      // Copy under a temporary name and rename it afterwards. If the copy is
      // interrupted, the alias does not exist, and the next run retries it.
      const partial = `${aliasPath}.partial`
      await copyFile(pnpmBin, partial)
      await rename(partial, aliasPath)
    }
  }
}

function executableName(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name
}

async function resolveVersion(spec: string, registry: string): Promise<string> {
  const exact = semver.valid(spec)
  if (exact) return exact

  if (semver.validRange(spec)) {
    // Resolve ranges against the `pnpm` packument, which lists every published
    // version. Prefer stable releases; fall back to prereleases so ranges like
    // `12` or `^12.0.0` resolve while v12 has only prerelease versions published.
    const available = await fetchPnpmVersions(registry)
    const resolved = semver.maxSatisfying(available, spec)
      ?? semver.maxSatisfying(available, spec, { includePrerelease: true })
    if (!resolved) {
      throw new Error(`No pnpm version matches "${spec}".`)
    }
    return resolved
  }

  // Anything else is treated as a dist-tag (e.g. `next-12`), read from the main
  // `pnpm` package.
  const distTags = await fetchJson<Record<string, string>>(new URL('-/package/pnpm/dist-tags', registry).href)
  const version = distTags[spec]
  if (!version) {
    throw new Error(`"${spec}" is neither a valid pnpm version, a semver range, nor a known dist-tag of pnpm.`)
  }
  return version
}

async function fetchPnpmVersions(registry: string): Promise<string[]> {
  const packument = await fetchJson<AbbreviatedPackument>(
    new URL('pnpm', registry).href,
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


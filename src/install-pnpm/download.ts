import { HttpClient } from '@actions/http-client'
import { chmod, copyFile, link, mkdir, rm } from 'fs/promises'
import path from 'path'
import semver from 'semver'
import { downloadPnpm as downloadVerifiedPnpm } from 'get-pnpm'

// The action installs pnpm's self-contained executable and uses `pnpm runtime`
// to install a JavaScript runtime. Both are available from v11 onward, so that
// is the oldest major this action can install.
const MIN_SUPPORTED_MAJOR = 11

const REGISTRY = 'https://registry.npmjs.org'
// Abbreviated packuments are much smaller than full ones and still carry the
// per-version metadata needed to resolve a version spec.
const ABBREVIATED_PACKUMENT = 'application/vnd.npm.install-v1+json'

interface AbbreviatedPackument {
  readonly versions: Record<string, unknown>
}

// HTTPS_PROXY/NO_PROXY are honored automatically by @actions/http-client.
const http = new HttpClient('pnpm/setup', undefined, { allowRetries: true, maxRetries: 3 })

/**
 * A resolved version, fetched from the npm registry.
 *
 * The registry packages hold the same executable as the GitHub release assets,
 * byte for byte, and npm signs a checksum for them with a key `get-pnpm` pins —
 * so a tampered download cannot pass. GitHub publishes a digest, but serves it
 * from the same place as the asset it describes, which catches corruption
 * rather than tampering.
 */
export interface ResolvedPnpm {
  readonly version: string
}

export async function resolvePnpm(spec: string): Promise<ResolvedPnpm> {
  const version = await resolveVersion(spec)
  if (semver.major(version) < MIN_SUPPORTED_MAJOR) {
    throw new Error(`The requested pnpm version "${spec}" resolved to ${version}, but this action only installs pnpm v${MIN_SUPPORTED_MAJOR} or newer.
This action downloads pnpm's self-contained release binary and uses \`pnpm runtime\` to install a JavaScript runtime; both are available from v${MIN_SUPPORTED_MAJOR} onward.
To install older pnpm, use the pnpm/action-setup action instead.`)
  }
  return { version }
}

/**
 * Places the pnpm executable in `destDir` and returns its path.
 *
 * `get-pnpm` resolves the platform package, checks npm's signature over its
 * checksum against a pinned key, checks the download against that checksum, and
 * places the executable beside the `dist/` tree it loads. The `pnpx`, `pn` and
 * `pnx` aliases are linked next to it, which the binary dispatches on.
 */
export async function downloadPnpm(resolved: ResolvedPnpm, destDir: string): Promise<string> {
  await mkdir(destDir, { recursive: true })
  await downloadVerifiedPnpm({ versionSpec: resolved.version, registry: REGISTRY, dest: destDir })
  // Up to v11 get-pnpm writes a manifest so that `pnpm setup` installs the
  // wrapper's dependencies. This action never runs setup — it owns this
  // directory and puts it on PATH — so the manifest would just be a stray
  // project file sitting where commands run.
  await rm(path.join(destDir, 'package.json'), { force: true })

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


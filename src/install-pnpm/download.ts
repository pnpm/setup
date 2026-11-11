import { existsSync } from 'node:fs'
import { chmod, copyFile, cp, link, mkdir, mkdtemp, readdir, rename, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { info } from '@actions/core'
import { cacheDir, find } from '@actions/tool-cache'
import { downloadPnpm as downloadVerifiedPnpm } from 'get-pnpm'
import semver from 'semver'

import { isMusl } from './musl.js'

// The action installs pnpm's self-contained executable and uses `pnpm runtime`
// to install a JavaScript runtime. Both are available from v11 onward, so that
// is the oldest major this action can install.
const MIN_SUPPORTED_MAJOR = 11

export interface InstalledPnpm {
  version: string
  binPath: string
}

/**
 * Places the pnpm executable matching `spec` in `dest` and returns the version
 * it resolved to and the executable's path, reusing the runner's tool cache on
 * self-hosted runners.
 *
 * pnpm is kept in the tool cache under `pnpm/<version>/<arch>`. An exact
 * `spec` that is already cached is used without downloading anything. A range
 * or a dist-tag is only resolved by downloading it, so it always downloads,
 * and the download is cached under the version it resolved to. The tool cache
 * entry is then linked into `dest`, so `dest` holds pnpm either way.
 *
 * When `RUNNER_TOOL_CACHE` is not set (it is outside the runner, e.g. in
 * `run.sh`), pnpm is downloaded into `dest` instead.
 *
 * `registry` must end in a slash (see `resolveRegistry`). A mirror has to pass
 * npm's metadata through unchanged: the signature check needs `dist.signatures`.
 */
export async function installPnpm (spec: string, registry: string, dest: string): Promise<InstalledPnpm> {
  // An exact version can be rejected before anything is downloaded; anything
  // else is only known once get-pnpm has resolved it.
  const exact = semver.valid(spec)
  if (exact) assertSupported(spec, exact)

  if (!process.env.RUNNER_TOOL_CACHE) {
    info(`Downloading pnpm ${spec} from ${registry}`)
    const installed = await downloadPnpm(spec, registry, dest)
    await linkAliases(installed.binPath)
    return installed
  }

  const arch = toolCacheArch()
  const cached = exact ? find('pnpm', exact, arch) : ''
  let entry: { version: string, toolDir: string }
  if (exact && cached) {
    info(`Found pnpm ${exact} in the tool cache`)
    entry = { version: exact, toolDir: cached }
  } else {
    info(`Downloading pnpm ${spec} from ${registry}`)
    entry = await downloadToToolCache(spec, registry, arch)
  }
  // `cacheDir` copies files instead of preserving hard links, so aliases
  // created before caching would each become a full copy of the executable.
  // They are linked inside the tool cache directory instead.
  await linkAliases(path.join(entry.toolDir, executableName('pnpm')))
  await linkEntries(entry.toolDir, dest)
  return { version: entry.version, binPath: path.join(dest, executableName('pnpm')) }
}

/**
 * Links every file and directory of a tool cache entry into `dest`, so that
 * `<dest>/pnpm` keeps working as it did before the tool cache was used.
 *
 * Files are hard-linked, which keeps the name the executable checks to decide
 * what to run and the directory it loads `dist/` from. Across file systems a
 * file is symlinked instead, or copied on Windows, where creating a symlink
 * needs a privilege. A directory is symlinked, as a junction on Windows, which
 * needs no privilege.
 */
async function linkEntries (toolDir: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(toolDir, { withFileTypes: true })
  await Promise.all(entries.map(entry => entry.isDirectory()
    ? linkDirectory(path.join(toolDir, entry.name), path.join(dest, entry.name))
    : linkFile(path.join(toolDir, entry.name), path.join(dest, entry.name))))
}

async function linkDirectory (source: string, target: string): Promise<void> {
  try {
    await symlink(source, target, 'junction')
  } catch {
    await cp(source, target, { recursive: true })
  }
}

async function linkFile (source: string, target: string): Promise<void> {
  try {
    await link(source, target)
  } catch {
    if (process.platform === 'win32') {
      await copyFile(source, target)
    } else {
      await symlink(source, target)
    }
  }
}

/**
 * Downloads pnpm into a temporary directory and copies it into the tool cache.
 *
 * `cacheDir` writes the `.complete` marker that `find` checks only after the
 * copy finishes, so a failed download or copy leaves no entry for a later run
 * to find.
 */
async function downloadToToolCache (spec: string, registry: string, arch: string): Promise<{ version: string, toolDir: string }> {
  const staging = await mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'setup-pnpm-'))
  try {
    const { version } = await downloadPnpm(spec, registry, staging)
    // A range or a dist-tag can resolve to a version that is already cached.
    // That entry is kept: `cacheDir` deletes an existing entry first, and
    // another job on this runner may be running it.
    const toolDir = find('pnpm', version, arch) || await cacheDir(staging, 'pnpm', version, arch)
    return { version, toolDir }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/**
 * pnpm publishes separate executables for musl and glibc Linux on the same
 * CPU, so musl hosts use a separate `<arch>-musl` tool cache entry.
 */
function toolCacheArch (): string {
  return isMusl() ? `${os.arch()}-musl` : os.arch()
}

/**
 * Places the pnpm executable matching `spec` in `destDir` and returns the
 * version it resolved to and the executable's path.
 *
 * `get-pnpm` resolves `spec` (an exact version, a range or a dist-tag) against
 * the registry, resolves the platform package, checks npm's signature over its
 * checksum against a pinned key, checks the download against that checksum, and
 * places the executable beside the `dist/` tree it loads. It retries requests
 * that fail transiently.
 */
async function downloadPnpm (spec: string, registry: string, destDir: string): Promise<InstalledPnpm> {
  await mkdir(destDir, { recursive: true })
  const { version } = await downloadVerifiedPnpm({ versionSpec: spec, registry, dest: destDir })
  assertSupported(spec, version)
  // Up to v11 get-pnpm writes a manifest so that `pnpm setup` installs the
  // wrapper's dependencies. This action never runs setup. It adds this
  // directory to PATH itself, so the manifest would only be a stray project
  // file in a directory on PATH.
  await rm(path.join(destDir, 'package.json'), { force: true })

  const binPath = path.join(destDir, executableName('pnpm'))
  if (process.platform !== 'win32') {
    await chmod(binPath, 0o755)
  }
  return { version, binPath }
}

/**
 * Links the `pnpx`, `pn` and `pnx` aliases next to the executable. The
 * executable checks the name it was invoked by to decide what to run.
 *
 * A cached entry that an earlier job set up already has its aliases, so this
 * skips aliases that exist. Replacing them would also fail on Windows while
 * another process runs the alias.
 */
async function linkAliases (pnpmBin: string): Promise<void> {
  /* eslint-disable no-await-in-loop -- three small file operations; running them in parallel buys nothing */
  for (const alias of ['pnpx', 'pn', 'pnx']) {
    const aliasPath = path.join(path.dirname(pnpmBin), executableName(alias))
    if (existsSync(aliasPath)) continue
    try {
      await link(pnpmBin, aliasPath)
    } catch (err) {
      // Another job sharing this tool cache created the alias in the meantime.
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
      // Copy under a temporary name and rename it afterwards. If the copy is
      // interrupted, the alias does not exist, and the next run retries it.
      // The name is unique per process so that concurrent jobs do not write
      // to the same file.
      const partial = `${aliasPath}.${process.pid}.partial`
      await copyFile(pnpmBin, partial)
      await rename(partial, aliasPath)
    }
  }
  /* eslint-enable no-await-in-loop */
}

function executableName (name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name
}

function assertSupported (spec: string, version: string): void {
  if (semver.major(version) >= MIN_SUPPORTED_MAJOR) return
  throw new Error(`The requested pnpm version "${spec}" resolved to ${version}, but this action only installs pnpm v${MIN_SUPPORTED_MAJOR} or newer.
This action downloads pnpm's self-contained release binary and uses \`pnpm runtime\` to install a JavaScript runtime; both are available from v${MIN_SUPPORTED_MAJOR} onward.
To install older pnpm, use the pnpm/action-setup action instead.`)
}

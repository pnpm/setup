import { existsSync } from 'node:fs'
import { chmod, copyFile, cp, link, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { info, warning } from '@actions/core'
import { find } from '@actions/tool-cache'
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
  if (exact && cached) {
    info(`Found pnpm ${exact} in the tool cache`)
    // Entries this action creates already have their aliases, so this only
    // writes to the tool cache for an entry created some other way.
    await linkAliases(path.join(cached, executableName('pnpm')))
    await linkEntries(cached, dest)
    return { version: exact, binPath: path.join(dest, executableName('pnpm')) }
  }
  info(`Downloading pnpm ${spec} from ${registry}`)
  return downloadThroughToolCache(spec, registry, arch, dest)
}

/**
 * Downloads pnpm into a temporary directory, adds it to the tool cache and
 * links the tool cache entry into `dest`.
 *
 * When the tool cache cannot take the entry (it is read-only, full, or holds
 * an incomplete entry this action did not create), pnpm is copied into `dest`
 * instead, so the job still gets the pnpm it downloaded.
 */
async function downloadThroughToolCache (spec: string, registry: string, arch: string, dest: string): Promise<InstalledPnpm> {
  const staging = await mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'setup-pnpm-'))
  try {
    const { version } = await downloadPnpm(spec, registry, staging)
    const binPath = path.join(dest, executableName('pnpm'))
    let toolDir: string
    try {
      toolDir = await addToToolCache(staging, version, arch)
    } catch (err) {
      warning(`pnpm ${version} could not be added to the tool cache, so it is installed into ${dest} only: ${(err as Error).message}`)
      await cp(staging, dest, { recursive: true })
      await linkAliases(binPath)
      return { version, binPath }
    }
    await linkEntries(toolDir, dest)
    return { version, binPath }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/**
 * Adds the pnpm in `staging` to the tool cache as `pnpm/<version>/<arch>` and
 * returns the entry's directory.
 *
 * Jobs that share a tool cache can add the same version at the same time, and
 * `find` only returns an entry whose `.complete` marker exists. The entry is
 * therefore filled in a temporary directory beside it, the marker is written,
 * and then the directory is renamed into place, which is atomic. No job
 * deletes or overwrites an entry, because another job may be running it: the
 * job that loses the rename uses the winner's entry, and a range or a dist-tag
 * that resolves to a version that is already cached uses that entry.
 *
 * The aliases are linked after the copy, because copying turns hard links
 * into separate copies of the executable.
 */
async function addToToolCache (staging: string, version: string, arch: string): Promise<string> {
  // `find` looks the entry up under the cleaned version.
  const toolDir = path.join(process.env.RUNNER_TOOL_CACHE!, 'pnpm', semver.clean(version) ?? version, arch)
  const existing = find('pnpm', version, arch)
  if (existing) {
    // As on an exact-version hit, an entry created some other way may lack
    // the aliases.
    await linkAliases(path.join(existing, executableName('pnpm')))
    return existing
  }
  // A directory without a marker was not left by this action, which writes
  // the marker before the directory appears. It may be incomplete.
  if (existsSync(toolDir)) throw new Error(`${toolDir} exists but is not marked complete`)

  await mkdir(path.dirname(toolDir), { recursive: true })
  const partial = await mkdtemp(`${toolDir}.partial-`)
  try {
    await cp(staging, partial, { recursive: true })
    await linkAliases(path.join(partial, executableName('pnpm')))
    await writeFile(`${toolDir}.complete`, '')
    try {
      await rename(partial, toolDir)
    } catch (err) {
      const winner = find('pnpm', version, arch)
      if (!winner) throw err
      return winner
    }
    return toolDir
  } finally {
    await rm(partial, { recursive: true, force: true })
  }
}

/**
 * Links every file and directory of a tool cache entry into `dest`, so that
 * `<dest>/pnpm` keeps working as it did before the tool cache was used.
 *
 * Files are hard-linked, which keeps the name the executable checks to decide
 * what to run and the directory it loads `dist/` from. Where a hard link is
 * not possible (across file systems, for example), a file is symlinked
 * instead, or copied on Windows, where creating a symlink needs a privilege.
 * A directory is symlinked, as a junction on Windows, which needs no
 * privilege, and copied where that is not possible.
 */
async function linkEntries (toolDir: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  // A `.partial` file is an alias another job is still copying, and it can be
  // renamed away at any moment. The finished aliases are already present,
  // because they are linked before the entry is.
  const entries = (await readdir(toolDir, { withFileTypes: true }))
    .filter(entry => !entry.name.endsWith('.partial'))
  await Promise.all(entries.map(entry => entry.isDirectory()
    ? linkDirectory(path.join(toolDir, entry.name), path.join(dest, entry.name))
    : linkFile(path.join(toolDir, entry.name), path.join(dest, entry.name))))
}

async function linkDirectory (source: string, target: string): Promise<void> {
  try {
    await symlink(source, target, 'junction')
  } catch (err) {
    if (!cannotLink(err)) throw err
    await cp(source, target, { recursive: true })
  }
}

async function linkFile (source: string, target: string): Promise<void> {
  try {
    await link(source, target)
  } catch (err) {
    if (!cannotLink(err)) throw err
    if (process.platform === 'win32') {
      await copyFile(source, target)
    } else {
      await symlink(source, target)
    }
  }
}

/**
 * Whether a link failed because the file system or the platform does not
 * allow it there, as opposed to a problem a copy would hit too, such as the
 * target already existing.
 */
function cannotLink (err: unknown): boolean {
  return ['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EMLINK', 'ENOSYS'].includes((err as NodeJS.ErrnoException).code ?? '')
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

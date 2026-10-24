import { chmod, copyFile, link, mkdir, rm } from 'fs/promises'
import path from 'path'
import semver from 'semver'
import { downloadPnpm as downloadVerifiedPnpm } from 'get-pnpm'

// The action installs pnpm's self-contained executable and uses `pnpm runtime`
// to install a JavaScript runtime. Both are available from v11 onward, so that
// is the oldest major this action can install.
const MIN_SUPPORTED_MAJOR = 11

/**
 * Places the pnpm executable matching `spec` in `destDir` and returns the
 * version it resolved to and the executable's path.
 *
 * `registry` must end in a slash (see `resolveRegistry`). A mirror has to pass
 * npm's metadata through unchanged: the signature check needs `dist.signatures`.
 *
 * `get-pnpm` resolves `spec` (an exact version, a range or a dist-tag) against
 * the registry, resolves the platform package, checks npm's signature over its
 * checksum against a pinned key, checks the download against that checksum, and
 * places the executable beside the `dist/` tree it loads. It retries requests
 * that fail transiently. The `pnpx`, `pn` and `pnx` aliases are linked next to
 * the executable, which the binary dispatches on.
 */
export async function downloadPnpm(spec: string, registry: string, destDir: string): Promise<{ version: string, binPath: string }> {
  // An exact version can be rejected before anything is downloaded; anything
  // else is only known once get-pnpm has resolved it.
  const exact = semver.valid(spec)
  if (exact) assertSupported(spec, exact)
  await mkdir(destDir, { recursive: true })
  const { version } = await downloadVerifiedPnpm({ versionSpec: spec, registry, dest: destDir })
  assertSupported(spec, version)
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

  return { version, binPath: pnpmBin }
}

function assertSupported(spec: string, version: string): void {
  if (semver.major(version) >= MIN_SUPPORTED_MAJOR) return
  throw new Error(`The requested pnpm version "${spec}" resolved to ${version}, but this action only installs pnpm v${MIN_SUPPORTED_MAJOR} or newer.
This action downloads pnpm's self-contained release binary and uses \`pnpm runtime\` to install a JavaScript runtime; both are available from v${MIN_SUPPORTED_MAJOR} onward.
To install older pnpm, use the pnpm/action-setup action instead.`)
}

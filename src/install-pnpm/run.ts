import { addPath, exportVariable, info } from '@actions/core'
import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import { mkdir, rm } from 'fs/promises'
import path from 'path'
import util from 'util'
import { parse as parseYaml } from 'yaml'
import { Inputs } from '../inputs'
import { downloadPnpm } from './download'
import { readLockedPnpmVersion } from './locked-version'
import { packageManagerLockfileDirectory, packageManagerManifest } from './project'

export interface SelfInstallerResult {
  binDest: string
  pnpmHome: string
}

export async function runSelfInstaller(inputs: Inputs): Promise<SelfInstallerResult> {
  const { version, dest, packageJsonFile, registry } = inputs

  const checkout = process.env.GITHUB_WORKSPACE
  const manifest = checkout
    ? version
      ? path.resolve(checkout, packageJsonFile)
      : selectPackageManagerManifest(path.resolve(checkout, packageJsonFile), checkout)
    : undefined
  const spec = readTargetVersion({ version, packageJsonFile: manifest ?? packageJsonFile })
  const lockfileDirectory = !version && manifest && checkout
    ? packageManagerLockfileDirectory(path.resolve(checkout, packageJsonFile), manifest)
    : undefined
  const lockedVersion = lockfileDirectory
    ? readLockedPnpmVersion(lockfileDirectory, spec)
    : undefined
  const versionSpec = lockedVersion ?? spec
  info(`Downloading pnpm ${versionSpec} from ${registry}`)

  await rm(dest, { recursive: true, force: true })
  // Create dest/bin upfront: pnpm ≤ 12.0.0-alpha.17 refuses to run
  // `pnpm runtime set -g` when the global bin directory is missing
  // (fixed in alpha.18, but users may pin older versions).
  await mkdir(path.join(dest, 'bin'), { recursive: true })
  const { version: installedVersion, binPath: pnpmBin } = await downloadPnpm(versionSpec, registry, dest)

  // Sanity check — catches a binary that can't run on this system (e.g. a
  // glibc build on a musl-only distro) with a clear error.
  const actualVersion = await readVersion(pnpmBin)
  if (actualVersion !== installedVersion) {
    throw new Error(`The installed pnpm reports version ${actualVersion}, expected ${installedVersion}`)
  }

  // dest doubles as PNPM_HOME: `pnpm runtime set -g` installs runtime
  // binaries into $PNPM_HOME/bin and `pnpm self-update` places its shims
  // there. dest/bin is added after dest so it gets higher PATH precedence —
  // a self-updated pnpm must win over the executable this action installed.
  addPath(dest)
  addPath(path.join(dest, 'bin'))
  exportVariable('PNPM_HOME', dest)

  return { binDest: dest, pnpmHome: dest }
}

/**
 * A workspace root that declares no pnpm version leaves the member's own
 * declaration in charge, as it was before members inherited from the root.
 */
function selectPackageManagerManifest(projectManifest: string, checkout: string): string {
  const rootManifest = packageManagerManifest(projectManifest, checkout)
  if (rootManifest === projectManifest) return rootManifest
  const { packageManager, devEngines } = readPnpmDeclaration(rootManifest)
  const declaresPnpm = (devEngines?.packageManager?.name === 'pnpm' && Boolean(devEngines.packageManager.version)) ||
    (typeof packageManager === 'string' && packageManager.startsWith('pnpm@'))
  return declaresPnpm ? rootManifest : projectManifest
}

interface PnpmDeclaration {
  readonly packageManager?: string
  readonly devEngines?: { packageManager?: { name?: string; version?: string } }
}

function readPnpmDeclaration(packageJsonFile: string): PnpmDeclaration {
  const { GITHUB_WORKSPACE } = process.env
  if (!GITHUB_WORKSPACE) return {}
  try {
    const content = readFileSync(path.resolve(GITHUB_WORKSPACE, packageJsonFile), 'utf8');
    const manifest = packageJsonFile.endsWith('.yaml')
      ? parseYaml(content, { merge: true })
      : JSON.parse(content)
    return { packageManager: manifest.packageManager, devEngines: manifest.devEngines }
  } catch (error: unknown) {
    // Swallow error if package.json doesn't exist in root
    if (!util.types.isNativeError(error) || !('code' in error) || error.code !== 'ENOENT') throw error
    return {}
  }
}

function readTargetVersion(opts: {
  readonly version?: string | undefined
  readonly packageJsonFile: string
}): string {
  const { version, packageJsonFile } = opts
  const { GITHUB_WORKSPACE } = process.env
  const { packageManager, devEngines } = readPnpmDeclaration(packageJsonFile)

  // packageManager is always exact `pnpm@<version>[+<integrity>]` per spec.
  // Strip the integrity hash before resolving.
  const packageManagerVersion =
    typeof packageManager === 'string' && packageManager.startsWith('pnpm@')
      ? packageManager.slice('pnpm@'.length).split('+')[0]
      : undefined

  if (version) {
    if (packageManagerVersion && packageManagerVersion !== version) {
      throw new Error(`Multiple versions of pnpm specified:
  - version ${version} in the GitHub Action config with the key "version"
  - version ${packageManager} in the package.json with the key "packageManager"
Remove one of these versions to avoid version mismatch errors like ERR_PNPM_BAD_PM_VERSION`)
    }

    return version
  }

  // devEngines.packageManager takes priority over packageManager, matching
  // pnpm's getWantedPackageManager logic. Both exact versions and semver
  // ranges are accepted.
  if (devEngines?.packageManager?.name === 'pnpm' && devEngines.packageManager.version) {
    return devEngines.packageManager.version
  }

  if (packageManagerVersion) {
    return packageManagerVersion
  }

  if (!GITHUB_WORKSPACE) {
    throw new Error(`No workspace is found.
If you've intended to let pnpm/setup read preferred pnpm version from the "packageManager" field in the package.json file,
please run the actions/checkout before pnpm/setup.
Otherwise, please specify the pnpm version in the action configuration.`)
  }

  throw new Error(`No pnpm version is specified.
Please specify it by one of the following ways:
  - in the GitHub Action config with the key "version"
  - in the package.json with the key "packageManager"
  - in the package.json with the key "devEngines.packageManager"`)
}

function readVersion(pnpmBin: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Check the downloaded binary itself, not a version selected by the project.
    const cp = spawn(pnpmBin, ['--config.pm-on-fail=ignore', '--version'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let output = ''
    cp.stdout.on('data', (chunk) => { output += chunk })
    cp.on('error', reject)
    cp.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim())
      } else {
        reject(new Error(`"${pnpmBin} --version" exited with code ${code}`))
      }
    })
  })
}

export default runSelfInstaller

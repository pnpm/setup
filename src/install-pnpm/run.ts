import { addPath, exportVariable, info } from '@actions/core'
import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import { mkdir, rm } from 'fs/promises'
import path from 'path'
import util from 'util'
import { parse as parseYaml } from 'yaml'
import { Inputs } from '../inputs'
import { downloadPnpm, resolvePnpm } from './download'

export interface SelfInstallerResult {
  binDest: string
  pnpmHome: string
}

export async function runSelfInstaller(inputs: Inputs): Promise<SelfInstallerResult> {
  const { version, dest, packageJsonFile, token } = inputs

  const spec = readTargetVersion({ version, packageJsonFile })
  const resolved = await resolvePnpm(spec, token)
  info(`Downloading pnpm ${resolved.version} from ${resolved.downloadUrl}`)

  await rm(dest, { recursive: true, force: true })
  // Create dest/bin upfront: pnpm ≤ 12.0.0-alpha.17 refuses to run
  // `pnpm runtime set -g` when the global bin directory is missing
  // (fixed in alpha.18, but users may pin older versions).
  await mkdir(path.join(dest, 'bin'), { recursive: true })
  const pnpmBin = await downloadPnpm(resolved, dest)

  // Sanity check — catches a binary that can't run on this system (e.g. a
  // glibc build on a musl-only distro) with a clear error.
  const actualVersion = await readVersion(pnpmBin)
  if (actualVersion !== resolved.version) {
    throw new Error(`The installed pnpm reports version ${actualVersion}, expected ${resolved.version}`)
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

function readTargetVersion(opts: {
  readonly version?: string | undefined
  readonly packageJsonFile: string
}): string {
  const { version, packageJsonFile } = opts
  const { GITHUB_WORKSPACE } = process.env

  let packageManager: string | undefined
  let devEngines: { packageManager?: { name?: string; version?: string } } | undefined

  if (GITHUB_WORKSPACE) {
    try {
      const content = readFileSync(path.join(GITHUB_WORKSPACE, packageJsonFile), 'utf8');
      const manifest = packageJsonFile.endsWith('.yaml')
        ? parseYaml(content, { merge: true })
        : JSON.parse(content)
      packageManager = manifest.packageManager
      devEngines = manifest.devEngines
    } catch (error: unknown) {
      // Swallow error if package.json doesn't exist in root
      if (!util.types.isNativeError(error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
  }

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
    const cp = spawn(pnpmBin, ['--version'], { stdio: ['ignore', 'pipe', 'inherit'] })
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

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import util from 'node:util'

import { addPath, exportVariable } from '@actions/core'
import { readProjectPin } from 'get-pnpm'
import { parse as parseYaml } from 'yaml'

import { Inputs } from '../inputs/index.js'
import { installPnpm } from './download.js'

export interface SelfInstallerResult {
  binDest: string
  pnpmHome: string
}

export async function runSelfInstaller (inputs: Inputs): Promise<SelfInstallerResult> {
  const { dest, registry } = inputs
  const versionSpec = selectVersionSpec(inputs)

  await rm(dest, { recursive: true, force: true })
  // Create dest/bin upfront: pnpm ≤ 12.0.0-alpha.17 refuses to run
  // `pnpm runtime set -g` when the global bin directory is missing
  // (fixed in alpha.18, but users may pin older versions).
  await mkdir(path.join(dest, 'bin'), { recursive: true })
  const { version: installedVersion, binPath: pnpmBin } = await installPnpm(versionSpec, registry, dest)
  const binDest = path.dirname(pnpmBin)

  // Sanity check — catches a binary that can't run on this system (e.g. a
  // glibc build on a musl-only distro) with a clear error.
  const actualVersion = await readVersion(pnpmBin)
  if (actualVersion !== installedVersion) {
    throw new Error(`The installed pnpm reports version ${actualVersion}, expected ${installedVersion}`)
  }

  // pnpm runs from the tool cache (or from dest when there is none), and dest
  // is PNPM_HOME. `pnpm runtime set -g` installs runtime binaries into
  // $PNPM_HOME/bin, and `pnpm self-update` puts its shims there. addPath
  // prepends, so each later call takes PATH precedence over the earlier ones.
  // That order lets a self-updated pnpm in dest/bin run instead of the
  // executable this action installed.
  if (binDest !== dest) addPath(binDest)
  addPath(dest)
  addPath(path.join(dest, 'bin'))
  exportVariable('PNPM_HOME', dest)

  return { binDest, pnpmHome: dest }
}

/**
 * The `version` input, or else the version the project pins, read the way
 * pnpm reads it to switch versions; see get-pnpm's `readProjectPin`.
 */
function selectVersionSpec ({ version, packageJsonFile }: Inputs): string {
  if (version) {
    assertNoOtherPackageManagerVersion(version, packageJsonFile)
    return version
  }
  const checkout = process.env.GITHUB_WORKSPACE
  if (!checkout) {
    throw new Error(`No workspace is found.
If you've intended to let pnpm/setup read preferred pnpm version from the "packageManager" field in the package.json file,
please run the actions/checkout before pnpm/setup.
Otherwise, please specify the pnpm version in the action configuration.`)
  }
  const pin = readProjectPin(path.dirname(path.resolve(checkout, packageJsonFile)), { root: checkout })
  if (pin == null) {
    throw new Error(`No pnpm version is specified.
Please specify it by one of the following ways:
  - in the GitHub Action config with the key "version"
  - in the package.json with the key "packageManager"
  - in the package.json with the key "devEngines.packageManager"`)
  }
  return pin.lockedVersion ?? pin.spec
}

function assertNoOtherPackageManagerVersion (version: string, packageJsonFile: string): void {
  const packageManager = readPackageManager(packageJsonFile)
  if (!packageManager?.startsWith('pnpm@')) return
  const packageManagerVersion = packageManager.slice('pnpm@'.length).split('+')[0]
  if (!packageManagerVersion || packageManagerVersion === version) return
  throw new Error(`Multiple versions of pnpm specified:
  - version ${version} in the GitHub Action config with the key "version"
  - version ${packageManager} in the package.json with the key "packageManager"
Remove one of these versions to avoid version mismatch errors like ERR_PNPM_BAD_PM_VERSION`)
}

function readPackageManager (packageJsonFile: string): string | undefined {
  const { GITHUB_WORKSPACE } = process.env
  if (!GITHUB_WORKSPACE) return undefined
  try {
    const content = readFileSync(path.resolve(GITHUB_WORKSPACE, packageJsonFile), 'utf8')
    const manifest = packageJsonFile.endsWith('.yaml')
      ? parseYaml(content, { merge: true })
      : JSON.parse(content)
    return typeof manifest?.packageManager === 'string' ? manifest.packageManager : undefined
  } catch (error: unknown) {
    if (!util.types.isNativeError(error) || !('code' in error) || error.code !== 'ENOENT') throw error
    return undefined
  }
}

function readVersion (pnpmBin: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Check the downloaded binary itself, not a version selected by the project.
    const cp = spawn(pnpmBin, ['--config.pm-on-fail=ignore', '--version'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let output = ''
    cp.stdout.on('data', (chunk) => {
      output += chunk
    })
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

import { addPath, exportVariable } from '@actions/core'
import { spawn } from 'child_process'
import { rm, writeFile, mkdir, symlink } from 'fs/promises'
import { readFileSync, existsSync } from 'fs'
import path from 'path'
import util from 'util'
import { Inputs } from '../inputs'
import { parse as parseYaml } from 'yaml'
import exeLock from './bootstrap/exe-lock.json'

const BOOTSTRAP_EXE_PACKAGE_JSON = JSON.stringify({ private: true, dependencies: { '@pnpm/exe': exeLock.packages['node_modules/@pnpm/exe'].version } })

export interface SelfInstallerResult {
  exitCode: number
  binDest: string
  pnpmHome: string
}

export async function runSelfInstaller(inputs: Inputs): Promise<SelfInstallerResult> {
  const { version, dest, packageJsonFile } = inputs

  // Install bootstrap @pnpm/exe via npm (integrity verified by committed lockfile).
  // @pnpm/exe bundles Node.js, so the action never depends on a system Node for
  // the user's runtime — once installed, the pnpm binary can install node/bun/deno
  // via `pnpm runtime set`.
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })

  await writeFile(path.join(dest, 'package.json'), BOOTSTRAP_EXE_PACKAGE_JSON)
  await writeFile(path.join(dest, 'package-lock.json'), JSON.stringify(exeLock))

  // Append the action's node directory to PATH so npm's
  // `#!/usr/bin/env node` shebang resolves on runners (e.g. GHE
  // self-hosted) where node isn't already on PATH. Append (not
  // prepend) so a user-installed toolchain on PATH — e.g. from a
  // prior `setup-node` step — keeps precedence; otherwise the
  // runner-bundled node would shadow it and pair the user's npm
  // with a mismatched node version. npm itself is resolved via
  // PATH — on the GitHub Actions runner it is not co-located with
  // `process.execPath`.
  const nodeDir = path.dirname(process.execPath)
  // On Windows, the PATH key casing varies; search case-insensitively.
  const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
  const currentPath = process.env[pathKey]
  const npmEnv = { ...process.env, [pathKey]: currentPath ? currentPath + path.delimiter + nodeDir : nodeDir }
  const npmExitCode = await runCommand('npm', ['ci'], { cwd: dest, env: npmEnv })
  if (npmExitCode !== 0) {
    const binDest = path.join(dest, 'node_modules', '.bin')
    return { exitCode: npmExitCode, binDest, pnpmHome: binDest }
  }

  // On Windows, npm's .bin shims can't properly execute the extensionless
  // @pnpm/exe native binaries. Add the @pnpm/exe directory directly to PATH
  // so pnpm.exe is found natively.
  const pnpmHome = process.platform === 'win32'
    ? path.join(dest, 'node_modules', '@pnpm', 'exe')
    : path.join(dest, 'node_modules', '.bin')
  // PNPM_HOME/bin is where `pnpm self-update` places the target version
  // binary and where `pnpm runtime set` installs runtime binaries. It must
  // have higher PATH precedence than pnpmHome (which contains the bootstrap
  // pnpm) so the self-updated pnpm and the runtime are found first.
  addPath(pnpmHome)
  addPath(path.join(pnpmHome, 'bin'))
  exportVariable('PNPM_HOME', pnpmHome)

  // Ensure pnpm bin link exists — npm ci sometimes doesn't create it
  if (process.platform !== 'win32') {
    const pnpmBinLink = path.join(dest, 'node_modules', '.bin', 'pnpm')
    if (!existsSync(pnpmBinLink)) {
      await mkdir(path.join(dest, 'node_modules', '.bin'), { recursive: true })
      await symlink(path.join('..', '@pnpm', 'exe', 'pnpm'), pnpmBinLink)
    }
  }

  const bootstrapPnpm = path.join(dest, 'node_modules', '@pnpm', 'exe', process.platform === 'win32' ? 'pnpm.exe' : 'pnpm')

  // Self-update the bootstrap to the requested pnpm version. readTargetVersion
  // either returns a value or throws, so this always runs.
  const targetVersion = readTargetVersion({ version, packageJsonFile })
  const exitCode = await runCommand(bootstrapPnpm, ['self-update', targetVersion], { cwd: dest })
  if (exitCode !== 0) {
    return { exitCode, binDest: pnpmHome, pnpmHome }
  }
  // self-update writes the target pnpm/pnpx into PNPM_HOME/bin, leaving the
  // bootstrap symlinks in pnpmHome pointing at the old version. Use
  // PNPM_HOME/bin so consumers of the bin_dest output invoke the requested
  // version. When the requested version resolves to the bootstrap version,
  // self-update is a no-op and PNPM_HOME/bin is not created — fall back to
  // pnpmHome.
  const updatedBinDir = path.join(pnpmHome, 'bin')
  return {
    exitCode: 0,
    binDest: existsSync(updatedBinDir) ? updatedBinDir : pnpmHome,
    pnpmHome,
  }
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
  // Strip the integrity hash for self-update.
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
  // pnpm's getWantedPackageManager logic. `pnpm self-update` accepts both
  // exact versions and semver ranges, so we pass either through directly.
  if (devEngines?.packageManager?.name === 'pnpm' && devEngines.packageManager.version) {
    return devEngines.packageManager.version
  }

  if (packageManagerVersion) {
    return packageManagerVersion
  }

  if (!GITHUB_WORKSPACE) {
    throw new Error(`No workspace is found.
If you've intended to let pnpm/action-setup-runtime read preferred pnpm version from the "packageManager" field in the package.json file,
please run the actions/checkout before pnpm/action-setup-runtime.
Otherwise, please specify the pnpm version in the action configuration.`)
  }

  throw new Error(`No pnpm version is specified.
Please specify it by one of the following ways:
  - in the GitHub Action config with the key "version"
  - in the package.json with the key "packageManager"
  - in the package.json with the key "devEngines.packageManager"`)
}

function runCommand(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string | undefined> }): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const cp = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: process.platform === 'win32',
    })
    cp.on('error', reject)
    cp.on('close', resolve)
  })
}

export default runSelfInstaller

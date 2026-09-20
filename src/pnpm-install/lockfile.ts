import { spawnSync } from 'child_process'
import path from 'path'

function askPnpm(cwd: string, pnpmBin: string, args: string[]): string | undefined {
  const { status, stdout } = spawnSync(pnpmBin, args, { cwd, encoding: 'utf8' })
  return status === 0 ? stdout?.trim() : undefined
}

/**
 * Workspace membership depends on the selected pnpm version; asking that
 * binary avoids duplicating its rules for excluded projects.
 */
export function findWorkspaceRoot(from: string, pnpmBin: string): string | undefined {
  const modulesDir = askPnpm(from, pnpmBin, ['root', '-w'])
  return modulesDir ? path.dirname(modulesDir) : undefined
}

/** Whether the workspace was configured to keep a lockfile per project. */
export function keepsLockfilePerProject(from: string, pnpmBin: string): boolean {
  return askPnpm(from, pnpmBin, ['config', 'get', 'sharedWorkspaceLockfile']) === 'false'
}

/**
 * The directory an install in `from` reads `pnpm-lock.yaml` from.
 *
 * A workspace keeps one lockfile at its root, so a project it contains installs
 * from there rather than from beside itself — which is why a lockfile sitting
 * in the project directory is not evidence that the install has one.
 */
export function chooseLockfileDir(
  from: string,
  workspaceRoot: string | undefined,
  perProjectLockfile: boolean,
): string {
  return workspaceRoot && !perProjectLockfile ? workspaceRoot : from
}

/** [`chooseLockfileDir`] with both answers asked of the installed pnpm. */
export function lockfileDir(from: string, pnpmBin: string): string {
  const workspaceRoot = findWorkspaceRoot(from, pnpmBin)
  const perProjectLockfile = workspaceRoot !== undefined && keepsLockfilePerProject(from, pnpmBin)
  return chooseLockfileDir(from, workspaceRoot, perProjectLockfile)
}

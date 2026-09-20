import { spawnSync } from 'child_process'
import path from 'path'

/**
 * Run pnpm in `cwd` and return its trimmed stdout, or `undefined` when it
 * exits non-zero.
 *
 * The shell is how this action reaches pnpm on Windows, where the executable is
 * a `.cmd` shim. `command` is a literal with nothing interpolated into it, so
 * it goes as a string rather than as args a shell would concatenate unescaped
 * (Node's DEP0190).
 */
function askPnpm(cwd: string, command: string): string | undefined {
  const { status, stdout } = spawnSync(command, { cwd, encoding: 'utf8', shell: true })
  return status === 0 ? stdout?.trim() : undefined
}

/**
 * The workspace root as the installed pnpm sees it from `from`, or `undefined`
 * when pnpm does not place `from` in a workspace.
 *
 * The rule is not "has an ancestor with a pnpm-workspace.yaml": a directory
 * with a manifest of its own that no `packages` pattern selects is a standalone
 * project, and the lockfile above it is not the one it installs from
 * (pnpm/pnpm#3561). Asking pnpm leaves that rule where it belongs, and follows
 * whichever pnpm the workflow selected.
 */
export function findWorkspaceRoot(from: string): string | undefined {
  const modulesDir = askPnpm(from, 'pnpm root -w')
  return modulesDir ? path.dirname(modulesDir) : undefined
}

/** Whether the workspace was configured to keep a lockfile per project. */
export function keepsLockfilePerProject(from: string): boolean {
  return askPnpm(from, 'pnpm config get sharedWorkspaceLockfile') === 'false'
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
export function lockfileDir(from: string): string {
  const workspaceRoot = findWorkspaceRoot(from)
  // Only a workspace can move the lockfile off the project directory, so the
  // second question is worth a process only when there is one.
  const perProjectLockfile = workspaceRoot !== undefined && keepsLockfilePerProject(from)
  return chooseLockfileDir(from, workspaceRoot, perProjectLockfile)
}

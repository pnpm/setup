import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'

/**
 * The workspace root as the installed pnpm sees it from `from`, or `undefined`
 * when pnpm does not place `from` in a workspace at all.
 *
 * `pnpm root -w` prints the workspace root's `node_modules` from any directory
 * the workspace contains and fails from one it does not, so asking it leaves
 * the membership rule where it belongs. That rule is not "has an ancestor with
 * a pnpm-workspace.yaml": a directory with a manifest of its own that no
 * `packages` pattern selects is a standalone project, and the lockfile above it
 * is not the one it installs from (pnpm/pnpm#3561).
 *
 * A probe that fails for any other reason also answers `undefined`, which
 * leaves the search where the install runs. The worst that costs is a missing
 * lockfile reported for a pnpm that was about to fail on its own.
 */
export function findWorkspaceRoot(from: string): string | undefined {
  // A shell is how this action reaches pnpm on Windows, where the executable
  // is a `.cmd` shim. The command is one literal with nothing interpolated
  // into it, so it goes as a string rather than as args a shell would
  // concatenate unescaped (Node's DEP0190).
  const { status, stdout } = spawnSync('pnpm root -w', {
    cwd: from,
    encoding: 'utf8',
    shell: true,
  })
  if (status !== 0) return undefined

  const modulesDir = stdout?.trim()
  return modulesDir ? path.dirname(modulesDir) : undefined
}

/**
 * The `pnpm-lock.yaml` the install will use, searching from `from` up to
 * `searchRoot` — the workspace root for a project the workspace contains, and
 * `from` itself for one it does not. `githubWorkspace` bounds the climb to the
 * checkout even if pnpm reports a root above it.
 */
export function findLockfile(
  from: string,
  searchRoot: string,
  githubWorkspace: string,
): string | undefined {
  let current = from
  for (;;) {
    const candidate = path.join(current, 'pnpm-lock.yaml')
    if (existsSync(candidate)) return candidate
    if (current === searchRoot || current === githubWorkspace) return undefined

    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { parse } from 'yaml'

/**
 * Included workspace members inherit the root's package-manager declaration.
 * Excluded projects and paths outside the checkout retain their own manifest.
 */
export function packageManagerManifest (manifest: string, checkout: string): string {
  if (!existsSync(manifest)) return manifest
  const boundary = realpathSync(checkout)
  const project = realDirectory(path.dirname(manifest))
  if (project === undefined || !inside(boundary, project)) return manifest

  const root = findWorkspaceRoot(project, boundary)
  if (root === undefined || root === project || !isWorkspaceMember(root, project)) return manifest
  // Do not borrow a lockfile without the manifest that defines its pin.
  return rootManifest(root) ?? manifest
}

function realDirectory (directory: string): string | undefined {
  try {
    return realpathSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** The nearest directory from `project` up to `boundary` that holds a pnpm-workspace.yaml. */
function findWorkspaceRoot (project: string, boundary: string): string | undefined {
  for (let directory = project; ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, 'pnpm-workspace.yaml'))) return directory
    if (directory === boundary) return undefined
  }
}

function isWorkspaceMember (root: string, project: string): boolean {
  const patterns = readPackagesPatterns(path.join(root, 'pnpm-workspace.yaml'))
  const relative = path.relative(root, project).split(path.sep).join('/')
  if (relative.split('/').some(part => part === 'node_modules' || part === 'bower_components')) return false

  const matches = (pattern: string): boolean => path.matchesGlob(
    `${relative}/package.json`,
    `${pattern.replace(/^\.\//, '').replace(/\/$/, '')}/package.json`
  )
  const excludes = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))
  const includes = patterns.filter(pattern => !pattern.startsWith('!'))
  return !excludes.some(matches) && includes.some(matches)
}

function readPackagesPatterns (workspaceFile: string): string[] {
  const workspace = parse(readFileSync(workspaceFile, 'utf8'), { merge: true })
  const patterns: unknown = workspace?.packages ?? ['**']
  if (!Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== 'string')) {
    throw new Error(`Invalid packages patterns in ${workspaceFile}`)
  }
  return patterns
}

function rootManifest (root: string): string | undefined {
  return ['package.json', 'package.yaml']
    .map(name => path.join(root, name))
    .find(candidate => existsSync(candidate))
}

function inside (parent: string, directory: string): boolean {
  const relative = path.relative(parent, directory)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * The inherited manifest and the dependency lockfile can belong to different
 * directories. An explicit `lockfileDir` wins, its relative path measured from
 * the file that sets it, as pnpm does. Otherwise a workspace keeps one lockfile
 * at its root unless `sharedWorkspaceLockfile` is off.
 */
export function packageManagerLockfileDirectory (manifest: string, selectedManifest: string): string {
  const project = path.dirname(manifest)
  const root = path.dirname(selectedManifest)
  const lockfileDir = readWorkspaceSetting(root, 'lockfileDir')
  if (typeof lockfileDir?.value === 'string') return path.resolve(lockfileDir.directory, lockfileDir.value)
  if (project === root) return project
  return readWorkspaceSetting(root, 'sharedWorkspaceLockfile')?.value === false ? project : root
}

interface WorkspaceSetting {
  readonly value: unknown
  /** The directory of the file that sets it, which its relative paths are measured from. */
  readonly directory: string
}

/**
 * A setting of the workspace at `root`, from pnpm-workspace.yaml or from a local
 * file its `include` delegates the setting to. A config dependency can be
 * delegated settings too, but it is not installed before pnpm is.
 */
function readWorkspaceSetting (root: string, name: string): WorkspaceSetting | undefined {
  const workspace = readYamlMapping(path.join(root, 'pnpm-workspace.yaml'))
  if (workspace === undefined) return undefined
  if (name in workspace) return { value: workspace[name], directory: root }
  for (const file of delegatedFiles(root, workspace.include, name)) {
    const settings = readYamlMapping(file)
    if (settings !== undefined && name in settings) return { value: settings[name], directory: path.dirname(file) }
  }
  return undefined
}

/** The local files `include` delegates `name` to, listed by name or with "*". */
function delegatedFiles (root: string, include: unknown, name: string): string[] {
  if (include === null || typeof include !== 'object' || Array.isArray(include)) return []
  return Object.entries(include)
    .filter(([source, delegation]) => /^\.\.?\//.test(source) &&
      (delegation === '*' || (Array.isArray(delegation) && delegation.includes(name))))
    .map(([source]) => path.resolve(root, source))
}

function readYamlMapping (file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined
  const value: unknown = parse(readFileSync(file, 'utf8'), { merge: true })
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

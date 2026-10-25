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
 * directories. An explicit `lockfileDir` wins, and, as pnpm reads it, a
 * relative one names a directory of the workspace. Otherwise a workspace keeps
 * one lockfile at its root unless `sharedWorkspaceLockfile` is off.
 */
export function packageManagerLockfileDirectory (manifest: string, selectedManifest: string): string {
  const project = path.dirname(manifest)
  const root = path.dirname(selectedManifest)
  const workspace = readWorkspaceSettings(root)
  if (typeof workspace?.lockfileDir === 'string') return path.resolve(root, workspace.lockfileDir)
  if (project === root) return project
  return workspace?.sharedWorkspaceLockfile === false ? project : root
}

function readWorkspaceSettings (root: string): Record<string, unknown> | undefined {
  const workspaceFile = path.join(root, 'pnpm-workspace.yaml')
  if (!existsSync(workspaceFile)) return undefined
  return parse(readFileSync(workspaceFile, 'utf8'), { merge: true }) ?? undefined
}

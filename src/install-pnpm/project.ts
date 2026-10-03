import { existsSync, readFileSync, realpathSync } from 'fs'
import path from 'path'
import { parse } from 'yaml'

/**
 * Included workspace members inherit the root's package-manager declaration.
 * Excluded projects and paths outside the checkout retain their own manifest.
 */
export function packageManagerManifest(manifest: string, checkout: string): string {
  if (!existsSync(manifest)) return manifest
  const boundary = realpathSync(checkout)
  let project: string
  try {
    project = realpathSync(path.dirname(manifest))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return manifest
    throw error
  }
  if (!inside(boundary, project)) return manifest

  for (let directory = project; ; directory = path.dirname(directory)) {
    const workspaceFile = path.join(directory, 'pnpm-workspace.yaml')
    if (existsSync(workspaceFile)) {
      if (directory === project) return manifest
      const workspace = parse(readFileSync(workspaceFile, 'utf8'), { merge: true })
      const patterns: unknown = workspace?.packages ?? ['**']
      if (!Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== 'string')) {
        throw new Error(`Invalid packages patterns in ${workspaceFile}`)
      }
      const relative = path.relative(directory, project).split(path.sep).join('/')
      const matches = (pattern: string) => path.matchesGlob(
        `${relative}/package.json`,
        `${pattern.replace(/^\.\//, '').replace(/\/$/, '')}/package.json`,
      )
      const excluded = relative.split('/').some(part => part === 'node_modules' || part === 'bower_components')
        || patterns.some(pattern => pattern.startsWith('!') && matches(pattern.slice(1)))
      const included = patterns.some(pattern => !pattern.startsWith('!') && matches(pattern))
      if (excluded || !included) return manifest

      for (const name of ['package.json', 'package.yaml']) {
        const candidate = path.join(directory, name)
        if (existsSync(candidate)) return candidate
      }
      // Do not borrow a lockfile without the manifest that defines its pin.
      return manifest
    }
    if (directory === boundary) return manifest
  }
}

function inside(parent: string, directory: string): boolean {
  const relative = path.relative(parent, directory)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** The inherited manifest and the dependency lockfile can belong to different directories. */
export function packageManagerLockfileDirectory(manifest: string, selectedManifest: string): string {
  const project = path.dirname(manifest)
  const root = path.dirname(selectedManifest)
  if (project === root) return project
  const workspace = parse(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'), { merge: true })
  return workspace?.sharedWorkspaceLockfile === false ? project : root
}

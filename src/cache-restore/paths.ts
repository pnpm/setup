import path from 'path'

/**
 * `cache-dependency-path` is written relative to the project, so it has to be
 * rebased onto `working-directory` — otherwise a project one level down finds
 * no lockfile at the repository root and the restore throws. Absolute patterns
 * are left alone, and a leading `!` is preserved so exclusions keep excluding.
 */
export function resolveCacheDependencyPath(
  cacheDependencyPath: string,
  workingDirectory: string,
): string {
  if (workingDirectory === '.') return cacheDependencyPath

  return cacheDependencyPath
    .split('\n')
    .map(pattern => pattern.trim())
    .filter(Boolean)
    .map(pattern => rebasePattern(pattern, workingDirectory))
    .join('\n')
}

function rebasePattern(pattern: string, workingDirectory: string): string {
  if (pattern.startsWith('!')) return `!${rebasePattern(pattern.slice(1), workingDirectory)}`
  if (path.isAbsolute(pattern)) return pattern
  return path.join(workingDirectory, pattern)
}

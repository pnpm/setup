/**
 * Whether this host's libc is musl rather than glibc.
 *
 * This is the probe get-pnpm uses to pick the musl executable, which it does
 * not export: glibc builds of Node.js report a `glibcVersionRuntime`, musl
 * builds leave it unset.
 */
export function isMusl (): boolean {
  if (process.platform !== 'linux') return false
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
    return report?.header != null && !report.header.glibcVersionRuntime
  } catch {
    return false
  }
}

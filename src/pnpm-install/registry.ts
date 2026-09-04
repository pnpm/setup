export function buildRegistryAuthArgs(registryUrl: string, registryToken: string): string[] {
  const parsed = new URL(registryUrl)
  const path = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`
  const key = `//${parsed.host}${path}:_authToken`
  return ['config', 'set', key, registryToken]
}

export function buildRegistryAuthArgs(registryUrl: string, registryToken: string): string[] {
  const url = registryUrl.endsWith('/') ? registryUrl : `${registryUrl}/`
  return ['config', 'set', `${url}/:_authToken`, registryToken]
}

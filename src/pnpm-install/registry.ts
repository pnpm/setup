import type { RegistryConfig } from '../inputs'

export function registryInstallEnv(registry: RegistryConfig | undefined, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...environment }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'INPUT_REGISTRY-TOKEN') delete env[key]
  }
  if (!registry) return env
  const parsed = new URL(registry.registryUrl)
  const path = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`
  env[`pnpm_config_//${parsed.host}${path}:_authToken`] = registry.registryToken
  return env
}

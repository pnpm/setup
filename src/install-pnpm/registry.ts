import { warning } from '@actions/core'

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

// pnpm reads its own `pnpm_config_*` variables; `get-pnpm` and npm read the
// `npm_config_*` ones. Honouring both lets a single job-level variable point
// this action and the `pnpm install` it runs at the same mirror.
const REGISTRY_ENV_VARS = [
  'pnpm_config_registry',
  'PNPM_CONFIG_REGISTRY',
  'npm_config_registry',
  'NPM_CONFIG_REGISTRY',
] as const

/**
 * The registry to resolve and download pnpm from: the `registry` input, else
 * the first registry variable set in `env`, else the npm registry.
 *
 * The result always ends in a slash. Mirrors are often served from a subpath
 * (`https://artifactory.example.com/api/npm/npm-remote`), and
 * `new URL('pnpm', base)` drops the last segment of a base without one.
 */
export function resolveRegistry(input: string, env: NodeJS.ProcessEnv): string {
  const fromEnv = REGISTRY_ENV_VARS.map(name => env[name]?.trim()).find(Boolean)
  const configured = input.trim() || fromEnv || DEFAULT_REGISTRY

  let url: URL
  try {
    url = new URL(configured)
  } catch {
    // Not echoed: an unparseable value may still hold a token.
    throw new Error('Invalid registry URL. Expected an absolute http(s) URL, e.g. https://registry.npmjs.org/.')
  }
  // Credentials in the URL would end up in logs and error messages, and
  // `fetch` refuses such URLs anyway.
  if (url.username || url.password) {
    throw new Error('The registry URL must not contain credentials. Registries that need authentication are not supported yet.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Invalid registry URL "${url.href}". Only http and https registries are supported.`)
  }
  // The download is still checked against npm's signature, but over plain
  // http an attacker can steer which signed version a range or tag picks.
  if (url.protocol === 'http:') {
    warning(`The registry ${url.href} is not served over https, so the pnpm version it resolves can be tampered with in transit.`)
  }
  return url.href.endsWith('/') ? url.href : `${url.href}/`
}

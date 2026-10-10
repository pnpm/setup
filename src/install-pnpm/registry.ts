import { warning } from '@actions/core'

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

/**
 * The registry to resolve and download pnpm from: the `registry` input, else
 * the npm registry.
 *
 * `pnpm_config_registry` and `npm_config_registry` are deliberately not read:
 * workflows already point them at registries that need a token to read, which
 * the download cannot send, and pnpm used to come from npm regardless.
 *
 * The result always ends in a slash. Mirrors are often served from a subpath
 * (`https://artifactory.example.com/api/npm/npm-remote`), and
 * `new URL('pnpm', base)` drops the last segment of a base without one.
 */
export function resolveRegistry(input: string): string {
  const configured = input.trim() || DEFAULT_REGISTRY

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

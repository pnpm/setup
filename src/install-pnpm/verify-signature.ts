import { createVerify } from 'crypto'

import { NPM_SIGNING_KEYS } from './npm-signing-keys'

export interface PackageSignature {
  readonly keyid: string
  readonly sig: string
}

/**
 * Checks the registry's signature over a package's identity and checksum.
 *
 * The registry serves both the tarball and the checksum, so a checksum taken
 * from it proves nothing on its own. The signature is what makes it worth
 * something: it is made with a key npm publishes but the download host cannot
 * mint, and the trusted copy of that key is pinned in this action.
 *
 * @throws if the package is unsigned, signed with a key that isn't pinned or
 * has expired, or the signature does not verify.
 */
export function verifyRegistrySignature(opts: {
  readonly name: string
  readonly version: string
  readonly integrity: string
  readonly signatures?: readonly PackageSignature[]
}): void {
  const pkg = `${opts.name}@${opts.version}`
  const signature = opts.signatures?.[0]
  if (!signature) {
    throw new Error(`${pkg} carries no npm registry signature, so it cannot be verified.`)
  }

  const key = NPM_SIGNING_KEYS.find(({ keyid }) => keyid === signature.keyid)
  if (!key) {
    throw new Error(`${pkg} is signed with an unexpected npm key (${signature.keyid}). `
      + 'If npm has rotated its signing key, this action needs updating.')
  }
  if (key.expires && new Date(key.expires) < new Date()) {
    throw new Error(`${pkg} is signed with an npm key that expired on ${key.expires}.`)
  }

  // Registry signatures cover the package identity and its content hash.
  const message = `${pkg}:${opts.integrity}`
  const publicKey = `-----BEGIN PUBLIC KEY-----\n${key.key}\n-----END PUBLIC KEY-----`
  if (!createVerify('SHA256').update(message).verify(publicKey, signature.sig, 'base64')) {
    throw new Error(`The npm registry signature for ${pkg} is not valid. Refusing to install.`)
  }
}

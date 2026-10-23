import { warning } from '@actions/core'

/**
 * `get-pnpm` fetches the registry metadata and the tarball exactly once,
 * with a single 30s timeout, so one slow or reset connection fails the whole
 * job. A small bounded retry with backoff clears those transient cases
 * without hiding real configuration errors.
 */
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 1000

const TRANSIENT_MESSAGE =
  /timed out|fetch failed|socket hang up|\bECONNRESET\b|\bETIMEDOUT\b|\bECONNABORTED\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bEHOSTUNREACH\b|\bENETUNREACH\b|\bEPIPE\b|\bUND_ERR|\b429\b|\b5\d\d\b/i

const TRANSIENT_CODE = /^(ECONNRESET|ETIMEDOUT|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR)/

/**
 * True when an error looks like a transient network or registry failure that
 * a retry can clear: timeouts, connection-level errors, HTTP 429 and 5xx.
 * Anything else — an unknown version, another 4xx, or a failed npm signature
 * or checksum verification — is final and must not be retried.
 */
export function isTransientNetworkError(error: unknown, depth = 0): boolean {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return false
  const err = error as {
    message?: unknown
    code?: unknown
    status?: unknown
    statusCode?: unknown
    cause?: unknown
  }
  const status =
    typeof err.statusCode === 'number'
      ? err.statusCode
      : typeof err.status === 'number'
        ? err.status
        : undefined
  if (status === 429 || (status !== undefined && status >= 500 && status < 600)) return true
  if (typeof err.code === 'string' && TRANSIENT_CODE.test(err.code)) return true
  if (typeof err.message === 'string' && TRANSIENT_MESSAGE.test(err.message)) return true
  return depth < 3 && isTransientNetworkError(err.cause, depth + 1)
}

export interface RetryOptions {
  readonly maxAttempts?: number
  readonly baseDelayMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Runs `fn`, retrying transient network failures with exponential backoff
 * (1s, 2s, ... by default). Non-transient errors propagate immediately.
 */
export async function withRetries<T>(
  label: string,
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    sleep = defaultSleep,
  } = options
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientNetworkError(error)) throw error
      const delayMs = baseDelayMs * 2 ** (attempt - 1)
      warning(
        `${label} failed (attempt ${attempt}/${maxAttempts}): ${errorMessage(error)} Retrying in ${delayMs / 1000}s.`,
      )
      await sleep(delayMs)
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

import { restoreCache, saveCache } from '@actions/cache'
import { debug, getState, info, saveState, warning } from '@actions/core'
import { getExecOutput } from '@actions/exec'
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { removeWindowsExtendedPathPrefix } from '../windows-path'

/**
 * Where pnpm v11+ memoizes which lockfile passed which supply-chain policies.
 * A job without it re-checks every lockfile entry against the registry, which
 * on a large repository costs more than the install.
 */
const VERIFICATION_CACHE_FILE = 'lockfile-verified.jsonl'

const PATH_STATE = 'lockfile_verification_cache_path'
const KEY_STATE = 'lockfile_verification_cache_key'
const STORED_STATE = 'lockfile_verification_cache_stored'
const SNAPSHOT_STATE = 'lockfile_verification_cache_snapshot'

/**
 * Where the log lives and under which key it belongs in the cache. Held in
 * memory as well as in the action's state because the main and post steps run
 * as separate processes, and state written by one is only readable by the
 * other.
 */
let target: { cacheFilePath: string, key: string } | undefined

/** Whether this process already restored or saved the log. */
let stored = false

/**
 * The log as it stood before the install ran, as a record count and a digest
 * over those records. Held this way rather than as the records themselves so
 * it survives into the post step: the two run as separate processes, and a
 * log near pnpm's thousand-record compaction threshold is far too large to
 * hand across in the action's state.
 */
interface LogSnapshot {
  readonly count: number
  readonly digest: string
}

let snapshotBeforeInstall: LogSnapshot | undefined

/**
 * The verdict is only valid for the exact lockfile content it was recorded
 * for, so this cache is keyed on the same lockfile hash as the store cache
 * but restored without prefix fallback: an older entry could never be used.
 */
export async function restoreVerificationCache(lockfileHash: string): Promise<void> {
  try {
    const cacheFilePath = path.join(await getPnpmCacheDirectory(), VERIFICATION_CACHE_FILE)
    const key = `pnpm-lockfile-verified-${process.env.RUNNER_OS}-${os.arch()}-${lockfileHash}`
    target = { cacheFilePath, key }
    saveState(PATH_STATE, cacheFilePath)
    saveState(KEY_STATE, key)
    debug(`Lockfile verification cache path is ${cacheFilePath}, key is ${key}`)

    const restoredKey = await restoreCache([cacheFilePath], key)
    if (!restoredKey) {
      info('Lockfile verification cache is not found')
      return
    }

    stored = true
    saveState(STORED_STATE, 'true')
    info(`Lockfile verification cache restored from key: ${restoredKey}`)
  } catch (error) {
    // The gate only costs time, never correctness — a job that cannot reuse
    // a past verdict re-verifies and moves on.
    warning(`Failed to restore the lockfile verification cache: ${(error as Error).message}`)
  }
}

/**
 * Record the log's shape immediately before the install whose growth is about
 * to be bounded. Taken here rather than when the cache is restored because the
 * runtime installs that run in between append a record each — and because on a
 * cold cache the log does not exist yet at restore time, which would waive the
 * check for exactly the runs that go on to publish a new entry.
 */
export function snapshotVerificationLog(): void {
  const cacheFilePath = target?.cacheFilePath ?? getState(PATH_STATE)
  if (!cacheFilePath) return

  const records = readRecords(cacheFilePath)
  if (records === undefined) return

  snapshotBeforeInstall = { count: records.length, digest: digestRecords(records) }
  saveState(SNAPSHOT_STATE, JSON.stringify(snapshotBeforeInstall))
}

/**
 * Uploaded as soon as the install that produced the log finishes, rather than
 * at the end of the job: whatever a job runs after installing can rewrite the
 * log on disk, and the job's own cache write would then publish that for later
 * jobs to trust. Lifecycle scripts of the installed packages stay inside the
 * window — they run during the install — but pnpm only runs those the
 * repository has allow-listed, and `expectedNewRecords` catches what they
 * append.
 *
 * Safe to call more than once; the second call is a no-op.
 */
export async function saveVerificationCache(expectedNewRecords = Infinity): Promise<void> {
  if (stored || getState(STORED_STATE) === 'true') return

  const cacheFilePath = target?.cacheFilePath ?? getState(PATH_STATE)
  const key = target?.key ?? getState(KEY_STATE)
  if (!cacheFilePath || !key || !existsSync(cacheFilePath)) return

  if (!onlyGrewAsExpected(cacheFilePath, expectedNewRecords)) return

  try {
    const cacheId = await saveCache([cacheFilePath], key)
    if (cacheId === -1) return
    stored = true
    saveState(STORED_STATE, 'true')
    info(`Lockfile verification cache saved with the key: ${key}`)
  } catch (error) {
    warning(`Failed to save the lockfile verification cache: ${(error as Error).message}`)
  }
}

/**
 * An install appends its own verdict and leaves every earlier record in place.
 * Anything else — a record the install did not write, or an earlier one gone —
 * means something other than pnpm's verification wrote to the log, and
 * uploading it would hand that to every later job. pnpm compacting the log
 * (past a thousand records) lands here too, at the cost of one re-verification.
 */
function onlyGrewAsExpected(cacheFilePath: string, expectedNewRecords: number): boolean {
  const before = snapshotBeforeInstall ?? readSnapshotState()
  if (before === undefined) return true

  const after = readRecords(cacheFilePath)
  if (after === undefined) return false

  if (after.length < before.count || digestRecords(after.slice(0, before.count)) !== before.digest) {
    warning(
      'Records that predate the install are missing from the lockfile verification log; not caching it.'
    )
    return false
  }

  const added = after.length - before.count
  if (added > expectedNewRecords) {
    warning(
      `The lockfile verification log gained ${added} records during the install, expected at most ${expectedNewRecords}; not caching it.`
    )
    return false
  }

  return true
}

function readSnapshotState(): LogSnapshot | undefined {
  const raw = getState(SNAPSHOT_STATE)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as LogSnapshot
  } catch {
    return undefined
  }
}

function digestRecords(records: readonly string[]): string {
  return createHash('sha256').update(records.join('\n')).digest('hex')
}

function readRecords(cacheFilePath: string): string[] | undefined {
  try {
    return readFileSync(cacheFilePath, 'utf8').split('\n').filter(Boolean)
  } catch {
    return undefined
  }
}

/**
 * pnpm reports this itself, as of v11 — the oldest release this action
 * installs — so the per-platform default does not need mirroring here.
 * `pnpm config get` would not do: it reports settings, not defaults, and
 * prints `undefined` for an unset `cacheDir`.
 */
async function getPnpmCacheDirectory(): Promise<string> {
  const { stdout } = await getExecOutput('pnpm cache path', undefined, { silent: true })
  const cacheDirectory = stdout.trim()
  if (!cacheDirectory) {
    throw new Error('`pnpm cache path` printed nothing')
  }
  return removeWindowsExtendedPathPrefix(cacheDirectory)
}

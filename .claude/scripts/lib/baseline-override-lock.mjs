/**
 * baseline-override-lock.mjs — advisory lock on
 * `.claude/coordination/baseline-override.lock` guarding per-workstream
 * baseline-override writes and TTL-consistent baseline/override reads.
 *
 * sg-pipeline-efficiency-ws1-convergence-pruning / as-021 / REQ-011:
 *   Baseline overrides may be written concurrently across workstreams. Without
 *   a lock + fstat-consistent read, a TTL reader can see a torn override (a
 *   writer's mid-rename state) or two writers can race and last-writer-win an
 *   override meant to stack. This module implements:
 *     - AC21.1: O_EXCL (`wx` flag) acquire semantics; contended lock → retry.
 *     - AC21.2: 3× exponential-backoff retry; exhaustion → `BASELINE_RACE_ABORT`
 *              (structured error with code `BASELINE_RACE_ABORT`).
 *     - AC21.3: fstat-consistent-read — capture {ino, mtimeMs, size} before
 *              read, re-verify after read, abort with `BASELINE_RACE_ABORT`
 *              if inode/mtime/size moved.
 *     - AC21.4: lock-holder metadata `{pid, workstream_id, acquired_at}`
 *              serialized to the lock file for `inspect-lock`.
 *     - AC21.5 (classifier side): `is_stale` flag for locks whose mtime is
 *              older than `STALE_LOCK_THRESHOLD_MS` (15 min). The
 *              session-checkpoint CLI consumes this classification.
 *
 * Public API (test-contract pinned):
 *   acquire({ lockPath, workstreamId, retries?, baseDelayMs? }) → Promise<handle>
 *   release(handle) → Promise<void>
 *   readOverrideAtomic({ path, onAfterStatHook?, retries?, baseDelayMs? }) → Promise<parsed>
 *   inspectBaselineOverrideLock(lockPath) → snapshot (sync; used by CLI)
 *   releaseBaselineOverrideLock(lockPath) → void (sync; used by CLI force-release)
 *
 * @req REQ-011
 * @spec sg-pipeline-efficiency-ws1-convergence-pruning as-021
 */

import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  existsSync,
  readFileSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';

// =============================================================================
// Constants (no magic numbers — code-quality.md §named-constants)
// =============================================================================

/**
 * Default retry count for `acquire` and `readOverrideAtomic` (AC21.2).
 * Three attempts after the initial try → `BASELINE_RACE_ABORT` on exhaustion.
 */
export const DEFAULT_RETRIES = 3;

/**
 * Default base delay for exponential backoff in milliseconds.
 * Sequence with base=50 → 50, 100, 200 (sum 350ms). Tests pass short base
 * delays (5ms) to keep CI fast; the module treats `baseDelayMs` as the
 * first-retry delay (doubles each subsequent retry).
 */
export const DEFAULT_BASE_DELAY_MS = 50;

/**
 * Stale-lock threshold (AC21.5). Locks whose mtime is older than this are
 * classified stale and eligible for `--force-release`.
 *
 * We use FILE MTIME (not the JSON body's `acquired_at`) because AC21.5 speaks
 * of a "heartbeat": the writer is expected to `utimesSync` the lock file as
 * it makes progress, so an unmoved mtime is the true freshness signal.
 */
export const STALE_LOCK_THRESHOLD_MS = 15 * 60 * 1000;

/** Structured error code surfaced on retry exhaustion and fstat drift. */
export const ERR_BASELINE_RACE_ABORT = 'BASELINE_RACE_ABORT';

/** Stale-lock classification token for audit-log rationale (AC21.5). */
export const STALE_LOCK_RECOVERY = 'STALE_LOCK_RECOVERY';

// =============================================================================
// Structured error class
// =============================================================================

/**
 * Typed error raised by acquire / readOverrideAtomic. Callers branch on
 * `err.code` (no string-matching) — see code-quality.md §structured-errors.
 */
export class BaselineLockError extends Error {
  /**
   * @param {string} message
   * @param {string} code — e.g. `BASELINE_RACE_ABORT`, `INVALID_ARGUMENT`.
   * @param {object} [details] — optional structured fields for logs.
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'BaselineLockError';
    this.code = code;
    this.details = details;
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Async sleep — used inside async acquire/read paths. Unlike session-lock's
 * sync `Atomics.wait`, we need async so `setTimeout`-scheduled lock releases
 * (used by the "retry wins mid-wait" test) can fire during the backoff.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize lock metadata with stable (sorted) keys so inspectors observe
 * deterministic output regardless of writer-local object insertion order.
 */
function serializeHolder(holder) {
  const sorted = {
    acquired_at: holder.acquired_at,
    pid: holder.pid,
    workstream_id: holder.workstream_id,
  };
  return JSON.stringify(sorted);
}

/** Ensure lock parent dir exists. Idempotent; any error bubbles to caller. */
function ensureParentDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Build the backoff delay sequence for `retries` retries, starting at
 * `baseDelayMs` and doubling each step. Tests expect minimum cumulative
 * delay of `base + base*2 + base*4 = 7*base` across 3 retries.
 */
function buildBackoffSchedule(retries, baseDelayMs) {
  const out = [];
  let cur = baseDelayMs;
  for (let i = 0; i < retries; i++) {
    out.push(cur);
    cur *= 2;
  }
  return out;
}

/**
 * Read lock metadata with stat. Returns null if missing; throws on corrupt
 * JSON (inspector will translate to a `corrupt` classification).
 */
function readHolderWithStat(lockPath) {
  if (!existsSync(lockPath)) return null;
  const stat = statSync(lockPath);
  const content = readFileSync(lockPath, 'utf-8');
  const holder = JSON.parse(content);
  return { holder, stat };
}

// =============================================================================
// acquire / release (AC21.1, AC21.2, AC21.4)
// =============================================================================

/**
 * Acquire the baseline-override lock with exponential-backoff retry.
 *
 * Contract (test-pinned):
 *   acquire({ lockPath, workstreamId, retries?, baseDelayMs? }) → handle
 *   - lockPath (required): absolute path to the lock file.
 *   - workstreamId (required): e.g. "ws-1". Serialized into lock metadata.
 *   - retries (default DEFAULT_RETRIES=3): # retries after the initial attempt.
 *   - baseDelayMs (default DEFAULT_BASE_DELAY_MS=50): first retry delay.
 *
 * Returns a handle `{ lockPath, holder }` for use with `release(handle)`.
 *
 * On retry exhaustion with EEXIST: throws `BaselineLockError(BASELINE_RACE_ABORT)`.
 * On non-EEXIST IO error: throws `BaselineLockError(LOCK_IO_ERROR)` immediately.
 *
 * Note: this function does NOT auto-break stale locks. Baseline overrides are
 * operator-level actions whose legitimate lifetime may exceed 15 minutes;
 * stale-breaking is the `--force-release` CLI's job (audit-logged).
 *
 * @param {object} opts
 * @returns {Promise<{lockPath: string, holder: object}>}
 */
export async function acquire(opts = {}) {
  const { lockPath, workstreamId, retries = DEFAULT_RETRIES, baseDelayMs = DEFAULT_BASE_DELAY_MS } =
    opts;

  if (typeof lockPath !== 'string' || lockPath.length === 0) {
    throw new BaselineLockError('acquire: lockPath is required', 'INVALID_ARGUMENT');
  }
  if (typeof workstreamId !== 'string' || workstreamId.length === 0) {
    throw new BaselineLockError('acquire: workstreamId is required', 'INVALID_ARGUMENT');
  }

  ensureParentDir(lockPath);

  const backoff = [0, ...buildBackoffSchedule(retries, baseDelayMs)];

  /** @type {Error | null} */
  let lastErr = null;

  for (let attempt = 0; attempt < backoff.length; attempt++) {
    if (backoff[attempt] > 0) {
      // Allow async scheduling (setTimeout-driven test releases) to fire.
      // eslint-disable-next-line no-await-in-loop
      await sleep(backoff[attempt]);
    }

    try {
      const holder = {
        pid: process.pid,
        workstream_id: workstreamId,
        acquired_at: new Date().toISOString(),
      };
      // `wx` = O_CREAT | O_EXCL | O_WRONLY — atomic create-or-fail.
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, serializeHolder(holder));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return { lockPath, holder };
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'EEXIST') {
        continue;
      }
      throw new BaselineLockError(
        `baseline-override lock acquire failed: ${err.message}`,
        'LOCK_IO_ERROR',
        { osCode: err.code, lockPath },
      );
    }
  }

  // All attempts exhausted. Capture holder for diagnostic breadcrumb.
  /** @type {object | null} */
  let contendedHolder = null;
  try {
    const snap = readHolderWithStat(lockPath);
    contendedHolder = snap ? snap.holder : null;
  } catch {
    // Corrupt lock file — leave null; diagnostic is best-effort.
  }

  throw new BaselineLockError(
    `baseline-override lock contended after ${backoff.length} attempts`,
    ERR_BASELINE_RACE_ABORT,
    {
      lockPath,
      contended_holder: contendedHolder,
      last_os_code: lastErr && lastErr.code,
    },
  );
}

/**
 * Release a lock acquired via `acquire`.
 *
 * Best-effort unlink — errors are swallowed (mirrors session-lock.releaseLock
 * semantics). Callers that need guaranteed release should wrap in try/finally.
 *
 * @param {{lockPath: string}} handle
 */
export async function release(handle) {
  if (!handle || typeof handle.lockPath !== 'string') return;
  try {
    if (existsSync(handle.lockPath)) {
      unlinkSync(handle.lockPath);
    }
  } catch {
    // Ignore — release is best-effort.
  }
}

// =============================================================================
// fstat-consistent read (AC21.3)
// =============================================================================

/**
 * Atomically read-and-parse a baseline or baseline-override JSON file under
 * fstat consistency.
 *
 * Algorithm (per AC21.3 + spec §EDGE-016):
 *   1. stat the file (capture ino, mtimeMs, size).
 *   2. Optional `onAfterStatHook()` — test-only injection point to simulate
 *      a concurrent writer. Production callers omit this.
 *   3. Read file content.
 *   4. stat the file again.
 *   5. If any of {ino, mtimeMs, size} changed → retry up to `retries` times
 *      with exponential backoff; final retry → `BASELINE_RACE_ABORT`.
 *   6. On coherent read → `JSON.parse` the content and return the object.
 *
 * @param {object} opts
 * @param {string} opts.path — absolute path to the file.
 * @param {() => (void|Promise<void>)} [opts.onAfterStatHook] — test injection.
 * @param {number} [opts.retries=DEFAULT_RETRIES] — retry budget.
 * @param {number} [opts.baseDelayMs=DEFAULT_BASE_DELAY_MS] — first-retry delay.
 * @returns {Promise<any>} parsed JSON (null if file missing).
 * @throws {BaselineLockError} with code `BASELINE_RACE_ABORT` on persistent drift.
 */
export async function readOverrideAtomic(opts = {}) {
  const {
    path: filePath,
    onAfterStatHook,
    retries = DEFAULT_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
  } = opts;

  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new BaselineLockError('readOverrideAtomic: path is required', 'INVALID_ARGUMENT');
  }

  if (!existsSync(filePath)) return null;

  const backoff = [0, ...buildBackoffSchedule(retries, baseDelayMs)];

  for (let attempt = 0; attempt < backoff.length; attempt++) {
    if (backoff[attempt] > 0) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(backoff[attempt]);
    }

    let pre;
    try {
      pre = statSync(filePath);
    } catch {
      // File disappeared — treat as absent.
      return null;
    }

    // Test-only race injection. MUST run between the stat and the read.
    if (typeof onAfterStatHook === 'function') {
      // eslint-disable-next-line no-await-in-loop
      await onAfterStatHook();
    }

    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    let post;
    try {
      post = statSync(filePath);
    } catch {
      continue;
    }

    const consistent =
      pre.ino === post.ino &&
      pre.mtimeMs === post.mtimeMs &&
      pre.size === post.size;

    if (!consistent) {
      continue;
    }

    try {
      return content.length === 0 ? null : JSON.parse(content);
    } catch (parseErr) {
      // JSON parse failure is not a fstat race — surface directly.
      throw new BaselineLockError(
        `readOverrideAtomic: JSON parse failed at ${filePath}: ${parseErr.message}`,
        'PARSE_ERROR',
        { filePath },
      );
    }
  }

  throw new BaselineLockError(
    `readOverrideAtomic: fstat-inconsistent after ${backoff.length} attempts`,
    ERR_BASELINE_RACE_ABORT,
    { filePath },
  );
}

// =============================================================================
// Lock inspection (AC21.4, AC21.5 classifier)
// =============================================================================

/**
 * Inspect the current lock holder without taking or releasing the lock.
 *
 * Staleness is computed from the lock file's FILE MTIME (not `acquired_at`),
 * because the spec frames stale-lock detection as a heartbeat signal. A
 * writer is expected to `utimesSync` the lock as it makes progress; an
 * unmoved mtime means no heartbeat for that window.
 *
 * Returned shape:
 *   {
 *     held: boolean,                // true iff lock file exists and parses
 *     holder: {pid, workstream_id, acquired_at} | null,
 *     age_ms: number | null,        // wall-clock age since file mtime
 *     age_seconds: number | null,
 *     is_stale: boolean,            // age_ms >= STALE_LOCK_THRESHOLD_MS
 *     classification: 'held' | 'stale' | 'absent' | 'corrupt',
 *     parse_error?: string,
 *   }
 *
 * @param {string} lockPath
 */
export function inspectBaselineOverrideLock(lockPath) {
  if (!existsSync(lockPath)) {
    return {
      held: false,
      holder: null,
      age_ms: null,
      age_seconds: null,
      is_stale: false,
      classification: 'absent',
    };
  }

  let stat;
  try {
    stat = statSync(lockPath);
  } catch {
    return {
      held: false,
      holder: null,
      age_ms: null,
      age_seconds: null,
      is_stale: false,
      classification: 'absent',
    };
  }

  const ageMs = Date.now() - stat.mtimeMs;
  const isStale = ageMs >= STALE_LOCK_THRESHOLD_MS;

  let holder = null;
  let parseError = null;
  try {
    const content = readFileSync(lockPath, 'utf-8');
    holder = JSON.parse(content);
  } catch (err) {
    parseError = err.message;
  }

  if (parseError) {
    return {
      held: true,
      holder: null,
      age_ms: ageMs,
      age_seconds: Math.floor(ageMs / 1000),
      is_stale: isStale,
      classification: 'corrupt',
      parse_error: parseError,
    };
  }

  return {
    held: true,
    holder,
    age_ms: ageMs,
    age_seconds: Math.floor(ageMs / 1000),
    is_stale: isStale,
    classification: isStale ? 'stale' : 'held',
  };
}

/**
 * Best-effort unlink of the lock file. Sync surface used by the force-release
 * CLI path (which must run under the script's synchronous dispatcher).
 *
 * @param {string} lockPath
 */
export function releaseBaselineOverrideLock(lockPath) {
  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  } catch {
    // Ignore — release is best-effort.
  }
}

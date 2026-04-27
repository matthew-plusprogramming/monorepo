/**
 * compute-hashes-lock.mjs — file-based advisory lock + hash-chained audit-log
 * emission for compute-hashes.mjs.
 *
 * Spec: sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-015-compute-hashes-advisory-lock
 *       §REQ-009 / AC15.1..AC15.4
 *       MasterSpec NFR-5 (hash-chain audit log, event_class = "compute_hashes")
 *
 * Responsibilities:
 *   - Acquire / release an exclusive file-based lock at
 *     `.claude/coordination/compute-hashes.lock` via `fs.open(path, 'wx')`.
 *   - Wait up to LOCK_TIMEOUT_MS with sleep-retry + jitter when the lock is
 *     held by another process.
 *   - Detect pre-lock / post-lock hash divergence and emit a structured
 *     retry signal (NOT an error) on first-run mismatch; caller re-runs the
 *     compute step once with a fresh lock.
 *   - Surface a stable `COMPUTE_HASHES_LOCK_TIMEOUT` error code on timeout.
 *   - Force-release stale locks (> STALE_LOCK_MS) with audit record.
 *   - Append one hash-chained audit entry per invocation (AC15.4) via the
 *     ws-1 `appendAuditEntry` helper. FULL_BLOCK carve-out alignment: the
 *     audit log path is NOT in the FULL_BLOCK basename list — the helper
 *     handles hash-chain integrity and atomic append.
 *
 * Trust model (NFR-13): single trusted maintainer host. Lock file contents
 * are EMPTY (no PID data) — the marker is the file's existence, not its
 * payload. This keeps the lock resistant to stale-PID spoofing attacks and
 * keeps the basename out of any write-protection surface.
 *
 * Jitter: uniform 0..500ms between retries. Prevents thundering-herd when
 * two or more waiters time their retries to the same wall-clock tick.
 *
 * Exit codes (caller enforces via process.exit):
 *   0 — clean run
 *   1 — hash drift (pre-existing behavior)
 *   2 — lock timeout OR structural error (pre-existing semantics)
 *
 * The audit entry is emitted by the caller (compute-hashes.mjs) BEFORE
 * process.exit so it lands regardless of exit code (AC15.4). This module
 * exposes `emitComputeHashesAuditEntry` for that purpose.
 */

import {
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { appendAuditEntry } from '../pipeline-efficiency-audit-log.mjs';

// =============================================================================
// Named constants (no magic numbers).
// =============================================================================

/** Relative path (from project root) to the advisory lock file. */
export const LOCK_RELATIVE_PATH = '.claude/coordination/compute-hashes.lock';

/** Lock-acquisition wall-clock budget before emitting COMPUTE_HASHES_LOCK_TIMEOUT. */
export const LOCK_TIMEOUT_MS = 30_000;

/** Max jitter between retries. Actual sleep = Math.random() * LOCK_RETRY_MAX_JITTER_MS. */
export const LOCK_RETRY_MAX_JITTER_MS = 500;

/** Base minimum sleep between retries. Keeps tight spin off the CPU when contention is very brief. */
export const LOCK_RETRY_BASE_SLEEP_MS = 50;

/** Lock files older than this are treated as stale and force-released. */
export const STALE_LOCK_MS = 60_000;

/** Directory mode when bootstrapping `.claude/coordination/`. */
const COORDINATION_DIR_MODE = 0o755;

/**
 * Fallback labels recorded in the audit entry's `fallback_applied` field.
 * Keep as a frozen enum so callers cannot pass ad-hoc strings (AC15.4 shape).
 */
export const FALLBACK_LABELS = Object.freeze({
  NONE: 'none',
  RETRY: 'retry-on-pre-lock-conflict',
});

/** Event-class used by the audit entry; matches canonical NFR-5 enum. */
export const AUDIT_EVENT_CLASS = 'compute_hashes';

/** Gate token recorded in audit payload; matches as-015 AC15.4 shape. */
export const AUDIT_GATE = 'pre-unify';

// =============================================================================
// Errors
// =============================================================================

/**
 * Structured error codes surfaced by this module. Callers branch on `.code`
 * for flow control without string-matching messages.
 */
export const ERROR_CODES = Object.freeze({
  COMPUTE_HASHES_LOCK_TIMEOUT: 'COMPUTE_HASHES_LOCK_TIMEOUT',
});

/**
 * Thrown when lock acquisition exceeds LOCK_TIMEOUT_MS. Caller maps to
 * process.exit(2) after emitting the audit entry.
 */
export class LockTimeoutError extends Error {
  constructor(waitedMs, lockPath) {
    super(
      `COMPUTE_HASHES_LOCK_TIMEOUT: lock at ${lockPath} held by another process ` +
        `for ${waitedMs}ms (exceeded ${LOCK_TIMEOUT_MS}ms timeout)`
    );
    this.name = 'LockTimeoutError';
    this.code = ERROR_CODES.COMPUTE_HASHES_LOCK_TIMEOUT;
    this.details = { waitedMs, lockPath };
  }
}

// =============================================================================
// Lock primitives
// =============================================================================

/**
 * Resolve the absolute lock path under the supplied project root.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
export function resolveLockPath(projectRoot) {
  return join(projectRoot, LOCK_RELATIVE_PATH);
}

/**
 * Ensure the `.claude/coordination/` directory exists. Idempotent.
 *
 * @param {string} lockPath
 */
function ensureCoordinationDir(lockPath) {
  const dir = dirname(lockPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: COORDINATION_DIR_MODE });
  }
}

/**
 * Attempt a single create-exclusive open (`O_EXCL | O_CREAT | O_WRONLY`).
 * Success => lock acquired. EEXIST => lock already held.
 *
 * @param {string} lockPath
 * @returns {{ acquired: boolean, fd?: number, error?: Error }}
 */
function tryAcquireOnce(lockPath) {
  try {
    // 'wx' maps to O_WRONLY | O_CREAT | O_EXCL. Mutually-exclusive with any
    // existing file — which is exactly the advisory-lock semantics we need.
    const fd = openSync(lockPath, 'wx');
    return { acquired: true, fd };
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return { acquired: false };
    }
    // Anything else (EACCES, ENOENT on parent dir, etc.) is a structural
    // failure — propagate so caller can surface it distinctly from contention.
    return { acquired: false, error: err };
  }
}

/**
 * Return the lock file's age in ms, or null if it does not exist.
 *
 * @param {string} lockPath
 * @returns {number | null}
 */
function lockAgeMs(lockPath) {
  try {
    const st = statSync(lockPath);
    return Date.now() - st.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Force-release a stale lock (> STALE_LOCK_MS old). Best-effort: if the
 * unlink fails the caller will re-observe contention on the next attempt.
 *
 * @param {string} lockPath
 * @returns {boolean} true if a stale lock was unlinked
 */
function forceReleaseIfStale(lockPath) {
  const age = lockAgeMs(lockPath);
  if (age === null) return false;
  if (age <= STALE_LOCK_MS) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the advisory lock, blocking via sleep-retry with jitter up to
 * LOCK_TIMEOUT_MS. On success returns the open fd + the wall-clock wait in
 * ms. On timeout throws `LockTimeoutError`.
 *
 * Stale-lock handling: if contention is observed AND the existing lock's
 * mtime is older than STALE_LOCK_MS, the stale lock is force-released and
 * acquisition retried on the next iteration.
 *
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {number} [options.timeoutMs]   override LOCK_TIMEOUT_MS for tests
 * @param {() => number} [options.now]   injectable wall clock for tests
 * @returns {Promise<{ fd: number, lockPath: string, waitedMs: number, forceReleasedStale: boolean }>}
 */
export async function acquireLock(options) {
  const projectRoot = options.projectRoot;
  if (!projectRoot) {
    throw new Error('acquireLock: projectRoot is required');
  }
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const lockPath = resolveLockPath(projectRoot);

  ensureCoordinationDir(lockPath);

  const startedAt = now();
  let forceReleasedStale = false;

  for (;;) {
    const attempt = tryAcquireOnce(lockPath);
    if (attempt.acquired) {
      return {
        fd: attempt.fd,
        lockPath,
        waitedMs: now() - startedAt,
        forceReleasedStale,
      };
    }

    if (attempt.error) {
      throw attempt.error;
    }

    // Contention: lock exists. Check for staleness before sleeping.
    if (forceReleaseIfStale(lockPath)) {
      forceReleasedStale = true;
      // Loop back immediately — a successful stale-release means the next
      // tryAcquireOnce should succeed (or re-observe fresh contention from
      // a third process, which is still correct behavior).
      continue;
    }

    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) {
      throw new LockTimeoutError(elapsed, lockPath);
    }

    // Sleep with jitter. Base + uniform jitter keeps any stall off a single
    // cadence. Using timers/promises.setTimeout to avoid importing a legacy
    // setTimeout callback form.
    const jitter = Math.random() * LOCK_RETRY_MAX_JITTER_MS;
    await sleep(LOCK_RETRY_BASE_SLEEP_MS + jitter);
  }
}

/**
 * Release the advisory lock. Closes the fd and unlinks the file. Silently
 * tolerates "already gone" conditions — another process may have force-
 * released a stale copy, or the file may have been cleaned up between
 * acquire and release.
 *
 * @param {{ fd: number, lockPath: string }} held
 */
export function releaseLock(held) {
  if (!held) return;
  try {
    closeSync(held.fd);
  } catch {
    // fd may already be invalid — ignore
  }
  try {
    unlinkSync(held.lockPath);
  } catch {
    // file may already be gone — ignore
  }
}

// =============================================================================
// Audit-log emission
// =============================================================================

/**
 * Build the payload shape for the `compute_hashes` audit event. Keeping the
 * shape in one place prevents consumer drift (AC15.4).
 *
 * @param {object} fields
 * @param {string | null} fields.spec_group_id
 * @param {number} fields.hashes_count
 * @param {boolean} fields.drift_detected
 * @param {number} fields.exit_code
 * @param {number} fields.lock_wait_ms
 * @param {string} fields.fallback_applied  one of FALLBACK_LABELS values
 * @param {string} [fields.gate]            default AUDIT_GATE
 * @returns {Record<string, unknown>}
 */
export function buildComputeHashesAuditPayload(fields) {
  return {
    gate: fields.gate ?? AUDIT_GATE,
    spec_group_id: fields.spec_group_id ?? null,
    hashes_count: fields.hashes_count,
    drift_detected: fields.drift_detected,
    exit_code: fields.exit_code,
    lock_wait_ms: fields.lock_wait_ms,
    fallback_applied: fields.fallback_applied,
  };
}

/**
 * Append one hash-chained audit entry describing this compute-hashes
 * invocation. Emits at the END of execution (pre-exit) so the record
 * captures the final exit_code + drift outcome (AC15.4).
 *
 * Errors from `appendAuditEntry` are swallowed INTO a structured warning on
 * stderr rather than re-thrown. Rationale: the audit entry is a record-
 * keeping concern; failing to append must not change the compute-hashes
 * exit code (which already reflects the actual compute outcome). The
 * warning surfaces the failure for offline forensics without masking the
 * primary signal.
 *
 * @param {object} params
 * @param {string} params.projectRoot
 * @param {string | null} params.spec_group_id
 * @param {number} params.hashes_count
 * @param {boolean} params.drift_detected
 * @param {number} params.exit_code
 * @param {number} params.lock_wait_ms
 * @param {string} params.fallback_applied
 * @returns {{ appended: boolean, seq?: number, error?: Error }}
 */
export function emitComputeHashesAuditEntry(params) {
  const payload = buildComputeHashesAuditPayload({
    spec_group_id: params.spec_group_id ?? null,
    hashes_count: params.hashes_count,
    drift_detected: params.drift_detected,
    exit_code: params.exit_code,
    lock_wait_ms: params.lock_wait_ms,
    fallback_applied: params.fallback_applied,
  });

  const event_subtype = `verify-exit-${params.exit_code}`;

  try {
    const { seq } = appendAuditEntry(AUDIT_EVENT_CLASS, event_subtype, payload, {
      actor: 'agent',
      projectRoot: params.projectRoot,
    });
    return { appended: true, seq };
  } catch (err) {
    // Do not mask the primary exit code. Emit a structured warning so
    // operators can correlate missed audit writes.
    const errorCode =
      err && typeof err === 'object' && 'code' in err ? err.code : null;
    const errorMessage =
      err && typeof err === 'object' && 'message' in err
        ? err.message
        : String(err);
    console.warn(
      JSON.stringify({
        level: 'warn',
        source: 'compute-hashes-lock',
        reason: 'audit_append_failed',
        error_code: errorCode,
        error_message: errorMessage,
      })
    );
    return { appended: false, error: err };
  }
}

// =============================================================================
// Pre-lock hash-conflict retry signal
// =============================================================================

/**
 * Build a structured retry signal. AC15.3 mandates this is NOT an error —
 * the caller should emit it to stderr (for operator visibility) and re-run
 * the compute step once. Consumers can match on `retry: true` to decide.
 *
 * @param {object} fields
 * @param {string[]} fields.diverged_artifact_ids
 * @returns {{ retry: true, reason: string, diverged_artifact_ids: string[] }}
 */
export function buildPreLockRetrySignal(fields) {
  return {
    retry: true,
    reason: 'pre-lock-hash-conflict',
    diverged_artifact_ids: fields.diverged_artifact_ids,
  };
}

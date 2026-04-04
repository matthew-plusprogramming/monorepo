/**
 * Session JSON Lockfile Module
 *
 * Provides mutex-style locking for session.json writes using a lockfile
 * containing the writer's PID and creation timestamp. Supports stale lock
 * detection (30s threshold), single retry (100ms delay), and configurable
 * fail-open/fail-closed behavior.
 *
 * Implements: REQ-029 (AC-1.11, AC-1.12, AC-1.13), REQ-034
 * Spec: sg-convergence-audit-enforcement
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';

/** Stale lockfile threshold in milliseconds (30 seconds per REQ-034). */
const STALE_THRESHOLD_MS = 30_000;

/** Retry delay in milliseconds (per AC-1.13). */
const RETRY_DELAY_MS = 100;

/**
 * Synchronous sleep using Atomics.wait for a true blocking delay.
 * @param {number} ms - Milliseconds to sleep
 */
function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Attempt to acquire the lockfile at the given path.
 *
 * The lockfile contains JSON with `pid` and `created_at` fields.
 * If the lock already exists and is not stale, retries once after 100ms.
 * If still held, behavior depends on `failOpen` option.
 *
 * @param {string} lockPath - Absolute path to the lockfile
 * @param {object} [opts] - Options
 * @param {boolean} [opts.failOpen=true] - If true, return false on failure; if false, throw
 * @returns {boolean} true if lock was acquired, false if not (only when failOpen=true)
 * @throws {Error} When failOpen=false and lock cannot be acquired
 */
export function acquireLock(lockPath, opts = {}) {
  const failOpen = opts.failOpen !== undefined ? opts.failOpen : true;

  // Try to acquire, with stale detection
  const acquired = tryAcquireLock(lockPath);
  if (acquired) return true;

  // AC-1.13: Retry once after 100ms
  syncSleep(RETRY_DELAY_MS);
  const retryAcquired = tryAcquireLock(lockPath);
  if (retryAcquired) return true;

  // Lock still held after retry
  if (failOpen) {
    process.stderr.write(
      `[session-lock] WARNING: Could not acquire lock at ${lockPath} after retry -- skipping write (fail-open)\n`
    );
    return false;
  }

  throw new Error(
    `Could not acquire lock at ${lockPath} after retry -- write aborted (fail-closed)`
  );
}

/**
 * Single attempt to acquire the lock.
 * Handles stale lock detection and force-acquisition.
 *
 * @param {string} lockPath - Absolute path to the lockfile
 * @returns {boolean} true if lock was acquired
 */
function tryAcquireLock(lockPath) {
  // Attempt atomic create-if-not-exists using 'wx' flag to avoid TOCTOU race
  try {
    const lockData = {
      pid: process.pid,
      created_at: new Date().toISOString(),
    };
    writeFileSync(lockPath, JSON.stringify(lockData), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') {
      // Unexpected error (e.g., permission denied) -- treat as lock failure
      return false;
    }
  }

  // Lock exists -- check if stale
  try {
    const content = readFileSync(lockPath, 'utf-8');
    const lockData = JSON.parse(content);
    const createdAt = new Date(lockData.created_at).getTime();
    const ageMs = Date.now() - createdAt;

    if (ageMs >= STALE_THRESHOLD_MS) {
      // AC-1.12: Stale lock -- force-acquire with warning
      process.stderr.write(
        `[session-lock] WARNING: Force-acquiring stale lock (PID: ${lockData.pid}, age: ${Math.round(ageMs / 1000)}s)\n`
      );
      writeLockFile(lockPath);
      return true;
    }
  } catch {
    // Lock file is corrupt -- treat as stale, force-acquire
    process.stderr.write(
      '[session-lock] WARNING: Corrupt lockfile detected -- force-acquiring\n'
    );
    writeLockFile(lockPath);
    return true;
  }

  // Lock is held and not stale
  return false;
}

/**
 * Write the lockfile with the current process PID and timestamp.
 * @param {string} lockPath - Absolute path to the lockfile
 */
function writeLockFile(lockPath) {
  const lockData = {
    pid: process.pid,
    created_at: new Date().toISOString(),
  };
  writeFileSync(lockPath, JSON.stringify(lockData));
}

/**
 * Release the lockfile by deleting it.
 * Silently ignores errors (e.g., already deleted).
 *
 * @param {string} lockPath - Absolute path to the lockfile
 */
export function releaseLock(lockPath) {
  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  } catch {
    // Ignore errors on release -- best effort cleanup
  }
}

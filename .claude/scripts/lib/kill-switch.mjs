#!/usr/bin/env node

/**
 * Kill-switch sentinel reader with TOCTOU hardening.
 *
 * Spec: sg-enforcement-layer-gaps
 * Implements AC-5.5 (kill-switch inode pinning, SECURITY-TAGGED) and AC-3.4/AC-3.5
 * OR-gate semantics for the shape-lint kill-switch dual-input (file sentinel +
 * env var).
 *
 * Threat model (chk-sec-93be7c42): a rogue process could symlink-swap the
 * sentinel between the realpath-check and the subsequent read. Without inode
 * pinning, string-based canonical-path matching is insufficient because the
 * underlying file descriptor can point to a different inode.
 *
 * Mitigation steps:
 *   1. First read: capture `{realpath, ino, dev}` after `fs.realpath` + `fs.lstat`.
 *   2. Subsequent reads within the same process: resolve realpath + lstat again;
 *      compare (ino, dev) tuple to pinned values. Mismatch -> treat as attack;
 *      fail SAFE (act as if kill-switch is NOT set).
 *   3. Inode pin expires at process exit; re-pinned on next invocation.
 *   4. Mismatch events are surfaced via the optional `logHistoryEvent` callback so
 *      callers can write to session.json.history[] with `severity: "high"`.
 */

import { existsSync, realpathSync, lstatSync } from 'node:fs';

/**
 * The "kill-switch absent / off" sentinel value returned whenever the sentinel
 * file does not exist OR we decide to fail-safe.
 */
export const KILL_SWITCH_OFF = Object.freeze({ active: false });

/**
 * The "kill-switch active / on" sentinel value returned when the sentinel file
 * exists and passes inode-pin validation.
 */
export const KILL_SWITCH_ON = Object.freeze({ active: true });

/**
 * Per-process pin registry keyed by canonical (post-realpath) absolute path.
 * @type {Map<string, {ino: bigint|number, dev: bigint|number, canonical: string}>}
 */
const INODE_PINS = new Map();

/**
 * Read-only accessor for tests / diagnostics.
 */
export function _getPinsForTesting() {
  return new Map(INODE_PINS);
}

/**
 * Reset the per-process pin registry. Used by unit tests. In production callers
 * should never need to reset — pins expire naturally at process exit.
 */
export function _resetPinsForTesting() {
  INODE_PINS.clear();
}

/**
 * Read the kill-switch sentinel with TOCTOU hardening.
 *
 * @param {string} sentinelPath - Absolute path to the sentinel file (e.g.,
 *   `.claude/coordination/shape-lint-disabled`). Caller resolves the path
 *   against project root before calling.
 * @param {{
 *   logHistoryEvent?: (event: object) => void,
 *   envVarName?: string,
 * }} [opts]
 * @returns {{ active: boolean, reason?: string }}
 *   `active: true` means the kill-switch IS engaged (shape-lint should be
 *   bypassed). `active: false` means proceed with shape-lint (default).
 *
 * OR-gate semantics per AC-3.4: either the file sentinel OR the env var
 * (default `DISABLE_SHAPE_LINT=1`) engages the kill switch.
 */
export function readKillSwitchPinned(sentinelPath, opts = {}) {
  const logHistoryEvent = typeof opts.logHistoryEvent === 'function'
    ? opts.logHistoryEvent
    : null;
  const envVarName = opts.envVarName || 'DISABLE_SHAPE_LINT';

  // --- File sentinel branch (AC-5.5 inode pinning) ---
  const sentinelActive = readSentinelActive(sentinelPath, { logHistoryEvent });

  // --- Env var branch ---
  const envRaw = process.env[envVarName];
  const envActive = envRaw === '1' || envRaw === 'true' || envRaw === 'yes';

  // OR-gate per AC-3.4 / EC-19.
  if (sentinelActive || envActive) {
    return {
      active: true,
      reason: sentinelActive && envActive
        ? 'both-set'
        : sentinelActive
          ? 'file-sentinel'
          : 'env-var',
    };
  }

  return KILL_SWITCH_OFF;
}

/**
 * Inner helper: determine if the sentinel file is active, with inode pinning
 * to mitigate symlink-swap attacks between realpath-check and read.
 *
 * @param {string} sentinelPath
 * @param {{ logHistoryEvent: ((e: object) => void) | null }} ctx
 * @returns {boolean} `true` iff the sentinel exists AND passes inode-pin
 *   validation. `false` on non-existence, lstat failure, or inode mismatch
 *   (fail-safe per AC-5.5 step 2).
 */
function readSentinelActive(sentinelPath, { logHistoryEvent }) {
  if (!existsSync(sentinelPath)) {
    // Absent sentinel means kill-switch OFF. Clear any stale pin.
    if (INODE_PINS.has(sentinelPath)) INODE_PINS.delete(sentinelPath);
    return false;
  }

  // Step 1/2: resolve canonical path + inode metadata via lstat.
  // lstat is used intentionally (does NOT follow the final symlink) so we can
  // distinguish the sentinel itself from a symlink to another file.
  let canonical;
  let stat;
  try {
    canonical = realpathSync(sentinelPath);
    stat = lstatSync(canonical);
  } catch (err) {
    // Broken symlink or race removal; fail-safe.
    if (logHistoryEvent) {
      try {
        logHistoryEvent({
          event: 'kill-switch-lstat-error',
          sentinel_path: sentinelPath,
          error: String(err && err.message ? err.message : err),
          timestamp: new Date().toISOString(),
          severity: 'medium',
        });
      } catch {
        // Logging must never break the hook.
      }
    }
    return false;
  }

  // If the canonical target is itself a symlink (rare — realpath should resolve
  // through it), refuse to trust it.
  if (stat.isSymbolicLink()) {
    if (logHistoryEvent) {
      try {
        logHistoryEvent({
          event: 'kill-switch-symlink-target',
          sentinel_path: sentinelPath,
          canonical,
          timestamp: new Date().toISOString(),
          severity: 'high',
        });
      } catch {
        // Logging never breaks hook.
      }
    }
    return false;
  }

  const pinned = INODE_PINS.get(sentinelPath);
  const observed = { ino: stat.ino, dev: stat.dev, canonical };

  if (!pinned) {
    // First read in this process — pin the inode tuple.
    INODE_PINS.set(sentinelPath, observed);
    return true;
  }

  // Subsequent read — compare inode tuple to the pin.
  const mismatch =
    pinned.ino !== observed.ino ||
    pinned.dev !== observed.dev ||
    pinned.canonical !== observed.canonical;

  if (mismatch) {
    if (logHistoryEvent) {
      try {
        logHistoryEvent({
          event: 'kill-switch-inode-mismatch',
          sentinel_path: sentinelPath,
          pinned_ino: String(pinned.ino),
          observed_ino: String(observed.ino),
          pinned_dev: String(pinned.dev),
          observed_dev: String(observed.dev),
          pinned_canonical: pinned.canonical,
          observed_canonical: observed.canonical,
          timestamp: new Date().toISOString(),
          severity: 'high',
        });
      } catch {
        // Logging never breaks hook.
      }
    }
    // Fail SAFE: treat as kill-switch NOT active (do not disable shape-lint).
    return false;
  }

  // Pin matches observed state — kill-switch is active.
  return true;
}

/**
 * Validate that a candidate `targetPath` (as seen in a destructive Bash command)
 * resolves to the sentinel's canonical path at exec-time. AC-5.6 mitigation.
 *
 * When a pre-exec probe is unavailable (non-interactive shell, no PTY), callers
 * should invoke this helper with the literal path argument at parse-time and
 * combine with symlink rejection: reject any target that `lstat` reports as a
 * symlink (via caller's pre-check), even if it does not currently resolve to
 * the sentinel.
 *
 * @param {string} sentinelPath - Canonical sentinel path.
 * @param {string} candidatePath - Path argument from the Bash command.
 * @returns {boolean} true iff both paths resolve to the same canonical path
 *   AND share the same inode tuple. false means the candidate is NOT the
 *   sentinel (or resolution failed — fail-safe means do not block).
 */
export function isSentinelMatchExecTime(sentinelPath, candidatePath) {
  try {
    if (!existsSync(candidatePath) || !existsSync(sentinelPath)) return false;
    const canonSentinel = realpathSync(sentinelPath);
    const canonCandidate = realpathSync(candidatePath);
    if (canonSentinel !== canonCandidate) return false;
    const sStat = lstatSync(canonSentinel);
    const cStat = lstatSync(canonCandidate);
    return sStat.ino === cStat.ino && sStat.dev === cStat.dev;
  } catch {
    return false;
  }
}

#!/usr/bin/env node

/**
 * PostToolUse shape-lint hook (standalone).
 *
 * Spec: sg-enforcement-layer-gaps Task 11 / REQ-M1-004 / REQ-M1-007 / REQ-M1-008.
 *
 * Responsibilities (per AC-3.1 through AC-3.6 and AC-6.1 through AC-6.9):
 *   - Manifest-path argument (same contract as validate-manifest.mjs). Matcher
 *     is handled by hook-wrapper.mjs + manifest-post-edit-hook.mjs; this hook
 *     does NOT re-implement path globbing.
 *   - Archive-path exclusion (AC-3.2).
 *   - Kill-switch OR-gate (AC-3.4 through AC-3.6): file sentinel at
 *     `.claude/coordination/shape-lint-disabled` OR env var `DISABLE_SHAPE_LINT=1`.
 *   - Latency tracking (AC-6.2): append `{timestamp, wall_ms, outcome, pid}`
 *     entries to `.claude/coordination/shape-lint-latency.jsonl` using
 *     acquireLock/releaseLock from session-lock.mjs. Cap at last 100 entries.
 *   - Auto-downgrade to async-mode (AC-6.4): when p95 wall_ms > 50ms over last
 *     100 samples (warm-up: first 99 are skipped — AC-6.5), write the
 *     `.claude/coordination/shape-lint-async-mode` sentinel.
 *   - Async-mode dispatch (AC-6.7 state matrix): when the sentinel is present,
 *     spawn a detached background `validate-manifest.mjs` process and exit 0
 *     without awaiting the child.
 *   - Lock-contention async defer (AC-6.9): when acquireLock wait exceeds
 *     50ms, release the attempt, spawn detached validator, emit a
 *     `lock-contended-async-defer` event via a best-effort non-locking append.
 *   - Always exit 0 (NFR-2). CLI validator is the authoritative blocker.
 *
 * Kill-switch precedence per AC-6.7:
 *   (kill=ON) → exit 0 immediately (short-circuit); async-mode ignored.
 *   (kill=OFF, async=ON) → fire-and-forget detached validator; no latency log.
 *   (kill=OFF, async=OFF) → sync path with latency measurement + log append.
 */

import { existsSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readKillSwitchPinned } from './lib/kill-switch.mjs';
import { acquireLock, releaseLock } from './lib/session-lock.mjs';
import { getCanonicalProjectDir } from './lib/hook-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Named constants (no magic numbers)
// ---------------------------------------------------------------------------

const EXIT_HOOK_OK = 0;
const OUTPUT_PREFIX = 'manifest-shape-lint-hook:';

/** NFR-1 / AC-6.1 latency budget (ms) for the synchronous path. */
const LATENCY_P95_BUDGET_MS = 50;

/** Warm-up sample count per AC-6.5 (first N samples feed the window but do
 * NOT trigger auto-downgrade). */
const WARMUP_MIN_SAMPLES = 99;

/** Rolling window size per AC-6.2 latency log cap. */
const LATENCY_WINDOW_SIZE = 100;

/** AC-6.9 lock-contention threshold — mirrors NFR-1 budget. */
const LOCK_WAIT_BUDGET_MS = 50;

/** Relative paths (joined against project root). */
const KILL_SWITCH_SENTINEL_RELATIVE = '.claude/coordination/shape-lint-disabled';
const ASYNC_MODE_SENTINEL_RELATIVE = '.claude/coordination/shape-lint-async-mode';
const LATENCY_LOG_RELATIVE = '.claude/coordination/shape-lint-latency.jsonl';
const LATENCY_LOCK_RELATIVE = '.claude/coordination/shape-lint-latency.jsonl.lock';
const ARCHIVE_PATH_SEGMENT = '.claude/specs/archive/';

/** Per-invocation hard timeout for the validator child. Even though we never
 * block the user, we bound child lifetime so a runaway validator cannot pile
 * up background processes. Enforced via spawn timeout in sync path only; the
 * async-detached child is intentionally unbounded because it is fire-and-forget. */
const VALIDATOR_SYNC_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Project root discovery (mirrors manifest-post-edit-hook.mjs to keep consistent)
// ---------------------------------------------------------------------------

function findProjectRoot() {
  // as-012 (REQ-003.6): delegate to canonicalizer; fall back to ancestor walk.
  try {
    return getCanonicalProjectDir();
  } catch {
    /* fall through */
  }
  let dir = __dirname;
  while (dir !== '/') {
    if (existsSync(join(dir, '.claude'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot();
const VALIDATE_MANIFEST_PATH = join(
  PROJECT_ROOT,
  '.claude',
  'scripts',
  'validate-manifest.mjs'
);
const KILL_SWITCH_SENTINEL_PATH = join(PROJECT_ROOT, KILL_SWITCH_SENTINEL_RELATIVE);
const ASYNC_MODE_SENTINEL_PATH = join(PROJECT_ROOT, ASYNC_MODE_SENTINEL_RELATIVE);
const LATENCY_LOG_PATH = join(PROJECT_ROOT, LATENCY_LOG_RELATIVE);
const LATENCY_LOCK_PATH = join(PROJECT_ROOT, LATENCY_LOCK_RELATIVE);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(line) {
  process.stdout.write(`${OUTPUT_PREFIX} ${line}\n`);
}

function isArchivePath(filePath) {
  return filePath.includes(ARCHIVE_PATH_SEGMENT);
}

/**
 * Read the active workflow name from the session state file without relying
 * on session-checkpoint.mjs (which would pull in the entire CLI). Returns
 * null on any error or missing state.
 *
 * sg-enforcement-layer-gaps Task 28 / REQ-SH-001 / AC-13.1 — the `workflow`
 * field is attached to every latency sample so post-hoc analysis can correlate
 * validator performance with the active workflow type.
 */
function readActiveWorkflow() {
  try {
    const sessionPath = join(PROJECT_ROOT, '.claude', 'context', 'session.json');
    if (!existsSync(sessionPath)) return null;
    const raw = readFileSync(sessionPath, 'utf-8');
    const session = JSON.parse(raw);
    return session?.active_work?.workflow || null;
  } catch {
    return null;
  }
}

function nowMs() {
  // cr-style-d8e9f0: Use Date.now() directly. The hook runs on Node >= 20
  // where `performance.now()` is universally available, but the extra
  // precision isn't material for the 50ms latency budget (AC-6.1) — ms-level
  // resolution is sufficient for p95 over a 100-sample window. Sticking with
  // Date.now() drops the defensive fallback branch and keeps latency math
  // in wall-clock ms that round trivially to `Math.round` for logging.
  return Date.now();
}

/**
 * Append one JSONL record to the latency log under a lock.
 *
 * AC-6.3: concurrent-write safety uses acquireLock/releaseLock (no new npm
 * dependency — session-lock.mjs is the idiomatic helper).
 *
 * Returns `{ logged: boolean, lock_wait_ms: number }` so the caller can decide
 * whether a lock-contention defer (AC-6.9) was triggered.
 *
 * Window-cap enforcement (AC-6.2): on each successful append, read the file,
 * keep the last LATENCY_WINDOW_SIZE lines, and re-write. The rewrite is
 * best-effort — if it fails the rolling trim just doesn't happen; the hook
 * never blocks on logging.
 */
function appendLatencySample(entry) {
  const lockStart = nowMs();
  const got = acquireLock(LATENCY_LOCK_PATH, { failOpen: true });
  const lockWaitMs = nowMs() - lockStart;

  if (!got) {
    return { logged: false, lock_wait_ms: lockWaitMs };
  }

  // chk-latency-e9f20304: split append (must be atomic under lock) from trim
  // (best-effort, runs AFTER lock is released). On append failure (e.g. ENOSPC)
  // we release the lock early, log a warning, and SKIP trim — preserving the
  // "best-effort" contract but making the failure path explicit and bounded.
  let appendOk = false;
  try {
    try {
      appendFileSync(LATENCY_LOG_PATH, JSON.stringify(entry) + '\n');
      appendOk = true;
    } catch (err) {
      process.stderr.write(
        `[shape-lint-hook] latency append failed: ${err.message}\n`
      );
      // Return early WITHOUT calling trim. Fall through to finally for release.
      return { logged: false, lock_wait_ms: lockWaitMs };
    }
  } finally {
    releaseLock(LATENCY_LOCK_PATH);
  }

  // Lock released; trim is best-effort (wraps its own try/catch). If trim
  // itself encounters a partial write, the next successful append + trim will
  // converge the log back to window size.
  if (appendOk) trimLatencyLogBestEffort();
  return { logged: true, lock_wait_ms: lockWaitMs };
}

/** Best-effort trim of the latency log to the last LATENCY_WINDOW_SIZE lines. */
function trimLatencyLogBestEffort() {
  try {
    if (!existsSync(LATENCY_LOG_PATH)) return;
    const raw = readFileSync(LATENCY_LOG_PATH, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    if (lines.length <= LATENCY_WINDOW_SIZE) return;
    const kept = lines.slice(-LATENCY_WINDOW_SIZE).join('\n') + '\n';
    writeFileSync(LATENCY_LOG_PATH, kept);
  } catch {
    // Best effort — never block the hook on bookkeeping failures.
  }
}

/**
 * Compute p95 over the latency log samples and, if the budget is exceeded
 * AND we are past warm-up, write the async-mode sentinel (AC-6.4).
 *
 * Includes BOTH `sync-validation` and `lock-contended-async-defer` entries
 * (chk-edge-case-b4a91c02). Rationale: contention-caused slowness is itself a
 * form of sync-path slowness — excluding defer events would hide latency from
 * the downgrade trigger exactly when contention is the dominant cost.
 *   - `sync-validation` contributes its measured `wall_ms` (validator cost).
 *   - `lock-contended-async-defer` contributes a latency-equivalent value:
 *     the recorded `wait_ms` (lock-contention cost) clamped to at least the
 *     NFR-1 budget (LATENCY_P95_BUDGET_MS), since any defer was triggered by
 *     a wait already exceeding the budget per AC-6.9. This treats contention
 *     as a budget-exceeding signal for downgrade purposes without claiming
 *     more specificity than the defer event carries.
 */
function maybeAutoDowngradeToAsyncMode() {
  try {
    if (!existsSync(LATENCY_LOG_PATH)) return;
    const raw = readFileSync(LATENCY_LOG_PATH, 'utf-8');
    const lines = raw
      .split('\n')
      .filter((l) => l.length > 0);
    const syncSamples = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (!obj || typeof obj !== 'object') continue;
        if (obj.event === 'sync-validation' && typeof obj.wall_ms === 'number') {
          syncSamples.push(obj.wall_ms);
        } else if (
          obj.event === 'lock-contended-async-defer' &&
          typeof obj.wait_ms === 'number'
        ) {
          // AC-6.9 fired BECAUSE wait exceeded the budget; contribute the
          // measured wait clamped to at least the budget (conservative lower
          // bound) so defers always count as budget-exceeding for p95 purposes.
          syncSamples.push(Math.max(obj.wait_ms, LATENCY_P95_BUDGET_MS));
        }
      } catch {
        // Skip malformed line — best effort.
      }
    }

    if (syncSamples.length < WARMUP_MIN_SAMPLES + 1) {
      return; // Warm-up phase — AC-6.5.
    }

    // Only compute on the most recent LATENCY_WINDOW_SIZE samples.
    const window = syncSamples.slice(-LATENCY_WINDOW_SIZE);
    const sorted = [...window].sort((a, b) => a - b);
    // AC-6.4 p95 index (nearest-rank / R-3 method). For N=100 the 95th
    // element (1-indexed) is sorted[94] (0-indexed) = ceil(0.95*100) - 1.
    // Clamp to [0, N-1] for defensive handling of small windows.
    const p95Idx = Math.ceil(sorted.length * 0.95) - 1;
    const p95 = sorted[Math.max(0, Math.min(sorted.length - 1, p95Idx))];
    if (p95 > LATENCY_P95_BUDGET_MS && !existsSync(ASYNC_MODE_SENTINEL_PATH)) {
      writeFileSync(
        ASYNC_MODE_SENTINEL_PATH,
        JSON.stringify(
          {
            reason: 'auto-downgrade-p95-exceeded',
            p95_ms: p95,
            budget_ms: LATENCY_P95_BUDGET_MS,
            window_size: window.length,
            created_at: new Date().toISOString(),
          },
          null,
          2
        ) + '\n'
      );
      // cr-logging-f4e7d8: Emit structured JSON line alongside prose so
      // log aggregators can grep by event_type without parsing free text.
      // Format follows memory-bank/best-practices/logging.md (stable event field).
      process.stderr.write(
        JSON.stringify({
          event: 'auto-downgrade-p95-exceeded',
          p95_ms: p95,
          budget_ms: LATENCY_P95_BUDGET_MS,
        }) + '\n'
      );
      process.stderr.write(
        `[shape-lint-hook] auto-downgraded to async-mode: p95=${p95}ms > budget=${LATENCY_P95_BUDGET_MS}ms\n`
      );
    }
  } catch {
    // Never block on downgrade bookkeeping.
  }
}

/**
 * Non-locking, best-effort append for the AC-6.9 defer event only.
 * The spec explicitly tolerates occasional interleaving for this event-type
 * so we do not try to acquire a lock that we just released.
 */
function appendLockContendedDefer(waitMs, pid) {
  try {
    appendFileSync(
      LATENCY_LOG_PATH,
      JSON.stringify({
        event: 'lock-contended-async-defer',
        wait_ms: waitMs,
        pid,
        // Task 28 / AC-13.1: include workflow for correlation.
        workflow: readActiveWorkflow(),
        timestamp: new Date().toISOString(),
      }) + '\n'
    );
  } catch {
    // Best effort.
  }
}

/** Spawn a detached `validate-manifest.mjs` child, unref, return its pid. */
function spawnDetachedValidator(manifestPath) {
  try {
    const child = spawn('node', [VALIDATE_MANIFEST_PATH, manifestPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return child.pid;
  } catch (err) {
    process.stderr.write(
      `[shape-lint-hook] detached spawn failed: ${err.message}\n`
    );
    return null;
  }
}

/**
 * Run the validator synchronously; return {code, wall_ms, stderr}. Bounded by
 * VALIDATOR_SYNC_TIMEOUT_MS.
 */
function runValidatorSync(manifestPath) {
  const start = nowMs();
  const r = spawnSync('node', [VALIDATE_MANIFEST_PATH, manifestPath], {
    encoding: 'utf-8',
    timeout: VALIDATOR_SYNC_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const wallMs = nowMs() - start;
  return {
    code: typeof r.status === 'number' ? r.status : 2,
    wall_ms: wallMs,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    emit('SKIP no-file-arg');
    process.exit(EXIT_HOOK_OK);
  }
  const manifestPath = resolve(args[0]);

  // AC-3.2 archive exclusion.
  if (isArchivePath(manifestPath)) {
    emit('SKIP archive-path');
    process.exit(EXIT_HOOK_OK);
  }

  // AC-3.4/3.5/3.6: kill-switch OR-gate, re-read fresh, no caching.
  const kill = readKillSwitchPinned(KILL_SWITCH_SENTINEL_PATH);
  if (kill.active) {
    emit(`SKIP kill-switch reason=${kill.reason}`);
    process.exit(EXIT_HOOK_OK);
  }

  // AC-6.7 state matrix: async-mode sentinel check.
  const asyncModeActive = existsSync(ASYNC_MODE_SENTINEL_PATH);
  if (asyncModeActive) {
    const pid = spawnDetachedValidator(manifestPath);
    emit(`ASYNC_DISPATCH pid=${pid ?? 'unknown'}`);
    process.exit(EXIT_HOOK_OK);
  }

  // If the validator script is missing, fail-open with a warning so we never
  // block legitimate edits on a broken install.
  if (!existsSync(VALIDATE_MANIFEST_PATH)) {
    emit('SKIP validator-missing');
    process.exit(EXIT_HOOK_OK);
  }

  // Synchronous path (AC-6.7 state matrix (kill=OFF, async=OFF)).
  const run = runValidatorSync(manifestPath);

  // Always surface validator stderr so operators see actionable warnings.
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.error) {
    process.stderr.write(`[shape-lint-hook] child error: ${run.error}\n`);
  }

  // Log latency sample, then check for AC-6.9 lock-contention defer.
  // sg-enforcement-layer-gaps Task 28 / REQ-SH-001 / AC-13.1: include
  // `workflow` field for post-hoc correlation analysis.
  const appendResult = appendLatencySample({
    event: 'sync-validation',
    wall_ms: Math.round(run.wall_ms),
    exit_code: run.code,
    outcome: run.code === 0 ? 'pass' : 'fail',
    workflow: readActiveWorkflow(),
    timestamp: new Date().toISOString(),
    pid: process.pid,
  });

  if (!appendResult.logged && appendResult.lock_wait_ms > LOCK_WAIT_BUDGET_MS) {
    // AC-6.9: lock-contention async defer.
    const pid = spawnDetachedValidator(manifestPath);
    appendLockContendedDefer(appendResult.lock_wait_ms, pid);
    emit(
      `ASYNC_DEFER lock_wait_ms=${Math.round(appendResult.lock_wait_ms)} pid=${pid ?? 'unknown'}`
    );
    process.exit(EXIT_HOOK_OK);
  }

  // Check for auto-downgrade after a successful sample — only once we have
  // fresh data that could change the p95.
  maybeAutoDowngradeToAsyncMode();

  emit(
    run.code === 0
      ? `PASS wall_ms=${Math.round(run.wall_ms)}`
      : `FAIL exit=${run.code} wall_ms=${Math.round(run.wall_ms)}`
  );
  process.exit(EXIT_HOOK_OK);
}

// Only execute when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

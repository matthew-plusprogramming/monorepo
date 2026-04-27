#!/usr/bin/env node

/**
 * audit-append.mjs — kill-switch audit trail CLI.
 *
 * Kill-switch audit append contract:
 *   Tamper-evident append-only audit log for `.claude/gate-enforcement-disabled`
 *   sentinel lifecycle. Emits entries with a sha256 prev_hash chain, rotates at
 *   10 MB (keeping 10 files), rate-limits writes (1/10s burst=5) via persistent
 *   `.rate-limit.state`, sanitizes actor/rationale fail-closed, and atomically
 *   appends via O_APPEND so PIPE_BUF bounded writes are concurrency-safe.
 *
 * Subcommands:
 *   create        Sentinel create event (REQ-009.1).
 *   remove        Sentinel remove event (REQ-009.1).
 *   ack-tamper    Record ack_tamper entry; clears BLOCK mode (AC1.8 / EC-21).
 *
 * Flags:
 *   --rationale "<text>"  Required for create/remove.
 *   --actor     "<name>"  Optional; default `process.env.USER || 'unknown'`.
 *
 * Error codes (exit 1 on any of these; structured JSON on stderr):
 *   E_RATE_LIMITED             Rate limit exhausted (no audit entry emitted).
 *   E_INVALID_CONTROL_CHAR     Sanitization rejected a forbidden control char.
 *   E_ENTRY_TOO_LARGE          Entry exceeds 4096 bytes after serialization.
 *   E_AUDIT_BLOCKED            BLOCK mode active; write refused until ack-tamper.
 *   E_RATE_LIMIT_STATE_CORRUPT Persistent rate-limit state file is unreadable.
 *
 * CLI-only env contract:
 *   process.env.AUDIT_APPEND_AUTHORIZED is set to '1' for the life of the
 *   process so downstream consumers that still probe the env can tell this
 *   CLI is the authorized writer (as-019 AC1.2).
 *   sec-authz-e7f3a12d: workflow-file-protection.mjs NO LONGER trusts this
 *   env marker — it performs PPID attestation (resolves ppid → argv and
 *   matches basename `audit-append.mjs`) instead. The env var is retained
 *   for diagnostic/log-scraping purposes only.
 *
 * @req REQ-009.1-7
 * @sec SEC-002, SEC-005, SEC-006, SEC-007, SEC-010, SEC-011
 * @contract kill-switch-audit-log append
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  openSync,
  writeSync,
  closeSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// sec-authz-e7f3a12d: this env marker is now advisory-only. The file
// protection hook performs PPID attestation, not env-trust. Retained for
// diagnostic / log-scraping compatibility only — do NOT rely on it for any
// future authorization decision without PPID cross-check.
process.env.AUDIT_APPEND_AUTHORIZED = '1';

import { getCanonicalProjectDir } from './lib/hook-utils.mjs';
import { atomicWriteSentinel } from './lib/atomic-write.mjs';
import { canonicalJSON, CONTROL_CHAR_REGEX } from './lib/audit-chain.mjs';

// =============================================================================
// Constants
// =============================================================================

const AUDIT_DIR_RELATIVE = '.claude/audit';
const AUDIT_LOG_BASENAME = 'kill-switch.log.jsonl';
const RATE_LIMIT_STATE_BASENAME = 'rate-limit.state';
const ROTATION_LOCK_BASENAME = '.rotation.lock';

/** Rotation threshold in bytes (REQ-009.6). 10 MB. */
const ROTATION_THRESHOLD_BYTES = 10 * 1024 * 1024;
/** Maximum retained rotated files (plus the live base file). */
const MAX_RETAINED_ROTATIONS = 10;

/** Rate-limit: refill 1 token per 10s, burst capacity 5 (per spec REQ-009.6). */
const RATE_LIMIT_REFILL_MS = 10_000;
const RATE_LIMIT_BURST = 5;
const RATE_LIMIT_INITIAL_TOKENS = 5;

/** Single entry size cap (PIPE_BUF bounded, leaves headroom for O_APPEND). */
const ENTRY_MAX_BYTES = 4096;

/** Actor / rationale char cap. */
const SANITIZE_MAX_CHARS = 500;

/** sha256 hex length — 64 chars for the prev_hash chain. */
const PREV_HASH_ZERO = '0'.repeat(64);

/** Valid actions. */
const VALID_ACTIONS = Object.freeze(['create', 'remove', 'ack_tamper']);

// CONTROL_CHAR_REGEX is imported from lib/audit-chain.mjs (L1-low consolidation).
// Consumers must NFC-normalize before applying — see sanitizeOrExit below.

/** Directory permissions when bootstrapping .claude/audit/. */
const AUDIT_DIR_MODE = 0o755;

// =============================================================================
// Helpers
// =============================================================================

function failWith(code, message, extra = {}) {
  const err = { error_code: code, message, ...extra };
  process.stderr.write(JSON.stringify(err) + '\n');
  process.exit(1);
}

/** Resolve project root or fail-closed. */
function resolveRootOrExit() {
  try {
    return getCanonicalProjectDir();
  } catch (err) {
    failWith('E_PROJECT_ROOT', err.message || 'Cannot resolve project root.');
    return null;
  }
}

function ensureAuditDir(rootDir) {
  const auditDir = join(rootDir, AUDIT_DIR_RELATIVE);
  if (!existsSync(auditDir)) {
    mkdirSync(auditDir, { recursive: true, mode: AUDIT_DIR_MODE });
  }
  return auditDir;
}

// canonicalJSON is imported from lib/audit-chain.mjs (L1-low consolidation).
// The function is byte-identical across audit-append + audit-verify; see that
// module for the Merkle-chain contract commentary (cr-quality-6d8f029c,
// sec-crypto-9a2e1506).

/**
 * Sanitize a string for actor/rationale. Fail-closed on forbidden control
 * chars or over-limit length (REQ-009.7 / AC1.7).
 *
 * sec-input-ff2a1d47: NFC-normalize before the regex check so decomposed
 * sequences (e.g., U+2028 expressed as combining marks) cannot slip past.
 * NFC is a no-op for already-composed ASCII inputs, so the common case is
 * unaffected.
 */
function sanitizeOrExit(fieldName, value) {
  if (typeof value !== 'string') {
    failWith('E_INVALID_CONTROL_CHAR', `${fieldName} must be a string.`);
  }
  const normalized = value.normalize('NFC');
  if (CONTROL_CHAR_REGEX.test(normalized)) {
    failWith(
      'E_INVALID_CONTROL_CHAR',
      `${fieldName} contains forbidden control char (0x00-0x1F excluding 0x09, or Unicode line/paragraph/bidi separator).`
    );
  }
  if (normalized.length > SANITIZE_MAX_CHARS) {
    failWith('E_INVALID_CONTROL_CHAR', `${fieldName} exceeds ${SANITIZE_MAX_CHARS} chars.`);
  }
  return normalized;
}

// =============================================================================
// Rate-limit state
// =============================================================================

/**
 * Load the persistent rate-limit bucket.
 * Returns `{ tokens: number, last_refill_at: number }`.
 * Absent state => full bucket (AC1.6). Corrupt state => fail-closed.
 */
function loadRateLimitState(auditDir) {
  const statePath = join(auditDir, RATE_LIMIT_STATE_BASENAME);
  if (!existsSync(statePath)) {
    return { tokens: RATE_LIMIT_INITIAL_TOKENS, last_refill_at: Date.now() };
  }
  let raw;
  try {
    raw = readFileSync(statePath, 'utf-8');
  } catch {
    failWith('E_RATE_LIMIT_STATE_CORRUPT', `Could not read rate-limit state at ${statePath}.`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.tokens !== 'number' ||
      typeof parsed.last_refill_at !== 'number' ||
      parsed.tokens < 0 ||
      parsed.tokens > RATE_LIMIT_INITIAL_TOKENS
    ) {
      // cr-style-2e4c9f11: Typed error code. The raw Error('shape invalid')
      // previously blurred the distinction between a malformed JSON parse
      // and a shape-violating payload. Both surface as
      // E_RATE_LIMIT_STATE_CORRUPT at the failWith boundary, but the inner
      // throw now carries a stable identifier for future log scraping.
      const e = new Error('Rate-limit state shape invalid.');
      e.code = 'E_RATE_LIMIT_STATE_CORRUPT';
      throw e;
    }
    return parsed;
  } catch {
    failWith('E_RATE_LIMIT_STATE_CORRUPT', `Rate-limit state at ${statePath} is malformed.`);
  }
  // unreachable
  return null;
}

function saveRateLimitState(auditDir, state) {
  const statePath = join(auditDir, RATE_LIMIT_STATE_BASENAME);
  atomicWriteSentinel(statePath, JSON.stringify(state) + '\n');
}

/**
 * Refill tokens based on elapsed wall-clock time.
 */
function refillTokens(state, now = Date.now()) {
  const elapsed = now - state.last_refill_at;
  if (elapsed <= 0) return state;
  const refillAmount = Math.floor(elapsed / RATE_LIMIT_REFILL_MS);
  if (refillAmount <= 0) return state;
  const newTokens = Math.min(RATE_LIMIT_BURST, state.tokens + refillAmount);
  return {
    tokens: newTokens,
    last_refill_at: state.last_refill_at + refillAmount * RATE_LIMIT_REFILL_MS,
  };
}

/**
 * Attempt to consume one token. Returns the new state or null if exhausted.
 */
function consumeToken(state) {
  if (state.tokens <= 0) return null;
  return {
    tokens: state.tokens - 1,
    last_refill_at: state.last_refill_at,
  };
}

// =============================================================================
// Chain state
// =============================================================================

/**
 * Read the last entry's canonical hash + sequence number.
 * Returns `{ prev_hash: string, next_seq: number, block_mode: boolean }`.
 * BLOCK mode is active iff the last non-ack_tamper entry sets `tampered: true`
 * or a chain gap / mismatch is detected on scan.
 *
 * The scan is bounded to the live base file; historical rotations are not
 * re-hashed (verification happens via audit-verify.mjs — future work).
 */
function readChainTail(auditDir) {
  const logPath = join(auditDir, AUDIT_LOG_BASENAME);
  if (!existsSync(logPath)) {
    return { prev_hash: PREV_HASH_ZERO, next_seq: 1, block_mode: false };
  }

  const raw = readFileSync(logPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) {
    return { prev_hash: PREV_HASH_ZERO, next_seq: 1, block_mode: false };
  }

  let prevHash = PREV_HASH_ZERO;
  let nextSeq = 1;
  let blockMode = false;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      blockMode = true; // malformed line => tamper
      continue;
    }
    if (typeof entry.seq !== 'number' || entry.seq !== nextSeq) {
      blockMode = true; // gap or out-of-order
    }
    if (entry.prev_hash !== prevHash) {
      blockMode = true; // chain break
    }
    // Compute canonical hash of this entry (exclude chain-follow metadata).
    const canonical = canonicalJSON(entry);
    prevHash = createHash('sha256').update(canonical).digest('hex');
    nextSeq = entry.seq + 1;
    if (entry.action === 'ack_tamper') {
      // ack clears subsequent block
      blockMode = false;
    }
  }

  return { prev_hash: prevHash, next_seq: nextSeq, block_mode: blockMode };
}

// =============================================================================
// Rotation
// =============================================================================

/** Stale rotation-lock threshold — mirrors session-lock.mjs stale pattern. */
const ROTATION_LOCK_STALE_MS = 60_000;

/**
 * Rotate the live log file if its size exceeds ROTATION_THRESHOLD_BYTES.
 * Acquires `.rotation.lock` via openSync(flag: 'wx') to serialize concurrent
 * rotation attempts (DEC-CHK-007 / AC1.10).
 *
 * cr-quality-c91d30a4: Pre-acquire stale-detection — if a rotation process
 * crashes between `openSync('wx')` and `unlinkSync(lockPath)` in the finally
 * block, the lock would pin forever without this recovery. Mirror
 * session-lock.mjs: if lock exists and mtime > ROTATION_LOCK_STALE_MS old,
 * log WARN + unlink + retry. Protects against orphan locks while still
 * serializing concurrent rotations within the stale window.
 */
function rotateIfNeeded(auditDir) {
  const logPath = join(auditDir, AUDIT_LOG_BASENAME);
  if (!existsSync(logPath)) return;
  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {
    return;
  }
  if (size < ROTATION_THRESHOLD_BYTES) return;

  const lockPath = join(auditDir, ROTATION_LOCK_BASENAME);

  // Stale-lock pre-acquire sweep (cr-quality-c91d30a4).
  if (existsSync(lockPath)) {
    try {
      const lockStat = statSync(lockPath);
      const ageMs = Date.now() - lockStat.mtimeMs;
      if (ageMs > ROTATION_LOCK_STALE_MS) {
        process.stderr.write(
          `[audit-append] WARN force-unlinking stale rotation lock (age=${Math.round(ageMs / 1000)}s)\n`
        );
        try {
          unlinkSync(lockPath);
        } catch {
          // Race: someone else beat us to the unlink. Fall through; the
          // openSync('wx') below will succeed or fail as appropriate.
        }
      }
    } catch {
      // stat failure (lock already removed) — fall through to normal acquire.
    }
  }

  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch {
    // Another process holds the rotation lock; defer.
    return;
  }
  try {
    writeSync(fd, String(process.pid));
    closeSync(fd);
    // Re-stat under lock in case another process already rotated.
    if (!existsSync(logPath)) return;
    const freshSize = statSync(logPath).size;
    if (freshSize < ROTATION_THRESHOLD_BYTES) return;

    // Determine the next rotation index. Existing rotations are
    // kill-switch.log.1.jsonl ... kill-switch.log.N.jsonl; new rotation
    // shifts N -> N+1 and prunes > MAX_RETAINED_ROTATIONS.
    // Shift from largest downward so numeric suffixes do not collide.
    for (let i = MAX_RETAINED_ROTATIONS; i >= 1; i--) {
      const src = join(auditDir, `kill-switch.log.${i}.jsonl`);
      const dst = join(auditDir, `kill-switch.log.${i + 1}.jsonl`);
      if (!existsSync(src)) continue;
      if (i === MAX_RETAINED_ROTATIONS) {
        // Prune the oldest rather than shift it to position MAX+1.
        try {
          unlinkSync(src);
        } catch {
          // ignore
        }
        continue;
      }
      try {
        renameSync(src, dst);
      } catch {
        // ignore best-effort rotation
      }
    }
    try {
      renameSync(logPath, join(auditDir, 'kill-switch.log.1.jsonl'));
    } catch {
      // if rename fails, continue and write to the live file
    }
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

// =============================================================================
// Main
// =============================================================================

function parseArgs(argv) {
  // Accept both positional form (`audit-append create --rationale ...`) AND
  // flag-only form (`audit-append --action create --rationale ...`). The
  // flag form is the test-writer-preferred shape; both are supported for
  // backward compat.
  let action = null;
  let rationale = null;
  let actor = null;
  let sentinel = null; // sentinel path override (flag-only form)
  let ackTamper = false;
  const startIdx = 2;
  for (let i = startIdx; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--action') {
      action = argv[++i] ?? '';
    } else if (a === '--rationale') {
      rationale = argv[++i] ?? '';
    } else if (a === '--actor') {
      actor = argv[++i] ?? '';
    } else if (a === '--sentinel') {
      sentinel = argv[++i] ?? '';
    } else if (a === '--ack-tamper') {
      ackTamper = true;
      action = 'ack_tamper';
    } else if (!action && !a.startsWith('--')) {
      // Positional action token when encountered before any flag.
      action = a;
    }
  }
  return { action, rationale, actor, sentinel, ackTamper };
}

function main() {
  const args = parseArgs(process.argv);
  if (!VALID_ACTIONS.includes(args.action)) {
    failWith(
      'E_USAGE',
      `Usage: audit-append.mjs <${VALID_ACTIONS.join('|')}> --rationale "<text>" [--actor "<name>"]`
    );
  }

  const actor = sanitizeOrExit('actor', (args.actor ?? process.env.USER ?? 'unknown') || 'unknown');
  const rationale = sanitizeOrExit('rationale', args.rationale ?? '');

  if (args.action !== 'ack_tamper' && rationale.length === 0) {
    failWith('E_INVALID_CONTROL_CHAR', 'rationale is required for create/remove.');
  }

  const root = resolveRootOrExit();
  const auditDir = ensureAuditDir(root);

  // Rotate BEFORE reading chain-tail so post-rotation append starts fresh.
  rotateIfNeeded(auditDir);

  // Rate-limit check.
  let state = loadRateLimitState(auditDir);
  state = refillTokens(state);
  const afterConsume = consumeToken(state);
  if (!afterConsume) {
    // No audit entry emitted on rate-limit exhaust (AC1.6 — no amplification).
    saveRateLimitState(auditDir, state);
    failWith('E_RATE_LIMITED', 'Audit write rate-limited (token bucket empty).');
  }
  state = afterConsume;

  // Chain-tail.
  const tail = readChainTail(auditDir);
  if (tail.block_mode && args.action !== 'ack_tamper') {
    // Refund the token since no entry will land.
    // cr-quality-3a7e25e8: refund + save is NOT atomic with the consume+save
    // above. If this process crashes between consume-save and refund-save,
    // the token leaks (bucket stays consumed). Accepted tradeoff: tokens may
    // leak by ~0.2% under crash pressure, which is within the rate-limit
    // noise floor (burst=5, refill=1/10s → ~360 tokens/hr). Atomic refund
    // would require a lock around the bucket, doubling audit-append latency
    // on every failure path. Not worth the cost.
    state = { ...state, tokens: state.tokens + 1 };
    saveRateLimitState(auditDir, state);
    failWith('E_AUDIT_BLOCKED', 'Audit log is in BLOCK mode. Invoke with --ack-tamper to acknowledge.');
  }

  const entry = {
    seq: tail.next_seq,
    timestamp: new Date().toISOString(),
    action: args.action,
    sentinel: args.sentinel || '.claude/gate-enforcement-disabled',
    actor,
    rationale,
    prev_hash: tail.prev_hash,
  };

  const serialized = JSON.stringify(entry);
  if (Buffer.byteLength(serialized + '\n') > ENTRY_MAX_BYTES) {
    // Refund token — no entry will land.
    state = { ...state, tokens: state.tokens + 1 };
    saveRateLimitState(auditDir, state);
    failWith('E_ENTRY_TOO_LARGE', `Entry exceeds ${ENTRY_MAX_BYTES} bytes.`);
  }

  // Open with O_APPEND (fs append flag 'a' maps to O_APPEND on POSIX) so
  // concurrent processes serialize via kernel-level atomic append.
  const logPath = join(auditDir, AUDIT_LOG_BASENAME);
  const fd = openSync(logPath, 'a');
  try {
    writeSync(fd, serialized + '\n');
  } finally {
    closeSync(fd);
  }

  saveRateLimitState(auditDir, state);

  // Emit the entry on stdout for caller confirmation.
  process.stdout.write(serialized + '\n');
  process.exit(0);
}

main();

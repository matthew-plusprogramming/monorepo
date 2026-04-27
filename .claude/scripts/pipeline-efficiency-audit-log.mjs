/**
 * pipeline-efficiency-audit-log.mjs — hash-chained audit-log appender for
 * pipeline-efficiency enforcement events (9 canonical event classes, NFR-5).
 *
 * Writes line-delimited JSON entries to `.claude/audit/pipeline-efficiency-changes.log`
 * with a SHA-256 prev_hash chain seeded by the signed genesis anchor at
 * `.claude/audit/pipeline-efficiency-genesis.json` (seq=0, hash=<genesis hex>).
 *
 * Contract:
   *   - Entry shape validated via `auditEntrySchema` (as-003, lib/schemas/audit-entry.schema.mjs).
 *   - event_class ∈ 9 canonical named strings. Legacy letter codes rejected.
 *   - prev_hash[seq=1] = genesis.hash. prev_hash[seq=N≥2] = SHA-256(canonicalJSON(entry[N-1])).
 *   - seq monotonically increments from 1.
 *   - Append is atomic via O_APPEND + fsync (PIPE_BUF-bounded single-line write).
 *
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning
 *   - Parent task: Phase E — Task E4
 *   - Atomic spec: as-017-audit-log-appender
 *   - Requirements: REQ-013 (audit append on mode flip); NFR-5 (9 event classes)
 *   - Contract: §NFR-HASH-CHAIN-VERIFY, §Audit log entry schema (spec.md:641-665)
 *
 * Write-protection:
 *   The audit log file itself is NOT in the FULL_BLOCK basename list — only
 *   the genesis anchor and sentinel are. Appends from normal agent context
 *   are permitted by design (REQ-013 requires agents + operators to append
 *   mode-flip / session-override / unlock events). The PreToolUse hook
 *   handles the FULL_BLOCK carve-out for genesis writes separately; this
 *   appender performs pure fs writes and does not need special authorization.
 *
 * Canonical JSON:
 *   Chain linking hashes the sorted-key canonical JSON of each prior entry.
 *   Reuses `canonicalJSON` from lib/audit-chain.mjs (already used by
 *   audit-append.mjs / audit-verify.mjs for the kill-switch chain) to avoid
 *   drift across the project's two audit chains.
 *
 * Concurrency:
 *   Single-writer expected (enforcement flow is serialized through
 *   session-checkpoint.mjs and flip-preflight). O_APPEND still provides
 *   kernel-level atomicity for sub-PIPE_BUF single-line writes in case of
 *   accidental concurrent invocation.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

import { canonicalJSON } from './lib/audit-chain.mjs';
import { getCanonicalProjectDir } from './lib/hook-utils.mjs';
import {
  auditEntrySchema,
  EVENT_CLASSES,
} from './lib/schemas/audit-entry.schema.mjs';

// =============================================================================
// Constants
// =============================================================================

/** Relative path to the audit-log file from the project root. */
export const AUDIT_LOG_RELATIVE_PATH =
  '.claude/audit/pipeline-efficiency-changes.log';

/** Relative path to the signed genesis anchor (seq=0). */
export const GENESIS_ANCHOR_RELATIVE_PATH =
  '.claude/audit/pipeline-efficiency-genesis.json';

/** Directory permissions when bootstrapping `.claude/audit/`. */
const AUDIT_DIR_MODE = 0o755;

/** SHA-256 hex length — 64 lowercase hex chars. */
const SHA256_HEX_LENGTH = 64;

/** Regex for SHA-256 hex digest validation (defensive; schema also enforces). */
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

// =============================================================================
// Errors
// =============================================================================

/**
 * Structured error thrown by appendAuditEntry. Callers can branch on `.code`.
 *
 * Error codes:
 *   E_GENESIS_ANCHOR_MISSING   — genesis file does not exist
 *   E_GENESIS_ANCHOR_INVALID   — genesis file is malformed or shape-invalid
 *   E_GENESIS_HASH_INVALID     — genesis.hash is not 64-char lowercase hex
 *   E_LOG_LINE_MALFORMED       — prior log line failed to parse as JSON
 *   E_LOG_LINE_SHAPE_INVALID   — prior log line parsed but shape-invalid
 *   E_INVALID_EVENT_CLASS      — event_class not in the 9 canonical names
 *   E_SCHEMA_VALIDATION        — entry failed auditEntrySchema
 *   E_WRITE_FAILED             — fs append/fsync failed
 */
export class AuditLogError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AuditLogError';
    this.code = code;
    this.details = details;
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Resolve the project root through the shared hook utility. Falls back to
 * `process.cwd()` when the hook env is absent so the CLI remains usable
 * directly.
 *
 * Tests that want to exercise the appender in a controlled temp dir should
 * pass `{ projectRoot }` to `appendAuditEntry` explicitly rather than relying
 * on env manipulation.
 */
function defaultProjectRoot() {
  try {
    return getCanonicalProjectDir();
  } catch {
    return process.cwd();
  }
}

/**
 * Read and validate the genesis anchor. Returns the genesis.hash value
 * (SHA-256 hex string) used as prev_hash for seq=1.
 *
 * @param {string} genesisPath
 * @returns {string} genesis hash (64-char lowercase hex)
 * @throws {AuditLogError} E_GENESIS_ANCHOR_MISSING / _INVALID / _HASH_INVALID
 */
function readGenesisHash(genesisPath) {
  if (!existsSync(genesisPath)) {
    throw new AuditLogError(
      'E_GENESIS_ANCHOR_MISSING',
      `Genesis anchor not found at ${genesisPath}. Phase E Task E3 bootstrap required.`,
      { path: genesisPath }
    );
  }
  let raw;
  try {
    raw = readFileSync(genesisPath, 'utf-8');
  } catch (err) {
    throw new AuditLogError(
      'E_GENESIS_ANCHOR_INVALID',
      `Cannot read genesis anchor at ${genesisPath}: ${err.message}`,
      { path: genesisPath, cause: err.message }
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AuditLogError(
      'E_GENESIS_ANCHOR_INVALID',
      `Genesis anchor at ${genesisPath} is not valid JSON: ${err.message}`,
      { path: genesisPath, cause: err.message }
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.seq !== 0 ||
    typeof parsed.hash !== 'string'
  ) {
    throw new AuditLogError(
      'E_GENESIS_ANCHOR_INVALID',
      `Genesis anchor shape invalid (expected {seq:0, hash:string, ...}).`,
      { path: genesisPath, parsed }
    );
  }
  if (!SHA256_HEX_REGEX.test(parsed.hash)) {
    throw new AuditLogError(
      'E_GENESIS_HASH_INVALID',
      `Genesis hash must be ${SHA256_HEX_LENGTH}-char lowercase hex SHA-256.`,
      { path: genesisPath, hash: parsed.hash }
    );
  }
  return parsed.hash;
}

/**
 * Read the last non-empty line of the audit log. Returns null when the log
 * file does not exist or is empty (first-entry bootstrap: seq=1).
 *
 * @param {string} logPath
 * @returns {string | null} last JSON line (untrimmed of the terminal newline)
 */
function readLastLogLine(logPath) {
  if (!existsSync(logPath)) return null;
  const raw = readFileSync(logPath, 'utf-8');
  if (raw.length === 0) return null;
  // Split on newline; filter empties (handles trailing newline + blank lines).
  const lines = raw.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  return lines[lines.length - 1];
}

/**
 * Given the last raw log line, parse it and derive {seq, prev_hash} for the
 * next entry. Throws on malformed lines (chain corruption indicator).
 *
 * @param {string} rawLine
 * @returns {{ nextSeq: number, prevHash: string }}
 */
function deriveChainHeadFromLine(rawLine) {
  let parsed;
  try {
    parsed = JSON.parse(rawLine);
  } catch (err) {
    throw new AuditLogError(
      'E_LOG_LINE_MALFORMED',
      `Prior log line is not valid JSON: ${err.message}`,
      { cause: err.message }
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.seq !== 'number' ||
    !Number.isInteger(parsed.seq) ||
    parsed.seq < 1
  ) {
    throw new AuditLogError(
      'E_LOG_LINE_SHAPE_INVALID',
      `Prior log line missing integer seq ≥ 1; chain corrupt.`,
      { parsed }
    );
  }
  const prevHash = createHash('sha256')
    .update(canonicalJSON(parsed))
    .digest('hex');
  return { nextSeq: parsed.seq + 1, prevHash };
}

/**
 * Ensure the audit directory exists. Bootstraps `.claude/audit/` with mode
 * 0o755. Idempotent.
 *
 * @param {string} logPath
 */
function ensureAuditDir(logPath) {
  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: AUDIT_DIR_MODE });
  }
}

/**
 * Atomic single-line append via O_APPEND + fsync. Node's `'a'` flag maps to
 * O_APPEND on POSIX; the kernel atomically advances the file offset on every
 * write(). For sub-PIPE_BUF (4096B) writes this guarantees no partial-line
 * interleaving between concurrent writers — mirrors `audit-append.mjs:504-511`.
 *
 * @param {string} logPath
 * @param {string} line  single JSON line WITHOUT trailing newline
 */
function atomicAppendLine(logPath, line) {
  const withNewline = line + '\n';
  let fd;
  try {
    fd = openSync(logPath, 'a');
  } catch (err) {
    throw new AuditLogError(
      'E_WRITE_FAILED',
      `Cannot open audit log at ${logPath}: ${err.message}`,
      { path: logPath, cause: err.message }
    );
  }
  try {
    writeSync(fd, withNewline);
    // fsync so a crash between write and kernel flush cannot drop the entry.
    // Cost: ~1ms on SSD; audit-log write volume is <100/day so negligible.
    fsyncSync(fd);
  } catch (err) {
    throw new AuditLogError(
      'E_WRITE_FAILED',
      `Failed to append to audit log: ${err.message}`,
      { path: logPath, cause: err.message }
    );
  } finally {
    try {
      closeSync(fd);
    } catch (closeErr) {
      // cr-silent-m4: write is already fsync'd to disk so a close failure
      // cannot lose the appended entry. Historically this was swallowed
      // silently, which masked descriptor-leak / quota-exhaustion /
      // stale-NFS-handle conditions. Emit a structured warning so operators
      // can correlate fd exhaustion against other session anomalies. We do
      // NOT escalate to AuditLogError — the write succeeded and throwing
      // here would corrupt the caller's accounting of chain state.
      console.warn(
        JSON.stringify({
          level: 'warn',
          source: 'pipeline-efficiency-audit-log',
          reason: 'close_failed_post_fsync',
          error_code: closeErr?.code || null,
          error_message: closeErr?.message || String(closeErr),
          path: logPath,
        })
      );
    }
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Append a hash-chained audit entry to
 * `.claude/audit/pipeline-efficiency-changes.log`.
 *
 * Steps:
 *   1. Resolve genesis hash (seeds prev_hash for seq=1).
 *   2. Read current HEAD (last line) → derive nextSeq + prevHash.
 *      If log absent/empty → seq=1 with prev_hash = genesis.hash.
 *   3. Build candidate entry:
 *        { seq, prev_hash, timestamp (ISO-8601 UTC), event_class,
 *          event_subtype, actor, payload }
   *   4. Defensive event_class whitelist (rejects letter-code regressions even
   *      though the schema would also reject).
   *   5. Validate via auditEntrySchema.
 *   6. Atomic single-line append via O_APPEND + fsync.
 *
 * @param {string} event_class     one of 9 canonical named strings (NFR-5)
 * @param {string} event_subtype   human-readable qualifier (non-empty)
 * @param {Record<string, unknown>} payload  event-specific payload
 * @param {object} [options]
 * @param {string} [options.actor]         'operator' | 'agent'; default 'agent'
 * @param {string} [options.timestamp]     ISO-8601 UTC override (for tests)
 * @param {string} [options.projectRoot]   project root override (for tests)
 * @returns {{
 *   entry: Record<string, unknown>,
 *   logPath: string,
 *   seq: number
 * }}
 * @throws {AuditLogError}
 */
export function appendAuditEntry(
  event_class,
  event_subtype,
  payload,
  options = {}
) {
  // AC17.3 defense-in-depth: reject anything that isn't in the 9-class
  // canonical enum BEFORE schema validation, so callers get a stable error code
  // distinct from generic schema failure. The schema would also reject, but
  // a dedicated code makes the "legacy letter code (a..f)" regression easy
  // to grep for in logs.
  if (!EVENT_CLASSES.includes(event_class)) {
    throw new AuditLogError(
      'E_INVALID_EVENT_CLASS',
      `event_class "${event_class}" not in canonical enum. ` +
        `Expected one of: ${EVENT_CLASSES.join(', ')}.`,
      { event_class, expected: EVENT_CLASSES }
    );
  }

  const projectRoot = options.projectRoot || defaultProjectRoot();
  const logPath = join(projectRoot, AUDIT_LOG_RELATIVE_PATH);
  const genesisPath = join(projectRoot, GENESIS_ANCHOR_RELATIVE_PATH);

  // Step 1: genesis hash (seeds prev_hash for seq=1).
  const genesisHash = readGenesisHash(genesisPath);

  // Step 2: read HEAD → derive {nextSeq, prevHash}.
  let nextSeq;
  let prevHash;
  const lastLine = readLastLogLine(logPath);
  if (lastLine === null) {
    // First entry (AC17.5: seq starts at 1; genesis is seq 0).
    nextSeq = 1;
    prevHash = genesisHash;
  } else {
    // Chain continuation.
    const head = deriveChainHeadFromLine(lastLine);
    nextSeq = head.nextSeq;
    prevHash = head.prevHash;
  }

  // Step 3: build candidate entry.
  // actor default 'agent' — this module runs in agent context; operator-
  // sourced entries (e.g., signed-commit triggered flips) pass actor
  // explicitly. Schema rejects any value outside {'operator','agent'}.
  const actor = options.actor || 'agent';
  const timestamp = options.timestamp || new Date().toISOString();
  const entry = {
    seq: nextSeq,
    prev_hash: prevHash,
    timestamp,
    event_class,
    event_subtype,
    actor,
    payload: payload || {},
  };

  // Step 5: schema validation (AC17.1).
  const parsed = auditEntrySchema.safeParse(entry);
  if (!parsed.success) {
    throw new AuditLogError(
      'E_SCHEMA_VALIDATION',
      `Entry failed auditEntrySchema validation: ${parsed.error.message}`,
      { entry, issues: parsed.error.issues }
    );
  }

  // Step 6: atomic append.
  ensureAuditDir(logPath);
  // Serialize as canonical JSON so hashing the entry later (to become
  // prev_hash for seq+1) yields identical bytes regardless of key-order
  // whims during in-memory construction. This matches the hashing convention
  // used by audit-append.mjs (kill-switch chain) and keeps the two chains
  // byte-consistent in their linking semantics.
  const serialized = canonicalJSON(parsed.data);
  atomicAppendLine(logPath, serialized);

  return { entry: parsed.data, logPath, seq: nextSeq };
}

/**
 * Read the current chain HEAD without mutating the log. Callers (e.g.,
 * coercive-flip preflight) use this to inspect last-event metadata before
 * deciding whether to append.
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot]
 * @returns {{
 *   seq: number,
 *   prev_hash: string,
 *   head_entry: Record<string, unknown> | null,
 *   source: 'genesis' | 'log'
 * }}
 */
export function readAuditLogHead(options = {}) {
  const projectRoot = options.projectRoot || defaultProjectRoot();
  const logPath = join(projectRoot, AUDIT_LOG_RELATIVE_PATH);
  const genesisPath = join(projectRoot, GENESIS_ANCHOR_RELATIVE_PATH);

  const lastLine = readLastLogLine(logPath);
  if (lastLine === null) {
    // No entries yet — HEAD is genesis.
    const genesisHash = readGenesisHash(genesisPath);
    return {
      seq: 0,
      prev_hash: genesisHash,
      head_entry: null,
      source: 'genesis',
    };
  }
  const parsed = JSON.parse(lastLine);
  const head = deriveChainHeadFromLine(lastLine);
  return {
    seq: parsed.seq,
    prev_hash: head.prevHash,
    head_entry: parsed,
    source: 'log',
  };
}

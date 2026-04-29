/**
 * Hash-chained append-only enforcement audit log writer.
 *
 * Owner doc: .claude/docs/RTC-ENFORCEMENT-AUDIT.md
 *       (AuditLogWriter behavioral contract)
 * Requirements: REQ-NFR-015 (writer semantics), REQ-NFR-025 (tamper resistance).
 *
 * Surface:
 *   appendEntry(params, opts?) => AuditLogEntry   (SYNCHRONOUS — NOT Promise)
 *
 * Synchronicity: synchronous. Parent contract pins `synchronicity: synchronous`.
 * Callers MUST NOT await the result. fsync-before-return gives deterministic
 * durability.
 *
 * Field ownership (inv-high-8a3b6f91 fix):
 *   timestamp   — caller-supplies wins; writer fills with `new Date().toISOString()`
 *                 only when caller omits.
 *   prev_hash   — strictly writer-assigned. Caller MUST NOT supply.
 *
 * Error codes (inv-med-2f4c5e67):
 *   SCHEMA_VIOLATION  — Zod validation of the merged entry failed, OR caller
 *                       supplied a forbidden `prev_hash`.
 *   LOCK_CONTENTION   — `acquireLock(lockPath, {failOpen: false})` threw after
 *                       its single 100ms retry.
 *   WRITE_FAILED      — one of openSync/writeSync/fsyncSync/closeSync threw.
 *   READ_LAST_FAILED  — reading the log's last line failed with a non-ENOENT
 *                       error. ENOENT is genesis — NOT an error.
 *
 * Genesis: SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.
 */

import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  readFileSync,
  existsSync,
  mkdirSync,
  constants as fsConstants,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

import { jcsCanonicalize, canonicalizeExcludingField } from './jcs-canonicalize.mjs';
import { AuditLogEntrySchema } from './audit-log-entry-schema.mjs';
import { acquireLock, releaseLock } from './session-lock.mjs';

/** SHA-256 of the empty string — genesis prev_hash (EDGE-FA-04). */
const GENESIS_PREV_HASH =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Default log path. Renamed from `enforcement-changes.log` → `rtc-enforcement-changes.log`
 *  (2026-04-20, inv-crit-5b9a2f14) to avoid silent-drop collision. */
const DEFAULT_LOG_PATH = '.claude/audit/rtc-enforcement-changes.log';

/**
 * Construct a structured writer error with a stable `code` + `detail` shape.
 *
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [detail]
 * @returns {Error & {code: string, detail: Record<string, unknown>, issues?: any[]}}
 */
function makeError(code, message, detail = {}) {
  const err = new Error(message);
  /** @type {any} */ (err).code = code;
  /** @type {any} */ (err).detail = detail;
  if (detail && Array.isArray(detail.issues)) {
    /** @type {any} */ (err).issues = detail.issues;
  }
  return /** @type {any} */ (err);
}

/**
 * Read the log's last line + compute prev_hash for the next entry.
 *
 * Returns `{prevHash: GENESIS_PREV_HASH}` when the log file does not exist
 * (ENOENT is genesis — NOT a failure per the contract). Any other fs error
 * throws `READ_LAST_FAILED`.
 *
 * @param {string} logPath
 * @returns {{ prevHash: string }}
 */
function readLastPrevHash(logPath) {
  if (!existsSync(logPath)) {
    return { prevHash: GENESIS_PREV_HASH };
  }

  let content;
  try {
    content = readFileSync(logPath, 'utf-8');
  } catch (err) {
    // ENOENT was filtered above; anything else is READ_LAST_FAILED.
    throw makeError(
      'READ_LAST_FAILED',
      `Failed to read audit log at ${logPath}`,
      { errno: /** @type {any} */ (err).code ?? 'UNKNOWN', logPath },
    );
  }

  const lines = content.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { prevHash: GENESIS_PREV_HASH };
  }

  let lastEntry;
  try {
    lastEntry = JSON.parse(lines[lines.length - 1]);
  } catch (err) {
    throw makeError(
      'READ_LAST_FAILED',
      `Last log line is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { logPath },
    );
  }

  const canonical = canonicalizeExcludingField(lastEntry, 'prev_hash');
  const prevHash = createHash('sha256').update(canonical).digest('hex');
  return { prevHash };
}

/**
 * Append a hash-chained entry to the enforcement audit log.
 *
 * @param {Record<string, unknown>} params - Variant-discriminated entry params.
 *   MUST NOT include `prev_hash`. MAY include `timestamp` (caller wins); if
 *   omitted, writer fills with `new Date().toISOString()`.
 * @param {{logPath?: string}} [opts]
 * @returns {Record<string, unknown>} The written entry (includes prev_hash).
 */
export function appendEntry(params, opts = {}) {
  if (params == null || typeof params !== 'object') {
    throw makeError('SCHEMA_VIOLATION', 'params must be an object', {
      issues: [{ path: [], message: 'params must be an object' }],
    });
  }
  // prev_hash is writer-assigned ONLY (AC3.5).
  if ('prev_hash' in params) {
    throw makeError(
      'SCHEMA_VIOLATION',
      'prev_hash is writer-assigned; caller must not supply',
      {
        issues: [
          {
            path: ['prev_hash'],
            message: 'prev_hash is writer-assigned; caller must not supply',
          },
        ],
        reason: 'prev_hash is writer-assigned; caller must not supply',
      },
    );
  }

  // Accept logPath in either location (opts.logPath OR params.logPath) so
  // callers can use the flatter `appendEntry({...fields, logPath})` form
  // in addition to the canonical `appendEntry(params, {logPath})` form.
  // Strip logPath from params before schema validation so it doesn't fail
  // the `.strict()` variant's unknown-keys check.
  const { logPath: paramsLogPath, ...entryParams } = /** @type {any} */ (params);
  const logPath = opts.logPath || paramsLogPath || DEFAULT_LOG_PATH;
  const lockPath = `${logPath}.lock`;

  // Ensure parent dir exists (mirrors deployment-audit.mjs precedent).
  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      throw makeError(
        'WRITE_FAILED',
        `Failed to create audit log directory ${dir}`,
        { errno: /** @type {any} */ (err).code ?? 'UNKNOWN', dir },
      );
    }
  }

  // Acquire lock (failOpen: false so contention throws). Wrap session-lock's
  // plain Error into our structured LOCK_CONTENTION shape.
  try {
    acquireLock(lockPath, { failOpen: false });
  } catch (err) {
    throw makeError(
      'LOCK_CONTENTION',
      `Failed to acquire audit log lock at ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
      { lockPath },
    );
  }

  try {
    const { prevHash } = readLastPrevHash(logPath);

    // Merge writer-assigned fields. Caller's timestamp wins if supplied
    // (inv-high-8a3b6f91). prev_hash is always writer-assigned.
    const entry = {
      ...entryParams,
      timestamp: entryParams.timestamp ?? new Date().toISOString(),
      prev_hash: prevHash,
    };

    // Schema-validate the MERGED entry — catches missing variant fields,
    // invalid enum values, etc. (AC3.4).
    const validation = AuditLogEntrySchema.safeParse(entry);
    if (!validation.success) {
      throw makeError('SCHEMA_VIOLATION', 'AuditLogEntry schema validation failed', {
        issues: validation.error.issues,
      });
    }

    // Canonicalize + persist.
    const canonical = jcsCanonicalize(entry);

    let fd;
    try {
      fd = openSync(
        logPath,
        // O_APPEND | O_CREAT | O_WRONLY. O_EXCL conflicts with O_CREAT when
        // the target exists (subsequent appends to an extant log would fail
        // EEXIST); the append-only guarantee is enforced by O_APPEND itself +
        // the session lock. Per deployment-audit.mjs precedent.
        fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY,
        0o600,
      );
      writeSync(fd, canonical + '\n');
      fsyncSync(fd);
      closeSync(fd);
    } catch (err) {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          /* best-effort cleanup */
        }
      }
      if (/** @type {any} */ (err).code === 'SCHEMA_VIOLATION') throw err;
      throw makeError(
        'WRITE_FAILED',
        `Failed to append to audit log at ${logPath}: ${err instanceof Error ? err.message : String(err)}`,
        { errno: /** @type {any} */ (err).code ?? 'UNKNOWN', logPath },
      );
    }

    return entry;
  } finally {
    releaseLock(lockPath);
  }
}

export { GENESIS_PREV_HASH };

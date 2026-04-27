/**
 * SessionThresholdSnapshot capture helper.
 *
 * Builds the immutable `session.active_work.threshold_snapshot` object at
 * `session-checkpoint.mjs start-work` time and exposes a validation primitive
 * used by the immutability layer. This is the sole writer of the snapshot
 * shape; subsequent edits to `session.active_work.threshold_snapshot` are
 * rejected by `assertSnapshotImmutable()`.
 *
 * Contract source (verbatim):
 *   sg-pipeline-efficiency-ws1-convergence-pruning / spec.md
 *   §Interfaces & Contracts — Contract: SessionThresholdSnapshot (data-model)
 *
 * Shape (verbatim):
 *   {
 *     per_gate: { [gate_name]: { required_clean_passes, captured_at } },
 *     source: "hardcoded-default" | "enforcement-flag-advisory" | "enforcement-flag-coercive",
 *     session_started_at: ISO-8601,
 *     immutable: true
 *   }
 *
 * Implements:
 *   REQ-012 — SessionThresholdSnapshot capture at start-work + immutability.
 *   REQ-014 — Genesis anchor verification at start-work (advisory) with
 *             hardcoded-default fallback on GENESIS_ANCHOR_INVALID /
 *             CHAIN_BROKEN (as-006).
 *   AC5.1 — snapshot written to `session.active_work.threshold_snapshot` before
 *           any consumer read.
 *   AC5.2 — `source` field reflects enforcement-flag presence/mode or falls
 *           back to "hardcoded-default" when the flag file is absent.
 *   AC5.3 — snapshot carries `immutable: true`.
 *   AC5.4 — `assertSnapshotImmutable()` throws SNAPSHOT_IMMUTABLE_VIOLATION
 *           on any mutation attempt.
 *   AC5.5 — mid-session writes to the enforcement-flag file do not mutate the
 *           already-captured snapshot; the snapshot is frozen by this module.
 *   AC6.1 — when genesis verification passes, `source` follows the
 *           enforcement-flag path unchanged.
 *   AC6.2 — when `verify-audit-chain.mjs` exits with `GENESIS_ANCHOR_INVALID`,
 *           `source` is set to `"hardcoded-default"` AND all per-gate entries
 *           fall back to `required_clean_passes: 2`.
 *   AC6.3 — same fallback applies on `CHAIN_BROKEN`.
 *   AC6.4 — verification is advisory; verify failures never block start-work.
 *
 * Non-goals (deferred to other atomic specs):
 *   - Enforcement-flag file creation (as-015).
 *   - verify-audit-chain.mjs script implementation (as-018 / as-023).
 *   - Migrating consumers to read from the snapshot (Phase C).
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  PerGateThresholdTable,
  PER_GATE_THRESHOLD_TABLE_GATES,
} from './per-gate-threshold-table.mjs';
import {
  enforcementConfigSchema,
} from './schemas/enforcement-config.schema.mjs';

// ============================================================================
// Constants — contract-locked literals
// ============================================================================

/**
 * Enforcement-flag config path relative to `.claude/`. This file is created by
 * as-015 (signed-commit, operator-only). Until that ships, the file is absent
 * and capture falls back to `"hardcoded-default"` per AC5.2.
 *
 * @type {string}
 */
export const ENFORCEMENT_FLAG_RELATIVE_PATH =
  'config/pipeline-efficiency-enforcement.json';

/**
 * Structured error code emitted when any post-capture writer attempts to
 * replace or delete the snapshot. Contract source: AC5.4.
 *
 * @type {string}
 */
export const SNAPSHOT_IMMUTABLE_VIOLATION = 'SNAPSHOT_IMMUTABLE_VIOLATION';

// ============================================================================
// Genesis-anchor verification (as-006 / REQ-014 / EC-13)
// ============================================================================

/**
 * Genesis-anchor file path relative to `.claude/`. Written by as-016 and
 * FULL_BLOCK-protected. Signed via `git commit -S` at ws-1 ship time.
 *
 * @type {string}
 */
export const GENESIS_ANCHOR_RELATIVE_PATH =
  'audit/pipeline-efficiency-genesis.json';

/**
 * SHA-256 of the empty string. Genesis is anchored at the empty-chain seed:
 * `seq: 0`, `hash: SHA256("")`, `previous_genesis_hash: null`. Used by the
 * inline-stub branch of `verifyGenesisAnchor()` when the external
 * `verify-audit-chain.mjs` script (as-018) is not yet shipped.
 *
 * @type {string}
 */
export const EMPTY_STRING_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * Relative path (from `.claude/`) to the external hash-chain verifier shipped
 * by as-018. When present, `verifyGenesisAnchor()` spawns this script with
 * `--include-rotations` and interprets exit code + stderr per the REQ-014
 * contract. When absent, the inline-stub branch runs.
 *
 * @type {string}
 */
export const VERIFY_AUDIT_CHAIN_RELATIVE_PATH = 'scripts/verify-audit-chain.mjs';

/**
 * Structured error codes returned by genesis verification. Match the REQ-014
 * enum verbatim so downstream consumers (completion-verifier, as-027) can
 * distinguish failure modes.
 */
export const GENESIS_ANCHOR_INVALID = 'GENESIS_ANCHOR_INVALID';
export const CHAIN_BROKEN = 'CHAIN_BROKEN';

/**
 * EC-13 fallback value: when genesis verification fails, every gate in the
 * snapshot uses this pass count instead of the per-gate-threshold-table seed.
 * Spec source: spec.md §Edge Cases / EC-13 — "all gates fall back to
 * 2-consecutive-clean".
 *
 * @type {number}
 */
export const GENESIS_FALLBACK_REQUIRED_CLEAN_PASSES = 2;

/**
 * Spawn-timeout for `verify-audit-chain.mjs` in milliseconds. Genesis
 * verification at session-start must not hang start-work; a timeout maps to
 * GENESIS_ANCHOR_INVALID (advisory, AC6.4).
 *
 * @type {number}
 */
export const VERIFY_AUDIT_CHAIN_TIMEOUT_MS = 5000;

const SESSION_THRESHOLD_SNAPSHOT_SOURCES = Object.freeze([
  'hardcoded-default',
  'enforcement-flag-advisory',
  'enforcement-flag-coercive',
]);

const SESSION_THRESHOLD_SNAPSHOT_SOURCE_SET =
  new Set(SESSION_THRESHOLD_SNAPSHOT_SOURCES);

const ISO8601_WITH_OFFSET_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function makeSnapshotValidationError(issues) {
  const message = issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  const error = new Error(message || 'validation failed');
  error.issues = issues;
  return error;
}

function validateSessionThresholdSnapshotForCapture(snapshot) {
  if (!isPlainObject(snapshot)) {
    return {
      success: false,
      error: makeSnapshotValidationError([
        { path: [], message: 'expected object' },
      ]),
    };
  }

  const issues = [];
  const allowedKeys = new Set([
    'per_gate',
    'source',
    'session_started_at',
    'immutable',
  ]);
  for (const key of Object.keys(snapshot)) {
    if (!allowedKeys.has(key)) {
      issues.push({ path: [key], message: 'unknown key' });
    }
  }

  if (!isPlainObject(snapshot.per_gate)) {
    issues.push({ path: ['per_gate'], message: 'expected object' });
  } else {
    for (const [gate, entry] of Object.entries(snapshot.per_gate)) {
      if (!gate) {
        issues.push({ path: ['per_gate', gate], message: 'gate name required' });
        continue;
      }
      if (!isPlainObject(entry)) {
        issues.push({ path: ['per_gate', gate], message: 'expected object' });
        continue;
      }
      for (const key of Object.keys(entry)) {
        if (!['required_clean_passes', 'captured_at'].includes(key)) {
          issues.push({
            path: ['per_gate', gate, key],
            message: 'unknown key',
          });
        }
      }
      if (
        !Number.isInteger(entry.required_clean_passes) ||
        entry.required_clean_passes < 0
      ) {
        issues.push({
          path: ['per_gate', gate, 'required_clean_passes'],
          message: 'required_clean_passes must be a non-negative integer',
        });
      }
      if (
        typeof entry.captured_at !== 'string' ||
        !ISO8601_WITH_OFFSET_REGEX.test(entry.captured_at)
      ) {
        issues.push({
          path: ['per_gate', gate, 'captured_at'],
          message: 'captured_at must be ISO-8601',
        });
      }
    }
  }

  if (!SESSION_THRESHOLD_SNAPSHOT_SOURCE_SET.has(snapshot.source)) {
    issues.push({
      path: ['source'],
      message: `expected one of: ${SESSION_THRESHOLD_SNAPSHOT_SOURCES.join(', ')}`,
    });
  }

  if (
    typeof snapshot.session_started_at !== 'string' ||
    !ISO8601_WITH_OFFSET_REGEX.test(snapshot.session_started_at)
  ) {
    issues.push({
      path: ['session_started_at'],
      message: 'session_started_at must be ISO-8601',
    });
  }

  if (snapshot.immutable !== true) {
    issues.push({
      path: ['immutable'],
      message: 'immutable must be true',
    });
  }

  if (issues.length > 0) {
    return {
      success: false,
      error: makeSnapshotValidationError(issues),
    };
  }

  return { success: true, data: snapshot };
}

/**
 * Extract a structured error code from the verifier's stderr. The verifier
 * may emit JSON lines like `{"error_code":"GENESIS_ANCHOR_INVALID"}` or plain
 * text containing the code as a substring. First match wins.
 *
 * @param {string} stderr — captured stderr text (may be empty)
 * @returns {'GENESIS_ANCHOR_INVALID' | 'CHAIN_BROKEN' | null}
 */
function parseVerifyErrorCode(stderr) {
  if (!stderr || typeof stderr !== 'string') return null;
  // Try structured JSON first.
  for (const line of stderr.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.error_code === 'string') {
        if (obj.error_code === CHAIN_BROKEN) return CHAIN_BROKEN;
        if (obj.error_code === GENESIS_ANCHOR_INVALID) return GENESIS_ANCHOR_INVALID;
      }
    } catch {
      // Not JSON; fall through to substring scan.
    }
  }
  // Fall back to substring match. CHAIN_BROKEN checked first so a message
  // mentioning both resolves to the more specific one.
  if (stderr.includes(CHAIN_BROKEN)) return CHAIN_BROKEN;
  if (stderr.includes(GENESIS_ANCHOR_INVALID)) return GENESIS_ANCHOR_INVALID;
  return null;
}

/**
 * Inline stub: validate the genesis-anchor file shape verbatim against
 * REQ-014 when the external verifier script is not yet shipped (as-018).
 *
 * The stub validates genesis shape ONLY (no chain traversal), so
 * CHAIN_BROKEN is unreachable from this branch. That is deliberate per
 * as-006 scope ("Out-of-scope: verify-audit-chain.mjs implementation").
 *
 * @param {string} claudeDir — absolute path to `.claude/` root
 * @returns {{ok: true} | {ok: false, code: 'GENESIS_ANCHOR_INVALID', detail: string}}
 */
function verifyGenesisAnchorInline(claudeDir) {
  const genesisPath = join(claudeDir, GENESIS_ANCHOR_RELATIVE_PATH);
  if (!existsSync(genesisPath)) {
    return { ok: false, code: GENESIS_ANCHOR_INVALID, detail: 'genesis file absent' };
  }

  let raw;
  try {
    raw = readFileSync(genesisPath, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      code: GENESIS_ANCHOR_INVALID,
      detail: `genesis read failed: ${err?.message || String(err)}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      code: GENESIS_ANCHOR_INVALID,
      detail: `genesis JSON malformed: ${err?.message || String(err)}`,
    };
  }

  // REQ-014 shape: { seq: 0, hash: SHA256(""), signed_by: string, previous_genesis_hash: string | null }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: GENESIS_ANCHOR_INVALID, detail: 'genesis not an object' };
  }
  if (parsed.seq !== 0) {
    return { ok: false, code: GENESIS_ANCHOR_INVALID, detail: `seq expected 0, got ${String(parsed.seq)}` };
  }
  if (typeof parsed.hash !== 'string' || parsed.hash !== EMPTY_STRING_SHA256) {
    return {
      ok: false,
      code: GENESIS_ANCHOR_INVALID,
      detail: `hash does not match SHA256("")`,
    };
  }
  if (typeof parsed.signed_by !== 'string' || parsed.signed_by.length === 0) {
    return { ok: false, code: GENESIS_ANCHOR_INVALID, detail: 'signed_by missing' };
  }
  if (parsed.previous_genesis_hash !== null && typeof parsed.previous_genesis_hash !== 'string') {
    return {
      ok: false,
      code: GENESIS_ANCHOR_INVALID,
      detail: 'previous_genesis_hash must be null or string',
    };
  }

  // Double-check: if previous_genesis_hash is null (bootstrap case), genesis
  // is anchored at the empty-chain seed. Recompute SHA256("") to catch any
  // future drift in the hardcoded constant.
  if (parsed.previous_genesis_hash === null) {
    const computed = createHash('sha256').update('').digest('hex');
    if (computed !== parsed.hash) {
      return {
        ok: false,
        code: GENESIS_ANCHOR_INVALID,
        detail: 'computed SHA256("") does not match genesis.hash',
      };
    }
  }

  return { ok: true };
}

/**
 * Verify the genesis anchor and audit-log hash chain.
 *
 * Spawn-first, stub-fallback:
 *   - If `.claude/scripts/verify-audit-chain.mjs` is present (as-018 landed),
 *     spawn it synchronously with `--include-rotations` (timeout
 *     `VERIFY_AUDIT_CHAIN_TIMEOUT_MS`). Interpret exit code + stderr per the
 *     REQ-014 contract:
 *       * exit 0                                      → {ok: true}
 *       * non-zero + stderr contains CHAIN_BROKEN     → {ok: false, code: CHAIN_BROKEN}
 *       * non-zero + stderr contains GENESIS_*        → {ok: false, code: GENESIS_ANCHOR_INVALID}
 *       * non-zero without recognizable code          → {ok: false, code: GENESIS_ANCHOR_INVALID}
 *       * spawn error / timeout                       → {ok: false, code: GENESIS_ANCHOR_INVALID}
 *   - If the script is absent, fall back to an in-process shape check on the
 *     genesis file (see `verifyGenesisAnchorInline()`).
 *
 * AC6.4: advisory — this function NEVER throws. A failure is represented as a
 * `{ok: false, code}` return so `buildSessionThresholdSnapshot()` can compose
 * its fallback branch without try/catch in the hot path.
 *
 * TODO(assumption) high: spawn contract (exit 0 = ok; exit non-zero with
 * stderr-embedded `error_code` = failure) is derived from REQ-014 wording
 * (spec.md:188-194) and matches the as-006 integration-test stub shape. When
 * as-018 formalizes the script CLI, confirm exit-code map matches.
 *
 * @param {string} claudeDir — absolute path to `.claude/` root
 * @returns {{ok: true} | {ok: false, code: 'GENESIS_ANCHOR_INVALID' | 'CHAIN_BROKEN', detail?: string}}
 */
export function verifyGenesisAnchor(claudeDir) {
  if (!claudeDir || typeof claudeDir !== 'string') {
    // Defensive: programmer-error at the call site; treat as advisory failure
    // rather than throwing so we still produce a snapshot (AC6.4).
    return { ok: false, code: GENESIS_ANCHOR_INVALID, detail: 'claudeDir missing' };
  }

  const verifyScriptPath = join(claudeDir, VERIFY_AUDIT_CHAIN_RELATIVE_PATH);

  // Spawn path: external verifier is present → invoke it.
  if (existsSync(verifyScriptPath)) {
    let result;
    try {
      result = spawnSync(
        process.execPath,
        [verifyScriptPath, '--include-rotations'],
        {
          cwd: dirname(claudeDir),
          encoding: 'utf-8',
          timeout: VERIFY_AUDIT_CHAIN_TIMEOUT_MS,
          // Merge into a clean env so signed-commit hooks / shells don't
          // influence the verifier; let the script read its own files.
          env: process.env,
        },
      );
    } catch (err) {
      // spawnSync itself threw (rare) — advisory failure.
      return {
        ok: false,
        code: GENESIS_ANCHOR_INVALID,
        detail: `verify-audit-chain spawn threw: ${err?.message || String(err)}`,
      };
    }

    // Spawn-level problems: ENOENT, timeout signal, etc.
    if (result.error) {
      return {
        ok: false,
        code: GENESIS_ANCHOR_INVALID,
        detail: `verify-audit-chain spawn error: ${result.error.message}`,
      };
    }
    if (result.signal) {
      return {
        ok: false,
        code: GENESIS_ANCHOR_INVALID,
        detail: `verify-audit-chain killed by signal ${result.signal}`,
      };
    }

    if (result.status === 0) {
      return { ok: true };
    }

    // Non-zero exit: classify via stderr.
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    const code = parseVerifyErrorCode(stderr) || GENESIS_ANCHOR_INVALID;
    return {
      ok: false,
      code,
      detail: `verify-audit-chain exit ${result.status}; stderr: ${stderr.slice(0, 200)}`,
    };
  }

  // Stub path: external verifier absent (as-018 not yet shipped). Validate
  // genesis file shape in-process per REQ-014.
  return verifyGenesisAnchorInline(claudeDir);
}

/**
 * Audit-log a genesis-verify failure with `event_class: 'sentinel_lifecycle'`.
 *
 * sec-genesisfb-e2a17d09 (security-review pass 1 Medium, accepted as
 * security-risk acknowledgment):
 *   Genesis-anchor verify failures silently switched the session to
 *   hardcoded-default fallback (AC6.2 / AC6.3). Operators had no audit-log
 *   evidence of WHICH sessions fell back or WHY — the fallback is advisory
 *   by design (AC6.4) but its invocation is security-relevant because it
 *   reverts thresholds from pruned (≥1 clean pass) to conservative (≥2).
 *   Emit a hash-chained audit entry on every fallback so reverse-governance
 *   monitoring can correlate unexpected fallback spikes.
 *
 * Event shape:
 *   event_class:  'sentinel_lifecycle'
 *   subtype:      'genesis-verify-failed-<code>'
 *   payload:      { reason: 'genesis_verify_failed',
 *                   fallback_applied: true,
 *                   error_code: 'GENESIS_ANCHOR_INVALID' | 'CHAIN_BROKEN',
 *                   detail: <bounded string, <= 200 chars> }
 *
 * Safety:
 *   - Dynamic `import()` avoids a module-graph cycle (audit-log → audit-chain
 *     → snapshot-capture would be transitively circular if static).
 *   - Top-level try/catch swallows ANY append failure. An audit-chain that
 *     cannot be appended to is itself the reason the genesis verify might
 *     have failed; crashing session-start on that would be worse than the
 *     silent fallback this logging replaces.
 *   - Structured warning on stderr so the failure is still observable to
 *     operators running interactively even when the hash-chain append
 *     didn't land.
 *
 * @param {string} claudeDir
 * @param {{ok: false, code: string, detail?: string}} genesisResult
 * @returns {void}
 */
function auditGenesisVerifyFailure(claudeDir, genesisResult) {
  const detail =
    typeof genesisResult.detail === 'string'
      ? genesisResult.detail.slice(0, 200)
      : undefined;
  const payload = {
    reason: 'genesis_verify_failed',
    fallback_applied: true,
    error_code: genesisResult.code,
  };
  if (detail !== undefined) {
    payload.detail = detail;
  }

  // appendAuditEntry wants a project-root (parent of `.claude/`), not the
  // `.claude/` directory itself. Translate once.
  const projectRoot = dirname(claudeDir);

  // async-safe append. Dynamic import keeps this module cycle-free: callers
  // that only need `verifyGenesisAnchor()` do not pay the audit-log import
  // cost, and the audit-log module's own imports (which include audit-chain)
  // can safely consume canonicalJSON without circular risk.
  import('../pipeline-efficiency-audit-log.mjs')
    .then(({ appendAuditEntry }) => {
      try {
        appendAuditEntry(
          'sentinel_lifecycle',
          `genesis-verify-failed-${genesisResult.code}`,
          payload,
          { projectRoot }
        );
      } catch (appendErr) {
        // Append itself failed (e.g. because the chain is what broke). Log
        // to stderr so the failure is observable without crashing session
        // start. Matches the "audit never throws to the caller" invariant
        // documented at the top of this helper.
        try {
          process.stderr.write(
            JSON.stringify({
              level: 'warn',
              source: 'snapshot-capture',
              reason: 'genesis_verify_audit_append_failed',
              error_code: appendErr?.code || null,
              error_message: appendErr?.message || String(appendErr),
            }) + '\n'
          );
        } catch {
          /* stderr write failure is terminal — silently ignore. */
        }
      }
    })
    .catch((importErr) => {
      // Dynamic import itself failed (rare: syntax error, missing file).
      // Stay async-safe: do not propagate.
      try {
        process.stderr.write(
          JSON.stringify({
            level: 'warn',
            source: 'snapshot-capture',
            reason: 'genesis_verify_audit_import_failed',
            error_message: importErr?.message || String(importErr),
          }) + '\n'
        );
      } catch {
        /* ignore */
      }
    });
}

// ============================================================================
// Source resolution
// ============================================================================

/**
 * Read and validate the enforcement-flag config at
 * `.claude/config/pipeline-efficiency-enforcement.json`.
 *
 * Returns the validated config when the file is present AND parseable AND
 * schema-valid. Returns `null` otherwise (file absent, malformed JSON, or
 * schema violation). `null` signals "fall back to hardcoded-default" per
 * AC5.2.
 *
 * @param {string} claudeDir — absolute path to `.claude/` root
 * @returns {{ mode: 'advisory' | 'coercive' | 'off' } | null}
 */
export function readEnforcementFlag(claudeDir) {
  const flagPath = join(claudeDir, ENFORCEMENT_FLAG_RELATIVE_PATH);
  if (!existsSync(flagPath)) {
    // AC5.2: absent → hardcoded-default branch in caller.
    return null;
  }
  let raw;
  try {
    raw = readFileSync(flagPath, 'utf-8');
  } catch {
    // Read error (permissions, transient FS) → treat as absent; the
    // hardcoded-default fallback is the safe path.
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON → fall back. Structured error propagation is the
    // responsibility of as-015 / as-021 (the canonical reader); this helper
    // stays silent to preserve start-work's fail-open posture.
    return null;
  }
  const validated = enforcementConfigSchema.safeParse(parsed);
  if (!validated.success) {
    return null;
  }
  return validated.data;
}

/**
 * Resolve the `source` field for a SessionThresholdSnapshot.
 *
 * Mapping (AC5.2):
 *   - flag absent OR invalid                          → "hardcoded-default"
 *   - flag present, mode="advisory"                   → "enforcement-flag-advisory"
 *   - flag present, mode="coercive"                   → "enforcement-flag-coercive"
 *   - flag present, mode="off"                        → "hardcoded-default"
 *       (The `off` mode disables enforcement entirely; thresholds still derive
 *        from the hardcoded table. No "enforcement-flag-off" source value
 *        exists per the SessionThresholdSnapshot enum.)
 *
 * @param {{ mode: 'advisory' | 'coercive' | 'off' } | null} flag
 * @returns {'hardcoded-default' | 'enforcement-flag-advisory' | 'enforcement-flag-coercive'}
 */
export function resolveSnapshotSource(flag) {
  if (!flag) {
    return 'hardcoded-default';
  }
  if (flag.mode === 'advisory') {
    return 'enforcement-flag-advisory';
  }
  if (flag.mode === 'coercive') {
    return 'enforcement-flag-coercive';
  }
  // mode === 'off' (or any other fall-through): snapshot source records the
  // hardcoded-default provenance. Note: "off" at the flag layer is a separate
  // decision from snapshot provenance; kill-switch semantics live elsewhere.
  return 'hardcoded-default';
}

// ============================================================================
// Snapshot construction
// ============================================================================

/**
 * Build the immutable SessionThresholdSnapshot object.
 *
   * Reads `PerGateThresholdTable` (in-memory export from
   * `lib/per-gate-threshold-table.mjs`, validated at module load) and
 * projects each gate entry into the per-gate snapshot shape defined by
 * `SessionThresholdSnapshot` (`{ required_clean_passes, captured_at }`).
 *
   * The returned object is validated against the SessionThresholdSnapshot shape
 * and deep-frozen so downstream readers observe a stable value and mutation
 * attempts via direct property assignment fail silently under strict mode
 * (the immutability enforcement layer in `saveSession()` provides the
 * throwing guarantee for in-memory→disk writes).
 *
 * @param {object} opts
 * @param {string} opts.claudeDir — absolute path to `.claude/` root
 * @param {string} [opts.sessionStartedAt] — ISO-8601 timestamp; defaults to now
 * @returns {Readonly<{
 *   per_gate: Readonly<Record<string, Readonly<{ required_clean_passes: number, captured_at: string }>>>,
 *   source: 'hardcoded-default' | 'enforcement-flag-advisory' | 'enforcement-flag-coercive',
 *   session_started_at: string,
 *   immutable: true
 * }>}
 */
export function buildSessionThresholdSnapshot({
  claudeDir,
  sessionStartedAt,
} = {}) {
  if (!claudeDir || typeof claudeDir !== 'string') {
    throw new Error(
      'buildSessionThresholdSnapshot: claudeDir (absolute path to .claude/) is required'
    );
  }
  const capturedAt = sessionStartedAt || new Date().toISOString();

  // AC6.1..AC6.4: genesis-anchor verification (advisory).
  // Runs BEFORE source/per_gate resolution so fallback can override both.
  // verifyGenesisAnchor() never throws (AC6.4); a failure is surfaced as
  // {ok: false, code}.
  const genesisResult = verifyGenesisAnchor(claudeDir);
  const genesisInvalid = genesisResult.ok === false;

  // sec-genesisfb-e2a17d09: fire-and-forget audit-log entry on fallback
  // activation. Async-safe — never blocks snapshot construction, never
  // throws to the caller. Emitted only on actual fallback transitions so
  // the audit-chain doesn't accumulate noise on healthy session starts.
  if (genesisInvalid) {
    auditGenesisVerifyFailure(claudeDir, genesisResult);
  }

  // AC5.2 / AC6.1: when genesis is valid, compute `source` from enforcement-
  // flag presence/mode as before. AC6.2 / AC6.3: when genesis verify fails
  // with GENESIS_ANCHOR_INVALID or CHAIN_BROKEN, `source` is forced to
  // "hardcoded-default" regardless of the enforcement-flag.
  let source;
  if (genesisInvalid) {
    source = 'hardcoded-default';
  } else {
    const flag = readEnforcementFlag(claudeDir);
    source = resolveSnapshotSource(flag);
  }

  // AC5.1 / AC6.2 / AC6.3: project PerGateThresholdTable into the snapshot
  // per_gate shape. When genesis is invalid, EVERY gate falls back to
  // required_clean_passes = 2 per EC-13, regardless of the table's seeded
  // value. Iterate in canonical gate order so snapshot serialization is
  // stable.
  const perGate = {};
  for (const gate of PER_GATE_THRESHOLD_TABLE_GATES) {
    const entry = PerGateThresholdTable[gate];
    if (!entry) {
    // Defensive: the table is frozen + validated at module load, so a
      // missing gate would be a programmer error in per-gate-threshold-table.mjs.
      // Fail-closed: refuse to emit a partial snapshot.
      throw new Error(
        `buildSessionThresholdSnapshot: PerGateThresholdTable missing gate '${gate}'`
      );
    }
    const requiredCleanPasses = genesisInvalid
      ? GENESIS_FALLBACK_REQUIRED_CLEAN_PASSES
      : entry.required_clean_passes;
    perGate[gate] = Object.freeze({
      required_clean_passes: requiredCleanPasses,
      captured_at: capturedAt,
    });
  }

  const snapshot = {
    per_gate: Object.freeze(perGate),
    source,
    session_started_at: capturedAt,
    // AC5.3: immutability self-declaration; Zod schema enforces literal(true).
    immutable: true,
  };

  // Validate at the write boundary before freezing.
  const validated = validateSessionThresholdSnapshotForCapture(snapshot);
  if (!validated.success) {
    // Fail-closed: a schema-violating snapshot must never reach session.json.
    const msg = validated.error?.issues
      ?.map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ') || 'unknown';
    throw new Error(
      `buildSessionThresholdSnapshot: schema validation failed (${msg})`
    );
  }

  return Object.freeze(snapshot);
}

// ============================================================================
// Immutability enforcement
// ============================================================================

/**
 * Deterministic, order-independent comparator for two snapshot values.
 *
 * Equality semantics (AC5.4): the snapshot is immutable once captured, so a
 * write is rejected when the new snapshot differs from the stored one OR the
 * new session strips the snapshot entirely (null/undefined). The comparator
 * below uses JSON structural equality because snapshots are plain, strictly
 * shaped objects with only primitive leaves — no Date objects, no functions,
 * no references.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function snapshotsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Assert that the in-memory session's `active_work.threshold_snapshot` matches
 * (or extends from absent to present) the snapshot already persisted to
 * session.json.
 *
 * Called by `saveSession()` on every write. Semantics (AC5.4):
 *   - no prior snapshot on disk            → pass (initial capture)
 *   - prior snapshot on disk, in-memory missing/replaced
 *                                          → throw unless caller explicitly
 *                                            permits an active-work lifecycle reset
 *   - prior snapshot equals in-memory      → pass
 *   - prior snapshot differs from in-memory
 *                                          → throw SNAPSHOT_IMMUTABLE_VIOLATION
 *
 * @param {object} incomingSession — session object about to be written
 * @param {object | null} previousSession — session object currently on disk
 *                                           (null when file does not exist)
 * @param {object} [opts]
 * @param {boolean} [opts.allowLifecycleReset=false]
 * @throws {Error} with `.code = SNAPSHOT_IMMUTABLE_VIOLATION` on mutation
 */
export function assertSnapshotImmutable(incomingSession, previousSession, opts = {}) {
  const allowLifecycleReset = opts.allowLifecycleReset === true;
  const previousActiveWork = previousSession?.active_work ?? null;
  const incomingActiveWork = incomingSession?.active_work ?? null;
  const previousSnapshot =
    previousActiveWork?.threshold_snapshot ?? null;
  if (previousSnapshot === null || previousSnapshot === undefined) {
    // No snapshot captured yet; any value (including absent) is permitted.
    return;
  }

  const incomingSnapshot = incomingActiveWork?.threshold_snapshot ?? null;
  if (incomingSnapshot === null || incomingSnapshot === undefined) {
    if (allowLifecycleReset && incomingActiveWork === null) {
      return;
    }
    // AC5.4: once captured, the snapshot must persist. Clearing it is a
    // mutation attempt.
    const err = new Error(
      `${SNAPSHOT_IMMUTABLE_VIOLATION}: cannot clear session.active_work.threshold_snapshot after capture`
    );
    err.code = SNAPSHOT_IMMUTABLE_VIOLATION;
    throw err;
  }

  if (
    allowLifecycleReset &&
    incomingActiveWork?.spec_group_id !== previousActiveWork?.spec_group_id
  ) {
    return;
  }

  if (!snapshotsEqual(previousSnapshot, incomingSnapshot)) {
    const err = new Error(
      `${SNAPSHOT_IMMUTABLE_VIOLATION}: session.active_work.threshold_snapshot is immutable after capture at start-work`
    );
    err.code = SNAPSHOT_IMMUTABLE_VIOLATION;
    throw err;
  }
}

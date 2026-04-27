/**
 * worktree-canon-audit.mjs — centralized audit-log emission helper for every
 * `WORKTREE_PATH_VIOLATION` rejection.
 *
 * Spec: sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-009 / REQ-007 /
 *       NFR-5 item e (MasterSpec audit-log event-class catalog).
 *
 * Purpose
 * -------
 * Single source of truth for appending `worktree_path_violation` audit entries
 * to `.claude/audit/pipeline-efficiency-changes.log`. Consumers (as-007
 * session-checkpoint start-work pin capture, as-008 file-protection + DAG
 * phase-transition enforcement shim, and this spec's completion-verifier
 * pre-merge wiring) call `logWorktreeViolation(violation, options)` instead
 * of open-coding the `appendAuditEntry` call. This eliminates the per-site
 * payload-shape and silent-failure drift surface flagged in Challenger Pass 1.
 *
 * Design invariants (contract)
 * ----------------------------
 * - Best-effort: never throws from the caller's hot path. Enforcement is the
 *   primary obligation; audit is observability. When the audit chain is
 *   absent (test fixtures, fresh installs, genesis-anchor missing), the
 *   helper returns `{audited: false, error}` silently.
 * - Event class is fixed: `'worktree_path_violation'` — one of the 9 canonical
 *   NFR-5 classes (audit-entry.schema.mjs:87).
 * - Event subtype is the violation reason (`symlink-component`, `path-escape`,
 *   `env-mutation`, `case-fs-mismatch`) — matches the closed enum in
 *   `worktree-canon.mjs:81-86` and `worktree-enforcement.mjs:124-129`.
 * - Payload shape carries `{attempted_path, pinned_root, consumer, ...extras}`
 *   so downstream grep tooling can filter by consumer site without parsing
 *   the violation message. `consumer` is required so multi-site emissions
 *   are traceable.
 * - `actor` defaults to `'agent'` (matches appendAuditEntry default) but
 *   consumers MAY override for operator-triggered rotations.
 * - `timestamp` defaults to `new Date().toISOString()` but consumers MAY
 *   override for deterministic tests.
 *
 * Why a shared helper (not inline calls)?
 * ---------------------------------------
 * Challenger Pass 1 (chk-migration-b1d4e9a2 cohort) noted that inlining
 * `appendAuditEntry` in every consumer produced divergent payload shapes:
 * as-008's `appendWorktreeAuditEntry` wraps the appender dynamically with
 * `{audited: boolean}` return, but open-coded consumers (e.g., hypothetical
 * future plug-in points) could drop the silent-failure guard and blow up
 * the hot path. A single helper closes that drift surface.
 *
 * Acceptable Assumption Domains (per Self-Answer Protocol)
 * --------------------------------------------------------
 * - SELF-RESOLVED(code): Reason enum values mirror worktree-canon.mjs (line
 *   81-86). Schema (audit-entry.schema.mjs:79-89) includes
 *   'worktree_path_violation' as canonical class.
 * - SELF-RESOLVED(code): Silent-failure semantics match the existing
 *   worktree-enforcement.mjs:474-493 `appendWorktreeAuditEntry` pattern —
 *   return `{audited: boolean, error?: string}` on both success and failure
 *   paths. Spec §Implementation Notes ("backward-compat retained") plus
 *   as-008's shipped contract set the precedent.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// =============================================================================
// Constants
// =============================================================================

/**
 * Canonical event_class for every entry emitted by this helper. One of the
 * 9 NFR-5 classes defined in `lib/schemas/audit-entry.schema.mjs:79-89`.
 * Appender double-checks this value; we hardcode to prevent caller typos.
 */
export const WORKTREE_VIOLATION_EVENT_CLASS = 'worktree_path_violation';

/**
 * Closed enum of reason codes accepted by the helper. Mirrors the structured
 * error contract declared in `.claude/scripts/lib/worktree-canon.mjs:81-86`
 * and `worktree-enforcement.mjs:124-129`. Any reason outside this set is
 * rejected upstream of audit emission (defense-in-depth; callers should
 * already be constructing violations via `WorktreePathViolationError`).
 */
export const WORKTREE_VIOLATION_REASONS = Object.freeze([
  'symlink-component',
  'path-escape',
  'env-mutation',
  'case-fs-mismatch',
]);

/**
 * Default actor. Matches `appendAuditEntry`'s own default
 * (pipeline-efficiency-audit-log.mjs:388) and preserves the agent/operator
 * actor semantics enforced by the schema.
 */
const DEFAULT_ACTOR = 'agent';

// =============================================================================
// Sibling-script resolution
// =============================================================================

/**
 * Absolute path to this file's directory. Used to locate the sibling
 * `pipeline-efficiency-audit-log.mjs` without depending on cwd. Matches the
 * pattern in `completion-verifier-hooks.mjs:147-149`.
 */
function resolveLibDir() {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Absolute path to the appender module. One directory up from this
 * `lib/` directory.
 */
function resolveAppenderPath() {
  return resolve(resolveLibDir(), '..', 'pipeline-efficiency-audit-log.mjs');
}

// =============================================================================
// Helper — logWorktreeViolation
// =============================================================================

/**
 * Emit a hash-chained audit entry on a `WORKTREE_PATH_VIOLATION` rejection.
 *
 * Best-effort: never throws. Returns a structured diagnostic so callers can
 * decide whether to surface the audit-failure separately (enforcement paths
 * typically do NOT — the violation rejection is already propagated to the
 * operator via stderr + exit 2).
 *
 * The appender lives at `.claude/scripts/pipeline-efficiency-audit-log.mjs`,
 * which expects a populated genesis anchor at
 * `.claude/audit/pipeline-efficiency-genesis.json`. When the anchor is
 * absent (test fixtures, fresh installs that haven't bootstrapped the
 * chain), the appender raises `E_GENESIS_ANCHOR_MISSING` — we swallow that
 * silently and return `{audited: false, error: 'E_GENESIS_ANCHOR_MISSING'}`.
 *
 * @param {object} violation
 *   Required violation shape. Matches `WorktreePathViolationError.toStructured()`.
 * @param {string} violation.reason
 *   One of WORKTREE_VIOLATION_REASONS. Used as audit-entry `event_subtype`.
 * @param {string} violation.attempted_path
 *   Absolute path that failed containment. Recorded in payload for grep.
 * @param {string} violation.pinned_root
 *   Canonical pin (session.active_work.project_dir_pin). Recorded in payload.
 * @param {string} [violation.actor]
 *   Override the actor field ('agent' | 'operator'). Default 'agent'.
 * @param {string} [violation.timestamp]
 *   Override the ISO-8601 UTC timestamp (test-only). Default `Date.now()`.
 *
 * @param {object} [options]
 * @param {string} [options.consumer]
 *   Short identifier for the calling site (e.g. `'completion-verifier'`,
 *   `'workflow-file-protection'`). Included in payload so operators can
 *   correlate violations with the hook/agent that raised them. Required
 *   for traceability but helper accepts missing value (falls back to
 *   `'unknown-consumer'` so audit entry remains valid; schema requires
 *   non-empty `event_subtype` not payload fields).
 * @param {Record<string, unknown>} [options.extras]
 *   Additional payload fields merged after the base shape. Does NOT
 *   override `attempted_path`, `pinned_root`, or `consumer`.
 * @param {string} [options.projectRoot]
 *   Override the project root used to resolve the audit-log + genesis paths.
 *   Defaults to `process.env.CLAUDE_PROJECT_DIR || process.cwd()` via the
 *   appender's own default resolver.
 *
 * @returns {Promise<{audited: boolean, seq?: number, error?: string}>}
 */
export async function logWorktreeViolation(violation, options = {}) {
  // Type gate: non-object input must not crash the caller.
  if (!violation || typeof violation !== 'object') {
    return { audited: false, error: 'INVALID_VIOLATION_INPUT' };
  }

  const reason = typeof violation.reason === 'string' ? violation.reason : '';
  if (!WORKTREE_VIOLATION_REASONS.includes(reason)) {
    // Reason outside the closed enum — the schema will reject anyway, but
    // failing fast here yields a stable diagnostic code for grep.
    return { audited: false, error: 'INVALID_VIOLATION_REASON' };
  }

  const attempted_path =
    typeof violation.attempted_path === 'string' ? violation.attempted_path : '';
  const pinned_root =
    typeof violation.pinned_root === 'string' ? violation.pinned_root : '';
  const actor = violation.actor === 'operator' ? 'operator' : DEFAULT_ACTOR;
  const consumer =
    typeof options.consumer === 'string' && options.consumer.length > 0
      ? options.consumer
      : 'unknown-consumer';

  const basePayload = {
    attempted_path,
    pinned_root,
    consumer,
  };
  // Merge caller extras LAST-BUT-NOT-OVERRIDING: build extras first, then
  // overlay base so core fields survive any naming collision.
  const extras =
    options.extras && typeof options.extras === 'object' && !Array.isArray(options.extras)
      ? options.extras
      : {};
  const payload = { ...extras, ...basePayload };

  const appenderOpts = { actor };
  if (typeof violation.timestamp === 'string' && violation.timestamp.length > 0) {
    appenderOpts.timestamp = violation.timestamp;
  }
  if (options.projectRoot) {
    appenderOpts.projectRoot = options.projectRoot;
  }

  try {
    const mod = await import(resolveAppenderPath());
    const result = mod.appendAuditEntry(
      WORKTREE_VIOLATION_EVENT_CLASS,
      reason,
      payload,
      appenderOpts,
    );
    return { audited: true, seq: result?.seq };
  } catch (err) {
    // Enforcement MUST NOT block on audit-log unavailability. Surface the
    // diagnostic code (AuditLogError.code if present) or the message as a
    // last resort.
    const code = err && typeof err.code === 'string' ? err.code : null;
    return {
      audited: false,
      error: code || (err && err.message ? err.message : String(err)),
    };
  }
}

/**
 * worktree-enforcement.mjs — shared enforcement wrapper for as-008.
 *
 * Spec: sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-008
 * REQ:  REQ-007 (worktree-absolute-path contract / NFR-WORKTREE-CANON)
 * ACs:  AC8.1 (file-protection hook rejects path-escape with audit entry)
 *       AC8.2 (workflow-dag phase-transition validator rejects env-mutation)
 *
 * Responsibilities
 * ----------------
 * 1. Provide `checkWorktreePathViolation(target, pin, options)` — canonicalizes
 *    a write-target path and asserts containment against the session-level
 *    `project_dir_pin`. Returns a structured error object on violation; null
 *    on accept. Case-folded compare on Darwin (auto-detected); exact on Linux.
 *
 * 2. Provide `enforceEnvParity(pin, options)` — asserts the current
 *    `CLAUDE_PROJECT_DIR` canonicalizes to the pin. Throws on env-mutation
 *    (mid-session swap of the env var to a different canonical root).
 *
 * 3. Provide `loadProjectDirPin(options)` — reads
 *    `session.active_work.project_dir_pin` from `.claude/context/session.json`.
 *    Returns `null` for legacy sessions started before as-006 landed (i.e.,
 *    sessions that never captured a pin). Callers MUST treat null as "skip
 *    enforcement" (Task 4: legacy-session guard).
 *
 * 4. Provide `appendWorktreeAuditEntry(reason, payload, options)` —
 *    best-effort wrapper around `appendAuditEntry` from
 *    `pipeline-efficiency-audit-log.mjs`. Silent on audit-write failure (the
 *    enforcement path must not be blocked by audit-log unavailability).
 *
 * Integration with as-005 worktree-canon library
 * -----------------------------------------------
 * When `.claude/scripts/lib/worktree-canon.mjs` (as-005 deliverable) is
 * present, this module MAY delegate `canonicalize()` / `validateAgainstPin()`
 * to the canonical library. Until as-005 lands, this module uses
 * `getCanonicalProjectDir()` and `fs.realpathSync` directly — both paths
 * produce byte-identical results for in-repo paths (the only paths this hook
 * can legitimately see). The local copy-in-enforcement semantics here are
 * the spec contract shape per spec.md §Interfaces-&-Contracts:
 *   { code: "WORKTREE_PATH_VIOLATION",
 *     reason: "symlink-component" | "path-escape" | "env-mutation" | "case-fs-mismatch",
 *     attempted_path, pinned_root, exit_code: 2 }
 *
 * Legacy-session guard
 * --------------------
 * `session.active_work.project_dir_pin` is populated by as-006's
 * `start-work` handler. Sessions started before as-006 ship will have no
 * pin; consumers of this module MUST call `loadProjectDirPin()` first and
 * fall through to legacy behavior when it returns null. This preserves
 * zero-regression deployment (Atomicity Justification "Independently
 * Deployable").
 */

import {
  existsSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';
import { platform } from 'node:os';
import {
  getCanonicalProjectDir,
  CanonicalProjectDirError,
} from './hook-utils.mjs';
import * as _canonMod from './worktree-canon.mjs';

// =============================================================================
// Delegation to as-005's worktree-canon.mjs library
// =============================================================================
//
// `_canonMod` is imported statically at the top of this file (`import * as
// _canonMod from './worktree-canon.mjs'`). The as-005 library is a peer
// atomic spec that ships in the same commit as as-008, so static import is
// safe — the module is guaranteed to resolve. A prior dynamic-import +
// swallow-any-error try/catch has been removed because it silently masked
// syntax errors and internal throws from worktree-canon.mjs (MED-002 from
// ws-3 code-review Pass 1).
//
// If a future revision of as-005 changes signatures, the shim below MUST be
// updated in the SAME commit (single-source-of-truth invariant). Evidence
// table entry required in the amending spec.
//
// Legitimate absence of the library (hypothetical bare clones / test
// fixtures that strip it) is now a hard import failure at module load,
// which is the correct observable behavior: the enforcement path cannot
// silently degrade.

// =============================================================================
// Constants (contract shape per spec.md §Interfaces-&-Contracts L262-275)
// =============================================================================

/**
 * Error-code constant for worktree-path violations. Matches the
 * NFR-WORKTREE-CANON contract (spec.md L262). Consumers emit this string as
 * `code` field in the structured error object so log consumers (audit
 * grepping, CI dashboards) can filter on it without parsing reason codes.
 *
 * @type {string}
 */
export const WORKTREE_PATH_VIOLATION = 'WORKTREE_PATH_VIOLATION';

/**
 * Closed enum of violation reasons. Mirrors spec.md L269 contract. Callers
 * MUST use one of these literals — the audit-entry schema enforces the set.
 *
 * - symlink-component: any path segment of the target is a symlink.
 * - path-escape:       target canonicalizes outside the pinned root.
 * - env-mutation:      current CLAUDE_PROJECT_DIR canonicalizes to a
 *                      different root than the captured pin.
 * - case-fs-mismatch:  target differs from pin only by case on a
 *                      case-sensitive FS (Linux ext4); reserved for future
 *                      cross-FS workflows. Currently unused in-repo.
 *
 * @type {readonly string[]}
 */
export const WORKTREE_VIOLATION_REASONS = Object.freeze([
  'symlink-component',
  'path-escape',
  'env-mutation',
  'case-fs-mismatch',
]);

/**
 * Exit code used when enforcement rejects. Matches the
 * NFR-WORKTREE-CANON contract (spec.md L273). Consumers pass this to
 * `process.exit()` after emitting the error to stderr.
 *
 * @type {number}
 */
export const WORKTREE_VIOLATION_EXIT_CODE = 2;

/**
 * Path (relative to project root) where session state is stored. Reads only;
 * this module never writes session.json. The path is protected by
 * workflow-file-protection.mjs FULL_BLOCK so only session-checkpoint.mjs can
 * write it (sole-writer invariant).
 *
 * @type {string}
 */
const SESSION_JSON_RELPATH = `.claude${sep}context${sep}session.json`;

// =============================================================================
// Canonicalization
// =============================================================================

/**
 * Probe the host FS for case-sensitivity. Used to choose exact vs.
 * case-folded comparison when validating a target against the pin.
 *
 * Heuristic: `platform() === 'darwin'` implies HFS+/APFS which is
 * case-insensitive by default on consumer Macs. Linux ext4 is case-sensitive.
 * The spec's "auto-detect" strategy (probe with temp file) lives in as-005's
 * `autoDetectCaseFS()`; that result is cached in
 * `session.active_work.case_insensitive_fs`. When that field is present we
 * prefer it over the platform() inference — the fixture-populated value is
 * the authoritative session-start probe.
 *
 * @param {{ session?: object }} [options]
 * @returns {boolean} true iff the FS is case-insensitive.
 */
function isCaseInsensitiveFs(options = {}) {
  const cached = options?.session?.active_work?.case_insensitive_fs;
  if (typeof cached === 'boolean') return cached;
  return platform() === 'darwin';
}

/**
 * Canonicalize a filesystem path via `fs.realpathSync`. On ENOENT (target
 * doesn't exist yet — common for fresh writes), fall back to `path.resolve`
 * so the containment check still runs against the syntactic absolute form.
 * Symlink components in the canonicalized path are detected by comparing
 * realpath(target) with resolve(target): they diverge iff any ancestor is a
 * symlink.
 *
 * @param {string} target - Absolute or relative path.
 * @returns {{ canonical: string, hadSymlink: boolean }}
 */
export function canonicalizeWritePath(target) {
  const resolved = resolve(target);
  let canonical = resolved;
  let hadSymlink = false;
  try {
    canonical = realpathSync(resolved);
  } catch {
    // ENOENT — target doesn't exist yet (fresh write). Keep the syntactic
    // absolute form. Symlink detection is impossible for non-existent
    // targets; trust the ancestor canonicalization above the target basename.
    canonical = resolved;
  }
  // Detect symlink ancestors by comparing the realpath-resolved path with the
  // syntactic resolve. If realpath produced a different canonical form AND
  // that form does not share the resolve() prefix (string mismatch beyond
  // trivial trailing-sep), at least one ancestor segment was a symlink.
  if (canonical !== resolved) {
    hadSymlink = true;
  }
  return { canonical, hadSymlink };
}

// =============================================================================
// Pin lookup
// =============================================================================

/**
 * Read `session.active_work.project_dir_pin` from `.claude/context/session.json`.
 *
 * Returns `null` (meaning "legacy session — skip enforcement") when:
 *   - session.json does not exist
 *   - session.json is malformed (parse error)
 *   - session.json has no `active_work` field
 *   - session.json has `active_work` but no `project_dir_pin` field
 *   - `project_dir_pin` is not a non-empty string
 *
 * Callers MUST handle null by skipping enforcement (Task 4: legacy-session
 * guard). Never throw from this function — enforcement failures must not
 * propagate from the session-read path.
 *
 * @param {{ projectRoot?: string }} [options]
 * @returns {{ pin: string|null, session: object|null }}
 */
export function loadProjectDirPin(options = {}) {
  let projectRoot = options.projectRoot;
  if (!projectRoot) {
    try {
      projectRoot = getCanonicalProjectDir();
    } catch (err) {
      if (err instanceof CanonicalProjectDirError) {
        // Env var unresolved — cannot locate session.json; skip enforcement.
        return { pin: null, session: null };
      }
      throw err;
    }
  }
  const sessionPath = `${projectRoot}${sep}${SESSION_JSON_RELPATH}`;
  if (!existsSync(sessionPath)) {
    return { pin: null, session: null };
  }
  let parsed;
  try {
    const raw = readFileSync(sessionPath, 'utf-8');
    parsed = JSON.parse(raw);
  } catch {
    return { pin: null, session: null };
  }
  const pin = parsed?.active_work?.project_dir_pin;
  if (typeof pin !== 'string' || pin.length === 0) {
    return { pin: null, session: parsed };
  }
  return { pin, session: parsed };
}

// =============================================================================
// Containment check (AC8.1)
// =============================================================================

/**
 * Normalize a canonical path for comparison. On case-insensitive FS, lowercase
 * the whole string so `/foo/Bar` and `/foo/bar` compare equal (AC5.4 in as-005).
 * On case-sensitive FS, return unchanged.
 *
 * @param {string} canonical
 * @param {boolean} caseInsensitive
 * @returns {string}
 */
function normalizeForCompare(canonical, caseInsensitive) {
  return caseInsensitive ? canonical.toLowerCase() : canonical;
}

/**
 * Validate a canonicalized path is contained within the pin. Containment:
 *   canonical === pin OR canonical starts with `pin + sep`.
 *
 * Case-folded on case-insensitive FS (Darwin), exact match on Linux.
 *
 * @param {string} canonical - Target canonicalized by canonicalizeWritePath.
 * @param {string} pin       - Pinned root from session.active_work.project_dir_pin.
 * @param {{ session?: object }} [options]
 * @returns {boolean} true iff contained.
 */
function isContainedInPin(canonical, pin, options = {}) {
  const caseInsensitive = isCaseInsensitiveFs(options);
  const canonicalCmp = normalizeForCompare(canonical, caseInsensitive);
  const pinCmp = normalizeForCompare(pin, caseInsensitive);
  if (canonicalCmp === pinCmp) return true;
  if (canonicalCmp.startsWith(pinCmp + sep)) return true;
  return false;
}

/**
 * Check a write-target path for a worktree-path violation. Returns a
 * structured error-shape object on violation, or null on accept.
 *
 * Flow:
 *   1. Canonicalize target via fs.realpathSync (symlink-resolution).
 *   2. If any ancestor is a symlink → reason='symlink-component'.
 *   3. If canonical target is NOT contained in pin → reason='path-escape'.
 *   4. Otherwise return null (accept).
 *
 * Legacy-session guard: callers MUST pre-check `pin != null`. This function
 * DOES NOT guard — passing `pin = null` here is a programming error.
 *
 * @param {string} target - Write-target absolute path (or will be resolved).
 * @param {string} pin    - Pinned canonical root (must be non-null).
 * @param {{ session?: object }} [options]
 * @returns {{
 *   code: string,
 *   reason: string,
 *   attempted_path: string,
 *   pinned_root: string,
 *   exit_code: number
 * } | null}
 */
export function checkWorktreePathViolation(target, pin, options = {}) {
  if (typeof target !== 'string' || target.length === 0) return null;
  if (typeof pin !== 'string' || pin.length === 0) {
    throw new Error(
      'checkWorktreePathViolation called with null/empty pin — caller ' +
        'must legacy-guard via loadProjectDirPin() first.'
    );
  }

  // Delegation path: when as-005's worktree-canon library is available,
  // call validateAgainstPin and convert its thrown WorktreePathViolationError
  // into the contract-shape object expected by hook consumers.
  if (_canonMod && typeof _canonMod.validateAgainstPin === 'function') {
    try {
      _canonMod.validateAgainstPin(target, pin);
      return null;
    } catch (err) {
      if (err && err.code === _canonMod.WORKTREE_PATH_VIOLATION) {
        return {
          code: err.code,
          reason: err.reason,
          attempted_path: err.attempted_path,
          pinned_root: err.pinned_root,
          exit_code: err.exit_code != null ? err.exit_code : WORKTREE_VIOLATION_EXIT_CODE,
        };
      }
      // Non-violation errors (ENOENT on target etc.) → local fallback below.
    }
  }

  // Local fallback (as-005 absent or threw a non-violation error).
  const { canonical, hadSymlink } = canonicalizeWritePath(target);
  if (hadSymlink) {
    return {
      code: WORKTREE_PATH_VIOLATION,
      reason: 'symlink-component',
      attempted_path: target,
      pinned_root: pin,
      exit_code: WORKTREE_VIOLATION_EXIT_CODE,
    };
  }
  if (!isContainedInPin(canonical, pin, options)) {
    return {
      code: WORKTREE_PATH_VIOLATION,
      reason: 'path-escape',
      attempted_path: target,
      pinned_root: pin,
      exit_code: WORKTREE_VIOLATION_EXIT_CODE,
    };
  }
  return null;
}

// =============================================================================
// Env-parity check (AC8.2)
// =============================================================================

/**
 * Enforce that the current `CLAUDE_PROJECT_DIR` canonicalizes to the same
 * path as the captured pin. Throws a structured Error on mismatch; returns
 * normally on match or when legacy-guard triggers.
 *
 * Legacy-session guard: when `pin == null`, enforcement is skipped (returns
 * without throwing). Matches spec Task 4 requirement.
 *
 * When getCanonicalProjectDir() throws (env var unset or unresolved), we
 * treat this as env-mutation iff a pin exists — the session had a pin, but
 * the current env var is gone. Matches spec Edge Cases: "Unauthorized
 * mid-session env mutation rejected".
 *
 * @param {string|null} pin - Pinned canonical root, or null to skip.
 * @param {{ session?: object }} [options]
 * @throws {Error} with properties {code, reason, attempted_path, pinned_root, exit_code}
 *   when env differs from pin.
 */
export function enforceEnvParity(pin, options = {}) {
  if (pin === null || pin === undefined) return; // legacy guard

  // Delegation path: when as-005's library is available, re-throw its
  // WorktreePathViolationError directly — the contract shape (code, reason,
  // attempted_path, pinned_root, exit_code) is already consumer-ready and
  // preserves the canonical single-source-of-truth invariant.
  if (_canonMod && typeof _canonMod.enforceEnvParity === 'function') {
    try {
      _canonMod.enforceEnvParity(pin);
      return;
    } catch (err) {
      if (err && err.code === _canonMod.WORKTREE_PATH_VIOLATION) {
        throw err;
      }
      // Non-violation error: fall through to local implementation below so
      // we still get useful diagnostics.
    }
  }

  // Local fallback implementation (as-005 absent).
  let currentCanonical;
  try {
    currentCanonical = getCanonicalProjectDir();
  } catch (err) {
    if (err instanceof CanonicalProjectDirError) {
      // Env var absent or unresolved → treat as env-mutation if we had a pin.
      const violation = new Error(
        `WORKTREE_PATH_VIOLATION: CLAUDE_PROJECT_DIR ` +
          `unresolved (${err.code}) while session pin is set to ${pin}`
      );
      violation.code = WORKTREE_PATH_VIOLATION;
      violation.reason = 'env-mutation';
      violation.attempted_path = err?.context?.rawValue || '<unset>';
      violation.pinned_root = pin;
      violation.exit_code = WORKTREE_VIOLATION_EXIT_CODE;
      throw violation;
    }
    throw err;
  }
  const caseInsensitive = isCaseInsensitiveFs(options);
  const a = normalizeForCompare(currentCanonical, caseInsensitive);
  const b = normalizeForCompare(pin, caseInsensitive);
  if (a !== b) {
    const violation = new Error(
      `WORKTREE_PATH_VIOLATION: CLAUDE_PROJECT_DIR canonicalizes to ` +
        `${currentCanonical} which differs from session pin ${pin}`
    );
    violation.code = WORKTREE_PATH_VIOLATION;
    violation.reason = 'env-mutation';
    violation.attempted_path = currentCanonical;
    violation.pinned_root = pin;
    violation.exit_code = WORKTREE_VIOLATION_EXIT_CODE;
    throw violation;
  }
}

// =============================================================================
// Audit-log integration (Task 3)
// =============================================================================

/**
 * Append an audit entry on worktree-path rejection. Best-effort — never
 * throws. Enforcement is the primary obligation; audit is observability and
 * must not block the rejection path on its own failures.
 *
 * as-009 refactor (REQ-007 Task 2): delegates to the shared
 * `logWorktreeViolation` helper at `lib/worktree-canon-audit.mjs`. The
 * historical signature is preserved (positional `reason`, `payload`,
 * `options`) so existing callers continue to work byte-identically. The
 * helper centralizes the `appendAuditEntry('worktree_path_violation', …)`
 * shape so any schema drift is felt in a single source of truth.
 *
 * The audit-log infrastructure (pipeline-efficiency-audit-log.mjs) depends on
 * the genesis anchor at `.claude/audit/pipeline-efficiency-genesis.json`.
 * When the anchor is missing (test contexts, fresh installs), the appender
 * throws E_GENESIS_ANCHOR_MISSING — we swallow that failure silently via
 * the helper. The structured error emitted to stderr + exit 2 still
 * conveys the violation; audit is append-only observability of the same
 * event.
 *
 * @param {string} reason         - One of WORKTREE_VIOLATION_REASONS.
 * @param {object} payload        - Violation-specific fields (attempted_path, pinned_root, consumer, tool_name, ...).
 * @param {{ projectRoot?: string }} [options]
 * @returns {{ audited: boolean, seq?: number, error?: string }}
 */
export async function appendWorktreeAuditEntry(reason, payload, options = {}) {
  // Dynamic import of the shared helper mirrors the previous dynamic-import
  // pattern (the audit-log module lives in validation-scripts, not
  // scripts-lib). Works on bare clones where the helper / appender are
  // present; silently no-ops when either is absent.
  try {
    const { logWorktreeViolation } = await import('./worktree-canon-audit.mjs');
    const violation = {
      reason,
      attempted_path:
        payload && typeof payload.attempted_path === 'string'
          ? payload.attempted_path
          : '',
      pinned_root:
        payload && typeof payload.pinned_root === 'string'
          ? payload.pinned_root
          : '',
    };
    // Consumer label + extra payload (tool_name, session_id, etc.) pass
    // through the helper's extras channel so they land in the audit entry
    // without clobbering the canonical base fields.
    const consumer =
      payload && typeof payload.consumer === 'string' && payload.consumer.length > 0
        ? payload.consumer
        : 'worktree-enforcement.mjs';
    const extras = {};
    if (payload && typeof payload === 'object') {
      for (const [k, v] of Object.entries(payload)) {
        if (k !== 'attempted_path' && k !== 'pinned_root' && k !== 'consumer') {
          extras[k] = v;
        }
      }
    }
    const helperOpts = { consumer, extras };
    if (options.projectRoot) helperOpts.projectRoot = options.projectRoot;

    return await logWorktreeViolation(violation, helperOpts);
  } catch (err) {
    // Silent — audit-log unavailability MUST NOT block enforcement.
    return { audited: false, error: err?.message || String(err) };
  }
}

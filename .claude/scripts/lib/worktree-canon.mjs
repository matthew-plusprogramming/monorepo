/**
 * Worktree canonicalization + pin validation helper.
 *
 * Spec: sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-005 / REQ-007 /
 *       NFR-WORKTREE-CANON (MasterSpec §Contract Registry).
 *
 * Purpose
 * -------
 * Central library that enforces the worktree-absolute-path contract: every
 * consumer that resolves `CLAUDE_PROJECT_DIR` or a file-write target against
 * the pinned worktree root routes through this module. Primary security
 * boundary closing SEC-001 (symlink-escape, env-swap, case-FS false
 * equivalence, path-escape).
 *
 * Five exports + one error-code constant (per Interfaces & Contracts):
 *   - canonicalize(path)                 — realpath + symlink-component reject
 *   - validateAgainstPin(path, pin)      — pin containment + case-FS dispatch
 *   - autoDetectCaseFS()                 — probe case-insensitive FS (cached)
 *   - capturePin(envRoot)                — canonicalized pin at start-work
 *   - enforceEnvParity(pin)              — reject mid-session CLAUDE_PROJECT_DIR mutation
 *   - WORKTREE_PATH_VIOLATION            — error-code constant
 *
 * Structured error shape (per AC5.1–AC5.5):
 *   {
 *     code: "WORKTREE_PATH_VIOLATION",
 *     reason: "symlink-component" | "path-escape" | "env-mutation" | "case-fs-mismatch",
 *     attempted_path: string,
 *     pinned_root: string,
 *     exit_code: 2
 *   }
 *
 * Design notes
 * ------------
 * - `fs.realpath.native` resolves symlinks + canonicalizes `..`. We call it
 *   BEFORE the pin-containment check so a symlink that points inside the pin
 *   still trips the symlink-component reject.
 * - Symlink detection walks each path component via `lstatSync` and rejects
 *   when ANY segment is itself a symlink. `realpath` alone would silently
 *   follow the link — the contract demands explicit rejection per AC5.1.
 * - Case-FS probe runs once per process (in-memory memo). A consumer that
 *   wants per-session caching (e.g. session-checkpoint.mjs) stores the probe
 *   result in `session.active_work.case_insensitive_fs` separately; this
 *   library is pure and touches no session state per spec §Description.
 * - `validateAgainstPin` uses trailing-separator containment to defeat the
 *   `/foo/bar-evil/` prefix-collision attack (same pattern as path-containment.mjs).
 *
 * Acceptable Assumption Domains (per Self-Answer Protocol)
 * --------------------------------------------------------
 * - SELF-RESOLVED(code): session state access deferred to consumers per
 *   spec §Description. This file is pure.
 * - SELF-RESOLVED(memory-bank/best-practices/code-quality.md): structured
 *   error class with `code`, `reason`, `exit_code` attributes.
 */

import {
  lstatSync,
  realpathSync,
  mkdtempSync,
  writeFileSync,
  statSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve, sep as pathSep } from 'node:path';
import { tmpdir } from 'node:os';

// =============================================================================
// Constants (exported)
// =============================================================================

/**
 * Error-code constant emitted on every rejection (symlink-component,
 * path-escape, env-mutation, case-fs-mismatch). Consumers switch on `err.code`
 * without string comparison.
 */
export const WORKTREE_PATH_VIOLATION = 'WORKTREE_PATH_VIOLATION';

/**
 * Frozen enum of rejection reasons. Mirrors the structured-error contract
 * declared in spec §Interfaces & Contracts.
 */
export const WORKTREE_VIOLATION_REASONS = Object.freeze({
  SYMLINK_COMPONENT: 'symlink-component',
  PATH_ESCAPE: 'path-escape',
  ENV_MUTATION: 'env-mutation',
  CASE_FS_MISMATCH: 'case-fs-mismatch',
});

const EXIT_CODE_VIOLATION = 2;

// =============================================================================
// Error class
// =============================================================================

/**
 * Structured error raised by every reject path. Carries machine-readable
 * fields (`code`, `reason`, `attempted_path`, `pinned_root`, `exit_code`)
 * so hook consumers (workflow-gate-enforcement, workflow-file-protection)
 * can emit audit entries without string-parsing the message.
 */
export class WorktreePathViolationError extends Error {
  constructor({ reason, attempted_path, pinned_root, detail }) {
    const hint = detail ? ` (${detail})` : '';
    super(
      `worktree-canon: ${reason} — attempted ${attempted_path} against pin ${pinned_root}${hint}`,
    );
    this.name = 'WorktreePathViolationError';
    this.code = WORKTREE_PATH_VIOLATION;
    this.reason = reason;
    this.attempted_path = attempted_path;
    this.pinned_root = pinned_root;
    this.exit_code = EXIT_CODE_VIOLATION;
  }

  /**
   * Emit the contract-defined JSON shape. Hook consumers use this to serialize
   * the violation into the audit log.
   */
  toStructured() {
    return {
      code: this.code,
      reason: this.reason,
      attempted_path: this.attempted_path,
      pinned_root: this.pinned_root,
      exit_code: this.exit_code,
    };
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Walk every path component from leaf to root, running `lstatSync` on each.
 * If ANY component is a symbolic link, returns `true`. If the component does
 * not exist (ENOENT), treat as non-symlink and continue walking (callers may
 * validate non-existent write targets whose parent is on disk).
 *
 * Walking component-by-component is necessary because `realpath` silently
 * follows symlinks — we need an explicit signal that a symlink exists
 * anywhere in the chain.
 */
function anyComponentIsSymlink(absolutePath) {
  let cursor = absolutePath;
  // Defensive bound: no filesystem path on POSIX exceeds ~4096 segments.
  const MAX_COMPONENTS = 4096;
  for (let i = 0; i < MAX_COMPONENTS; i++) {
    try {
      const st = lstatSync(cursor);
      if (st.isSymbolicLink()) return true;
    } catch (err) {
      // ENOENT is fine — missing component is not a symlink. Surface other
      // errors so the caller sees permission issues explicitly.
      if (err && err.code !== 'ENOENT') throw err;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return false; // reached filesystem root
    cursor = parent;
  }
  return false;
}

/**
 * Strip trailing path separator (if present and not root) for reliable
 * prefix-comparison in `validateAgainstPin`.
 */
function stripTrailingSep(path) {
  if (path.length <= 1) return path;
  return path.endsWith(pathSep) ? path.slice(0, -1) : path;
}

// =============================================================================
// Case-insensitive FS detection (cached per process)
// =============================================================================

/**
 * In-process memo. The FS type does not change mid-session, and the probe
 * creates + deletes a real temp file — we cache to avoid repeated disk hits.
 * Consumers that want per-session persistence cache the result separately
 * in `session.active_work.case_insensitive_fs` (wired in as-015).
 */
let cachedCaseInsensitive = null;

/**
 * Probe whether the current filesystem is case-insensitive by creating a
 * lowercase temp file and statting the same path in uppercase. If both
 * resolve to the same inode, the FS is case-insensitive (Darwin APFS/HFS+).
 * On Linux ext4/xfs/btrfs the uppercase stat raises ENOENT → case-sensitive.
 *
 * Returns `boolean` — `true` if case-insensitive.
 *
 * AC5.4: required for case-folded comparison dispatch in `validateAgainstPin`.
 */
export function autoDetectCaseFS() {
  if (cachedCaseInsensitive !== null) return cachedCaseInsensitive;

  let probeDir;
  try {
    try {
      probeDir = mkdtempSync(`${tmpdir()}${pathSep}canon-probe-`);
    } catch (err) {
      // EACCES / EPERM on $TMPDIR → cannot probe at all. DO NOT cache the
      // transient permission failure (caller's next invocation under a
      // different umask / container config may succeed). Log a structured
      // warning and return `false` for this call only (stricter default).
      const code = err && err.code;
      process.stderr.write(
        JSON.stringify({
          level: 'warn',
          source: 'worktree-canon',
          reason: 'casefs_probe_mkdtemp_failed',
          details: {
            tmpdir: tmpdir(),
            error_code: code || 'UNKNOWN',
            error: err && err.message ? err.message : String(err),
          },
        }) + '\n'
      );
      return false;
    }

    const lowerPath = `${probeDir}${pathSep}casefs-probe`;
    const upperPath = `${probeDir}${pathSep}CASEFS-PROBE`;
    writeFileSync(lowerPath, '');

    let lowerInode, upperInode;
    try {
      lowerInode = statSync(lowerPath).ino;
    } catch (err) {
      // Cannot stat the file we just wrote — abnormal. Distinguish:
      //   - ENOENT: the FS silently refused our write (exotic mount, e.g.
      //     tmpfs noexec with quota) → stricter default, cache `false`.
      //   - EACCES / EPERM: transient permission problem → DO NOT cache;
      //     return `false` for this call only. Next invocation may
      //     succeed under a different process context.
      const code = err && err.code;
      if (code === 'EACCES' || code === 'EPERM') {
        process.stderr.write(
          JSON.stringify({
            level: 'warn',
            source: 'worktree-canon',
            reason: 'casefs_probe_stat_lower_permission',
            details: {
              probe_dir: probeDir,
              error_code: code,
              error: err.message,
            },
          }) + '\n'
        );
        return false;
      }
      cachedCaseInsensitive = false;
      return cachedCaseInsensitive;
    }

    try {
      upperInode = statSync(upperPath).ino;
    } catch (err) {
      // ENOENT on uppercase path → FS is case-sensitive (expected on Linux).
      // Cache `false` — this is an authoritative signal.
      // EACCES / EPERM → transient permission failure; DO NOT cache,
      // return `false` for this call only.
      const code = err && err.code;
      if (code === 'EACCES' || code === 'EPERM') {
        process.stderr.write(
          JSON.stringify({
            level: 'warn',
            source: 'worktree-canon',
            reason: 'casefs_probe_stat_upper_permission',
            details: {
              probe_dir: probeDir,
              error_code: code,
              error: err.message,
            },
          }) + '\n'
        );
        return false;
      }
      cachedCaseInsensitive = false;
      return cachedCaseInsensitive;
    }

    cachedCaseInsensitive = lowerInode === upperInode;
    return cachedCaseInsensitive;
  } finally {
    if (probeDir) {
      try {
        rmSync(probeDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/**
 * Test-only reset hook for the cached probe result. Vitest uses this to
 * simulate Darwin / Linux FS types independent of the host OS. NOT part
 * of the public contract; prefix `_` signals internal.
 */
export function _resetCaseFSCacheForTests(forcedValue = null) {
  cachedCaseInsensitive = forcedValue;
}

// =============================================================================
// Public API — canonicalize
// =============================================================================

/**
 * Canonicalize a path: resolve via `fs.realpath.native` and reject if any
 * component of the *original* path is a symbolic link.
 *
 * Throws WorktreePathViolationError(reason="symlink-component") per AC5.1.
 *
 * Non-existent paths (ENOENT from realpath) gracefully degrade to the
 * logically-resolved absolute path — preserves pin-containment semantics
 * for write targets whose parents exist but the target file does not yet
 * exist (legitimate write-before-create case). Structured-error contract
 * tests validate against hypothetical paths, and consumer hooks validate
 * write-target paths that have not been created yet.
 *
 * @param {string} path — absolute or relative path.
 * @returns {string} canonical absolute path.
 */
export function canonicalize(path) {
  if (typeof path !== 'string' || path.length === 0) {
    // Not a structured violation — input is malformed. Caller should
    // validate types upstream.
    throw new TypeError('worktree-canon.canonicalize: path must be non-empty string');
  }

  const absoluteInput = isAbsolute(path) ? path : resolve(path);

  // Symlink detection BEFORE realpath, so we can report the attempted path
  // rather than the post-resolution path.
  if (anyComponentIsSymlink(absoluteInput)) {
    throw new WorktreePathViolationError({
      reason: WORKTREE_VIOLATION_REASONS.SYMLINK_COMPONENT,
      attempted_path: absoluteInput,
      pinned_root: '',
      detail: 'one or more path components is a symbolic link',
    });
  }

  // realpath.native avoids Node.js-emulated resolution quirks (preserves
  // symlink-through rejection done above). ENOENT-tolerant: non-existent
  // paths return their logically-resolved absolute form (per JSDoc above).
  try {
    return realpathSync.native(absoluteInput);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return absoluteInput;
    }
    throw err;
  }
}

// =============================================================================
// Public API — validateAgainstPin
// =============================================================================

/**
 * Validate that `path` (once canonicalized) is contained within `pin`.
 * Containment rule (matches path-containment.mjs AC-17.1):
 *   canonical(path) === pin  OR  canonical(path).startsWith(pin + sep)
 *
 * On case-insensitive FS (autoDetectCaseFS → true), comparison is
 * case-folded (both sides lowercased). On case-sensitive FS, comparison
 * is byte-exact.
 *
 * Throws WorktreePathViolationError on:
 *   - reason=symlink-component (via canonicalize) — AC5.1
 *   - reason=path-escape when canonical target is outside pin — AC5.3
 *
 * Returns the canonicalized, pin-validated absolute path (success) —
 * satisfies AC5.2 (inside-pin accept) and AC5.4 (case-folded accept on
 * Darwin).
 *
 * @param {string} path — target path to validate
 * @param {string} pin  — pinned worktree root (expected already canonicalized)
 */
export function validateAgainstPin(path, pin) {
  // Legacy-session guard (as-008 Task 4): null/undefined pin → no-op.
  // workflow-file-protection.mjs runs on every Write, including sessions
  // predating as-006 pin capture. Absent (null/undefined) pin → skip
  // enforcement (zero-regression). Empty-string pin (`''`) remains a
  // TypeError (malformed input — as-005 baseline contract preserves
  // strict-input validation).
  if (pin === null || pin === undefined) {
    return path;
  }

  if (typeof pin !== 'string' || pin.length === 0) {
    throw new TypeError('worktree-canon.validateAgainstPin: pin must be non-empty string');
  }

  const canonicalTarget = canonicalize(path); // may throw symlink-component
  const normalizedPin = stripTrailingSep(pin);
  const caseInsensitive = autoDetectCaseFS();

  const cmpTarget = caseInsensitive ? canonicalTarget.toLowerCase() : canonicalTarget;
  const cmpPin = caseInsensitive ? normalizedPin.toLowerCase() : normalizedPin;

  if (cmpTarget === cmpPin) return canonicalTarget;
  if (cmpTarget.startsWith(cmpPin + pathSep)) return canonicalTarget;

  throw new WorktreePathViolationError({
    reason: WORKTREE_VIOLATION_REASONS.PATH_ESCAPE,
    attempted_path: canonicalTarget,
    pinned_root: normalizedPin,
    detail: 'canonical target lies outside pinned worktree root',
  });
}

// =============================================================================
// Public API — capturePin
// =============================================================================

/**
 * Canonicalize the provided env-root and return it for storage in
 * `session.active_work.project_dir_pin`. Called at `session-checkpoint.mjs
 * start-work` (wired in as-015).
 *
 * Symlink in the env-root itself rejects here — matches §Edge Cases
 * "Symlink in CLAUDE_PROJECT_DIR itself → reject at start-work with
 * actionable error".
 *
 * @param {string} envRoot — raw CLAUDE_PROJECT_DIR value
 * @returns {string} canonical pin suitable for later validateAgainstPin calls
 */
export function capturePin(envRoot) {
  if (typeof envRoot !== 'string' || envRoot.length === 0) {
    throw new TypeError('worktree-canon.capturePin: envRoot must be non-empty string');
  }
  // Reuses the same symlink-reject path as canonicalize — a symlinked
  // CLAUDE_PROJECT_DIR is unacceptable (admin must resolve the symlink
  // explicitly before start-work).
  return canonicalize(envRoot);
}

// =============================================================================
// Public API — enforceEnvParity
// =============================================================================

/**
 * Reject mid-session mutation of `CLAUDE_PROJECT_DIR`. Reads the current
 * env var, canonicalizes it, and compares against the stored `pin`. Throws
 * WorktreePathViolationError(reason="env-mutation") per AC5.5 on mismatch.
 *
 * Legitimate rotations are performed via
 * `session-checkpoint.mjs rotate-worktree` (as-015 Task 20), which
 * atomically re-invokes `capturePin`. Any other env change is rejected.
 *
 * @param {string} pin — canonical pin captured at start-work
 */
export function enforceEnvParity(pin) {
  // Legacy-session guard (as-008 Task 4): null/undefined pin → no-op.
  // workflow-dag.mjs phase-transition validators run on ALL session
  // lifecycle events, including legacy sessions predating as-006 pin
  // capture. Absent (null/undefined) pin → skip enforcement. Empty-string
  // pin (`''`) remains a TypeError (malformed input — as-005 baseline
  // contract preserves strict-input validation).
  if (pin === null || pin === undefined) {
    return;
  }

  if (typeof pin !== 'string' || pin.length === 0) {
    throw new TypeError('worktree-canon.enforceEnvParity: pin must be non-empty string');
  }

  const current = process.env.CLAUDE_PROJECT_DIR;
  if (typeof current !== 'string' || current.length === 0) {
    throw new WorktreePathViolationError({
      reason: WORKTREE_VIOLATION_REASONS.ENV_MUTATION,
      attempted_path: current ?? '',
      pinned_root: pin,
      detail: 'CLAUDE_PROJECT_DIR is unset mid-session',
    });
  }

  // Canonicalize the current env and compare (case-folded on case-insensitive FS).
  // Propagate symlink-component rejection from canonicalize if the env was
  // mutated to a symlinked path.
  const canonicalCurrent = canonicalize(current);
  const normalizedPin = stripTrailingSep(pin);
  const caseInsensitive = autoDetectCaseFS();

  const cmpCurrent = caseInsensitive ? canonicalCurrent.toLowerCase() : canonicalCurrent;
  const cmpPin = caseInsensitive ? normalizedPin.toLowerCase() : normalizedPin;

  if (cmpCurrent !== cmpPin) {
    throw new WorktreePathViolationError({
      reason: WORKTREE_VIOLATION_REASONS.ENV_MUTATION,
      attempted_path: canonicalCurrent,
      pinned_root: normalizedPin,
      detail: 'current CLAUDE_PROJECT_DIR canonicalizes differently from captured pin',
    });
  }
}

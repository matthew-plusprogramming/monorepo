#!/usr/bin/env node

/**
 * Shared path-validation helper (POSIX-only for this spec phase).
 *
 * Spec: sg-enforcement-layer-gaps, Task 5 / REQ-M1-010 / AC-1.5, AC-1.6.
 * Consumers:
 *   - .claude/scripts/validate-manifest.mjs (for `prd.file_path`)
 *   - .claude/scripts/session-checkpoint.mjs (for dispatch-subagent desc
 *     when path-like; for phase_checkpoint.path_fields)
 *   - .claude/scripts/migrate-manifest.mjs (reuse for defensive checks)
 *
 * POSIX-only rule set (Windows path syntax deliberately out of scope — see
 * OQ-8 resolution in spec.md and follow-up PRD for Windows support):
 *   1. Reject absolute paths (leading `/`). Manifest `file_path` values and
 *      dispatch descriptions are expected to be repo-relative.
 *   2. Reject any component that is `..` (parent-directory escape). Allowing
 *      `..` would let a crafted manifest reference files outside the project.
 *   3. Reject symlinks (via `fs.lstat`). A symlink target could point anywhere,
 *      defeating containment. Only regular files / directories are accepted.
 *   4. Reject empty strings (when `allowNull` is false/absent).
 *
 * The helper purposely does NOT attempt to enforce a project-root containment
 * check because not every call site has a resolved project root available; the
 * caller must combine this helper with `lib/path-containment.mjs` when a
 * cross-check against the project root is required.
 *
 * Return shape: `{ valid: boolean, reason?: string }`. On failure, `reason` is
 * a short machine-grep-friendly enum plus optional context. On success, only
 * `valid: true` is returned.
 */

import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * Reason codes emitted by validatePath. Exposed as a frozen enum so callers can
 * switch on specific failure modes (e.g., tests) without string comparison.
 * Each string is short, lowercase-hyphenated, grep-friendly, non-localized.
 */
export const PATH_REJECT_REASONS = Object.freeze({
  NULL_VALUE: 'null-value-without-allow-null',
  EMPTY_STRING: 'empty-string',
  NOT_A_STRING: 'not-a-string',
  ABSOLUTE_PATH: 'absolute-path',
  PARENT_TRAVERSAL: 'parent-traversal',
  SYMLINK: 'symlink',
});

/**
 * Validate a path string according to the POSIX ruleset described at the top
 * of this module.
 *
 * @param {unknown} candidate - The string to validate. Non-strings are rejected
 *   unless they are `null` and `allowNull` is true.
 * @param {{
 *   allowNull?: boolean,
 *   // If supplied, rule 3 (symlink rejection) is performed by running
 *   //   `lstatSync(<projectRoot>/<candidate>)` (host filesystem hit).
 *   // If omitted, rule 3 becomes a no-op (string-only validation). Keep the
 *   // `projectRoot`-less mode for unit tests that don't want to touch disk.
 *   projectRoot?: string,
 * }} [opts]
 * @returns {{ valid: boolean, reason?: string, detail?: string }}
 */
export function validatePath(candidate, opts = {}) {
  const { allowNull = false, projectRoot } = opts;

  if (candidate === null || candidate === undefined) {
    if (allowNull) return { valid: true };
    return { valid: false, reason: PATH_REJECT_REASONS.NULL_VALUE };
  }

  if (typeof candidate !== 'string') {
    return {
      valid: false,
      reason: PATH_REJECT_REASONS.NOT_A_STRING,
      detail: typeof candidate,
    };
  }

  if (candidate.length === 0) {
    return { valid: false, reason: PATH_REJECT_REASONS.EMPTY_STRING };
  }

  if (isAbsolute(candidate) || candidate.startsWith('/')) {
    return {
      valid: false,
      reason: PATH_REJECT_REASONS.ABSOLUTE_PATH,
      detail: candidate,
    };
  }

  // AC-1.5 parent-traversal rejection: split on both POSIX ('/') and Windows
  // ('\\') so that a mixed-separator path like `foo\\..\\bar` on a hosted
  // POSIX checker still rejects. POSIX-only scope prevents us from going
  // further on Windows-specific syntax (drive letters, UNC).
  const segments = candidate.split(/[/\\]/);
  if (segments.some((seg) => seg === '..')) {
    return {
      valid: false,
      reason: PATH_REJECT_REASONS.PARENT_TRAVERSAL,
      detail: candidate,
    };
  }

  // AC-1.5 symlink rejection (via fs.lstat). Only perform when projectRoot is
  // supplied; otherwise skip the disk hit. Missing file is NOT a validation
  // failure here — callers should handle "file does not exist" separately via
  // their own existsSync check (a manifest can legitimately reference a PRD
  // path that doesn't yet exist on-disk).
  if (projectRoot) {
    try {
      const absolute = joinPosix(projectRoot, candidate);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        return {
          valid: false,
          reason: PATH_REJECT_REASONS.SYMLINK,
          detail: candidate,
        };
      }
    } catch (err) {
      // ENOENT is fine — caller decides whether the path needs to exist.
      if (err && err.code !== 'ENOENT') {
        return {
          valid: false,
          reason: 'lstat-error',
          detail: String(err.code || err.message || err),
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Simple POSIX-style join that preserves the explicit "repo-relative" semantic.
 * We avoid `path.join` because it would silently normalize `..` segments, which
 * defeats the parent-traversal check (the check above already rejected them,
 * but defense-in-depth helps readability of the resulting absolute path).
 */
function joinPosix(root, relative) {
  if (root.endsWith('/')) return `${root}${relative}`;
  return `${root}/${relative}`;
}

/**
 * Convenience wrapper: throw on failure with a structured Error that includes
 * the reason code as an enumerable property, so structured-error-validator can
 * trace provenance.
 *
 * @param {unknown} candidate
 * @param {Parameters<typeof validatePath>[1]} [opts]
 * @param {string} [fieldName] - For error-message context.
 * @returns {string} - The original valid path (pass-through).
 */
export function assertValidPath(candidate, opts = {}, fieldName = 'path') {
  const result = validatePath(candidate, opts);
  if (!result.valid) {
    const err = new Error(
      `path-validate: rejected ${fieldName} (${result.reason}${result.detail ? `: ${result.detail}` : ''})`
    );
    // Attach structured properties for programmatic handling without string parsing.
    err.code = 'PATH_VALIDATE_REJECT';
    err.reason = result.reason;
    err.detail = result.detail;
    err.fieldName = fieldName;
    throw err;
  }
  return /** @type {string} */ (candidate);
}

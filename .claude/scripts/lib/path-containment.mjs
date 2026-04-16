/**
 * Path containment helper for the metaclaude registry sync.
 *
 * Provides a single function that resolves a target path via `realpath` (follows
 * symlinks, canonicalizes `..`) and verifies the result lies strictly within a
 * declared claude-root. Trailing separator is REQUIRED to defeat the
 * `/foo/.claude-evil/` prefix-collision attack where a naive `startsWith` check
 * would accept `.claude-evil` as a valid child of `.claude`.
 *
 * Spec: sg-sync-registry-gaps REQ-017, AC-17.1, AC-17.2, EC-12, EC-18.
 */

import { realpathSync } from 'node:fs';
import { sep as pathSep } from 'node:path';

/**
 * Error thrown when a resolved path escapes the declared claude-root.
 *
 * Carries machine-readable metadata compatible with the structured-violation
 * contract emitted by the three sync gates.
 */
export class PathEscapeError extends Error {
  constructor({ target, resolved, claudeRoot }) {
    super(
      `Path escape: ${target} resolved to ${resolved}, which is not contained in ${claudeRoot}`
    );
    this.name = 'PathEscapeError';
    this.code = 'PATH_ESCAPE';
    this.rule = 'path-escape';
    this.target = target;
    this.resolved = resolved;
    this.claudeRoot = claudeRoot;
  }
}

/**
 * Resolve a target path via realpath and verify it is contained within claudeRoot.
 *
 * Containment rule (AC-17.1):
 *   resolved === claudeRoot  OR  resolved.startsWith(claudeRoot + path.sep)
 *
 * The trailing-separator check defeats prefix collisions: `/foo/.claude-evil/x.mjs`
 * starts with `/foo/.claude` but NOT `/foo/.claude/`.
 *
 * @param {string} target - Absolute or relative path to check
 * @param {string} claudeRoot - Absolute path to the claude-root (e.g., repo/.claude)
 * @returns {string} The canonicalized realpath, guaranteed to be inside claudeRoot
 * @throws {PathEscapeError} If the resolved path escapes claudeRoot
 * @throws {Error} If realpath fails for other reasons (e.g., ENOENT -- caller handles)
 */
export function assertContainment(target, claudeRoot) {
  // Canonicalize both sides. Stripping any trailing separator on claudeRoot
  // ensures the equality check in the next step works regardless of whether the
  // caller passed '/foo/.claude' or '/foo/.claude/'.
  const normalizedRoot =
    claudeRoot.endsWith(pathSep) && claudeRoot.length > 1
      ? claudeRoot.slice(0, -1)
      : claudeRoot;

  // realpathSync throws ENOENT / EACCES / etc. -- let those propagate. Caller
  // (import-graph validator) distinguishes ENOENT from PathEscapeError.
  const resolved = realpathSync(target);

  if (resolved === normalizedRoot) return resolved;
  if (resolved.startsWith(normalizedRoot + pathSep)) return resolved;

  throw new PathEscapeError({
    target,
    resolved,
    claudeRoot: normalizedRoot,
  });
}

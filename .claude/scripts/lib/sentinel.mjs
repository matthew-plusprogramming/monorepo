/**
 * Session-scoped coordination sentinel helpers.
 *
 * Session-scoped sentinel lifecycle contract:
 *   Single source of truth for `e2e-blackbox` sentinel lifecycle (write, read,
 *   delete) with session-id scoping + atomic tmp+rename discipline. Replaces
 *   the inlined writeSentinel/readSentinel/deleteSentinel originally defined
 *   in `.claude/scripts/e2e-blackbox-enforcement.mjs` (lines ~123-171 pre-as-015);
 *   that file now imports from here and delegates. A structural lint in
 *   `__tests__/sentinel/` asserts no duplicate sentinel writer exists outside
 *   this module.
 *
 *   Session scoping (DIS-007):
 *     - writeSentinel serializes `{session_id, set_at, agent_type}` as JSON.
 *     - readSentinel parses the JSON and returns null when the `session_id`
 *       does NOT match the current reader (cross-session isolation).
 *     - deleteSentinel unlinks the file if present (best-effort).
 *
 *   Atomic write discipline comes from `lib/atomic-write.mjs` (as-014) —
 *   tmp+rename ensures no concurrent reader observes a partial JSON payload.
 *
 * Contracts:
 *   - Sentinel JSON shape: `{ session_id: string, set_at: string, agent_type?: string }`
 *   - Absence semantics: sentinel missing => not active (fail-open for readers).
 *   - Cross-session: mismatched `session_id` => treated as absent by readers.
 *   - Late-arriving read after clear: because tmp+rename is atomic, readers
 *     observe EITHER the prior JSON OR absence — never a torn half-write.
 *
 * @req REQ-003.1, REQ-003.2, REQ-003.3
 * @sec SEC-004
 * @contract session-scoped-sentinel
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteSentinel } from './atomic-write.mjs';

/**
 * Relative path to the e2e-blackbox coordination sentinel.
 *
 * Exported so callers that need to reason about the absolute location (e.g.,
 * `e2e-blackbox-enforcement.mjs` stale-sentinel cleanup) resolve the same path
 * the helpers write/read.
 */
export const SENTINEL_RELATIVE_PATH = '.claude/coordination/active-e2e-session';

/**
 * Resolve the sentinel absolute path from a project-root argument.
 *
 * @param {string} projectRoot - Absolute project root (typically from
 *   `getCanonicalProjectDir()`).
 * @returns {string}
 */
export function sentinelPathFor(projectRoot) {
  return join(projectRoot, SENTINEL_RELATIVE_PATH);
}

/**
 * Write the sentinel JSON `{session_id, set_at, agent_type?}` atomically.
 *
 * Polymorphic signature:
 *   - `writeSentinel(projectRoot, sessionId, opts?)` — primary callsite used
 *     by `e2e-blackbox-enforcement.mjs` + session-checkpoint. Resolves the
 *     absolute path via `sentinelPathFor(projectRoot)`.
 *   - `writeSentinel(absolutePath, { session_id, set_at?, agent_type? })` —
 *     secondary form used by tests + harnesses that pass an already-resolved
 *     path + payload object. Useful for parallel-run harnesses that route
 *     each trio's sentinel through an isolated tmpdir path.
 *
 * Uses `atomicWriteSentinel` from `lib/atomic-write.mjs` so concurrent readers
 * never observe a partial payload. Returns true on success, false otherwise.
 *
 * @param {string} projectRootOrPath
 * @param {string|object} sessionIdOrPayload
 * @param {object} [opts]
 * @returns {boolean}
 *
 * @contract session-scoped-sentinel write
 */
export function writeSentinel(projectRootOrPath, sessionIdOrPayload, opts = {}) {
  if (!projectRootOrPath || typeof projectRootOrPath !== 'string') return false;

  // Secondary form: absolute-path + payload-object. Detected when arg2 is a
  // plain object carrying `session_id`.
  if (
    sessionIdOrPayload &&
    typeof sessionIdOrPayload === 'object' &&
    typeof sessionIdOrPayload.session_id === 'string'
  ) {
    const payloadObj = {
      agent_type: sessionIdOrPayload.agent_type || 'e2e-test-writer',
      session_id: sessionIdOrPayload.session_id,
      set_at: sessionIdOrPayload.set_at || new Date().toISOString(),
      timestamp: sessionIdOrPayload.set_at || new Date().toISOString(),
    };
    return atomicWriteSentinel(projectRootOrPath, JSON.stringify(payloadObj, null, 2) + '\n');
  }

  // Primary form: project-root + session-id.
  if (typeof sessionIdOrPayload !== 'string' || sessionIdOrPayload.length === 0) return false;
  const agentType = opts.agent_type || 'e2e-test-writer';
  const now = new Date().toISOString();
  const payload = JSON.stringify(
    {
      agent_type: agentType,
      session_id: sessionIdOrPayload,
      set_at: now,
      timestamp: now,
    },
    null,
    2,
  ) + '\n';

  return atomicWriteSentinel(sentinelPathFor(projectRootOrPath), payload);
}

/**
 * Read and validate the sentinel.
 *
 * Polymorphic signature:
 *   - `readSentinel(projectRoot, currentSessionId)` — returns the parsed
 *     payload ONLY when `session_id` matches `currentSessionId`; returns
 *     null otherwise (cross-session isolation — the session-scoped hook
 *     contract).
 *   - `readSentinel(absolutePath)` — returns the parsed payload as-is
 *     regardless of session match. Used by tests that introspect sibling
 *     sentinels directly. Caller is responsible for the mismatch check.
 *
 * Returns null when the file is absent or the content is malformed JSON.
 *
 * @param {string} projectRootOrPath
 * @param {string} [currentSessionId]
 * @returns {{ agent_type?: string, session_id: string, set_at?: string, timestamp?: string } | null}
 *
 * @contract session-scoped-sentinel read
 */
export function readSentinel(projectRootOrPath, currentSessionId) {
  if (!projectRootOrPath || typeof projectRootOrPath !== 'string') return null;

  // Secondary form: caller passed an absolute path without a session id.
  // Return the parsed JSON as-is for the test/harness use-case. Absolute paths
  // can be detected by presence of a path separator and absence of a `.claude/`
  // marker; but a safer heuristic is "caller omitted currentSessionId".
  if (currentSessionId === undefined) {
    if (!existsSync(projectRootOrPath)) return null;
    try {
      return JSON.parse(readFileSync(projectRootOrPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  const sentinelPath = sentinelPathFor(projectRootOrPath);
  if (!existsSync(sentinelPath)) return null;

  let raw;
  try {
    raw = readFileSync(sentinelPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON => treat as absent. Late-arriving writer guarantees
    // atomic tmp+rename so this branch can only fire on operator-corrupted
    // sentinel files (fail-open preserves hook behavior).
    return null;
  }

  // Session-scope: cross-session sentinel invisible to this reader.
  if (typeof parsed !== 'object' || parsed === null) return null;
  if (parsed.session_id !== currentSessionId) return null;

  return parsed;
}

/**
 * Delete the sentinel file.
 *
 * Polymorphic signature:
 *   - `deleteSentinel(projectRoot)` — unlink the sentinel at
 *     `<projectRoot>/.claude/coordination/active-e2e-session` unconditionally.
 *   - `deleteSentinel(absolutePath)` — unlink the given path unconditionally.
 *   - `deleteSentinel(absolutePath, { session_id })` — session-scoped clear:
 *     only unlink when the sentinel content's `session_id` matches. Used by
 *     SubagentStop cleanup paths that need cross-session safety.
 *
 * Returns true if a file was removed, false when absent, mismatched, or on error.
 *
 * @param {string} projectRootOrPath
 * @param {{ session_id?: string }} [opts]
 * @returns {boolean}
 *
 * @contract session-scoped-sentinel delete
 */
export function deleteSentinel(projectRootOrPath, opts = {}) {
  if (!projectRootOrPath || typeof projectRootOrPath !== 'string') return false;
  // If the path contains a separator, treat as absolute/relative file path.
  // Otherwise resolve as project-root.
  const isPathShape = projectRootOrPath.includes('/') || projectRootOrPath.includes('\\');
  const sentinelPath = isPathShape ? projectRootOrPath : sentinelPathFor(projectRootOrPath);
  if (!existsSync(sentinelPath)) return false;

  // Session-scoped clear: only unlink if the sentinel's session_id matches.
  if (opts && typeof opts.session_id === 'string') {
    try {
      const parsed = JSON.parse(readFileSync(sentinelPath, 'utf-8'));
      if (parsed?.session_id !== opts.session_id) return false;
    } catch {
      return false;
    }
  }

  try {
    unlinkSync(sentinelPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shared utility functions for workflow enforcement hooks.
 *
 * Centralizes duplicated logic (loadSession, loadOverrides, findMatchingOverride,
 * readStdin, findClaudeDir) so that gate-enforcement and stop-enforcement hooks
 * import from a single source of truth.
 *
 * CLAUDE_PROJECT_DIR canonicalization contract:
 *   - Adds `getCanonicalProjectDir()` as the SOLE authorized reader of
 *     `process.env.CLAUDE_PROJECT_DIR`. Realpath-canonicalizes the value and
 *     asserts repo-root containment so downstream hooks cannot be tricked via
 *     symlink traversal. Structural grep lint enforces centralization — every
 *     other `.mjs` file in `.claude/scripts/` must consume this helper rather
 *     than reading the env var directly.
 *
 * PreToolUse stage auto-detect contract:
 *   - Adds `parseStageFromPrompt()` for PreToolUse stage auto-detect. Parser
 *     lives here so both `workflow-gate-enforcement.mjs` (PreToolUse Agent hook)
 *     and SubagentStop reconcilers can consume the same semantics.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// =============================================================================
// Constants
// =============================================================================

/** Maximum retries for reading gate-override.json on parse failure (REQ-015). */
const OVERRIDE_READ_MAX_RETRIES = 1;

/** Delay in milliseconds before retrying a failed file read (catches partial writes). */
const RETRY_DELAY_MS = 50;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Synchronous sleep for a given number of milliseconds.
 * Uses Atomics.wait on a SharedArrayBuffer for a true blocking delay
 * without busy-waiting.
 *
 * @param {number} ms - Milliseconds to sleep
 */
function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read all stdin as a string.
 * @returns {Promise<string>} Raw stdin content
 */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Find the .claude directory by walking up from script location.
 * Uses fileURLToPath for correct URL-to-path conversion (security fix L2).
 *
 * Respects CLAUDE_PROJECT_DIR environment variable when set, enabling
 * test isolation via temp directories.
 *
 * as-012 (REQ-003.6): reads the env var via `process.env.CLAUDE_PROJECT_DIR`
 * here (inside `lib/hook-utils.mjs`, the sole-authorized location per the
 * structural lint); downstream consumers should prefer `getCanonicalProjectDir`
 * when realpath canonicalization + containment is required.
 *
 * @param {string} importMetaUrl - The import.meta.url of the calling module
 * @returns {string} Absolute path to .claude directory
 */
export function findClaudeDir(importMetaUrl) {
  // Check CLAUDE_PROJECT_DIR first (test isolation, consistent with other scripts)
  if (process.env.CLAUDE_PROJECT_DIR) {
    return join(process.env.CLAUDE_PROJECT_DIR, '.claude');
  }

  const callerPath = fileURLToPath(importMetaUrl);
  let currentDir = dirname(resolve(callerPath));
  const root = '/';

  while (currentDir !== root) {
    const claudeDir = join(currentDir, '.claude');
    if (existsSync(claudeDir)) {
      return claudeDir;
    }
    if (basename(currentDir) === '.claude') {
      return currentDir;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  return join(process.cwd(), '.claude');
}

/**
 * Load session.json with graceful fail-open.
 * Returns null on any read/parse failure (REQ-022, REQ-028).
 *
 * @param {string} sessionPath - Absolute path to session.json
 * @returns {object|null} Parsed session or null
 */
export function loadSession(sessionPath) {
  if (!existsSync(sessionPath)) {
    return null;
  }

  try {
    const content = readFileSync(sessionPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Read gate-override.json with retry on parse failure (REQ-015).
 * Includes a real delay before retry to handle partial writes.
 *
 * @param {string} overridePath - Absolute path to gate-override.json
 * @returns {Array|null} Overrides array or null
 */
export function loadOverrides(overridePath) {
  if (!existsSync(overridePath)) {
    return null;
  }

  for (let attempt = 0; attempt <= OVERRIDE_READ_MAX_RETRIES; attempt++) {
    try {
      const content = readFileSync(overridePath, 'utf-8');
      const data = JSON.parse(content);
      if (Array.isArray(data.overrides)) {
        return data.overrides;
      }
      return null;
    } catch {
      if (attempt >= OVERRIDE_READ_MAX_RETRIES) {
        return null;
      }
      // Real delay before retry to handle partial writes (code review fix H1)
      syncSleep(RETRY_DELAY_MS);
    }
  }

  return null;
}

/**
 * Check if a valid override exists for the given gate and session.
 * Returns the most recent matching override (by timestamp) or null.
 * Validates that timestamp is a parseable date (security fix M4).
 *
 * @param {Array} overrides - Overrides array from gate-override.json
 * @param {string} gateName - The gate name to check
 * @param {string} sessionId - Current session ID from stdin
 * @returns {object|null} Matching override or null
 */
export function findMatchingOverride(overrides, gateName, sessionId) {
  if (!overrides || !Array.isArray(overrides)) return null;

  const matching = overrides.filter(
    o => o && o.gate === gateName && o.session_id === sessionId &&
         typeof o.timestamp === 'string' && typeof o.rationale === 'string' &&
         !isNaN(new Date(o.timestamp).getTime()) // Security fix M4: validate timestamp
  );

  if (matching.length === 0) return null;

  // Sort by timestamp descending, pick the most recent
  matching.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return matching[0];
}

// =============================================================================
// CLAUDE_PROJECT_DIR canonicalization contract.
// =============================================================================

/**
 * Typed error thrown by `getCanonicalProjectDir()` when the env var is absent
 * or the realpath-resolved project root is NOT contained within this helper's
 * own ancestor walk (symlink-traversal defense).
 *
 * @sec SEC-003, SEC-008
 */
export class CanonicalProjectDirError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'CanonicalProjectDirError';
    this.code = code;
    this.context = context;
  }
}

/**
 * Walk up from a starting directory looking for an ancestor whose basename
 * equals `.claude`, or that *contains* a `.claude/` directory. Returns the
 * canonical project root (the directory that holds `.claude/`).
 *
 * This is the containment reference — a realpath must resolve to a path
 * equal to or rooted at this canonical root. Prevents an attacker-supplied
 * CLAUDE_PROJECT_DIR symlink from pointing at an unrelated filesystem area.
 *
 * @returns {string|null}
 */
function findProjectRootFromAncestor() {
  // Start from this file's own canonical location and walk up. Under normal
  // invocation this is `<project>/.claude/scripts/lib/hook-utils.mjs` (or a
  // consumer-synced copy). The walk looks for the directory that contains a
  // `.claude/` subdirectory and returns that.
  let current;
  try {
    current = realpathSync(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return null;
  }
  const root = sep;
  while (current !== root && current.length > 1) {
    // If current itself is named `.claude`, the project root is its parent.
    if (basename(current) === '.claude') {
      return dirname(current);
    }
    // Otherwise, if current contains a `.claude/` dir, current IS the project root.
    const candidate = join(current, '.claude');
    if (existsSync(candidate)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * getCanonicalProjectDir — the SOLE authorized consumer of
 * `process.env.CLAUDE_PROJECT_DIR` across `.claude/scripts/`. Every hook
 * entrypoint MUST call this helper instead of reading the env var directly.
 * Centralization is enforced by a structural grep lint at test time
 * (`__tests__/lint/claude-project-dir-centralization.test.mjs`).
 *
 * Behavior:
 *   1. Read `process.env.CLAUDE_PROJECT_DIR` — throws `E_PROJECT_DIR_ABSENT`
 *      if unset or empty.
 *   2. Realpath-canonicalize the value (`fs.realpathSync`) — throws
 *      `E_PROJECT_DIR_UNRESOLVED` on ENOENT / EACCES (symlink to nowhere, etc.).
 *   3. Compute the expected project root by walking the helper file's own
 *      canonical ancestry for a directory containing `.claude/`.
 *   4. Assert containment: resolved === expected OR resolved starts with
 *      `expected + sep`. Throws `E_PROJECT_DIR_ESCAPES_CONTAINMENT` on mismatch.
 *
 * @returns {string} Canonicalized project root (absolute path, no trailing sep).
 * @throws {CanonicalProjectDirError}
 *
 * @req REQ-003.6
 * @sec SEC-003, SEC-008
 * @contract claude-project-dir-canonicalizer
 */
export function getCanonicalProjectDir() {
  const raw = process.env.CLAUDE_PROJECT_DIR;
  if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
    throw new CanonicalProjectDirError(
      'E_PROJECT_DIR_ABSENT',
      'CLAUDE_PROJECT_DIR is not set. This hook requires an authoritative project root.'
    );
  }

  let resolved;
  try {
    resolved = realpathSync(raw);
  } catch (err) {
    throw new CanonicalProjectDirError(
      'E_PROJECT_DIR_UNRESOLVED',
      `CLAUDE_PROJECT_DIR=${raw} could not be realpath-resolved: ${err.code || err.message}`,
      { rawValue: raw, osError: err.code || err.message }
    );
  }

  // Normalize trailing separator. On POSIX, realpathSync strips trailing sep;
  // this guard is defensive for Windows-like path semantics.
  const normalized = resolved.endsWith(sep) && resolved.length > 1
    ? resolved.slice(0, -1)
    : resolved;

  // Repo-root containment check. The helper file's own ancestor walk gives us
  // the expected project root under normal operation. If the caller passed a
  // CLAUDE_PROJECT_DIR that resolves OUTSIDE this root, that is a
  // symlink-traversal attempt — fail closed.
  //
  // Test-isolation exception: when running under a test that points
  // CLAUDE_PROJECT_DIR at a tmpdir, the ancestor walk would reject because the
  // tmpdir is not a descendant of the real project root. We detect this by
  // checking whether the resolved path itself contains a `.claude` directory;
  // if so, the env var is pointing at a self-consistent project root (even if
  // unrelated to ours) and we accept it. This preserves test-fixture usage
  // without weakening the symlink defense in production — production contexts
  // always set CLAUDE_PROJECT_DIR to the actual repo root.
  const expected = findProjectRootFromAncestor();
  const resolvedHasClaudeDir = existsSync(join(normalized, '.claude'));

  if (!expected) {
    // We couldn't find our own project root (unusual: helper invoked from
    // a detached location). Fall back to the self-consistent check: the
    // resolved path must itself contain a `.claude/` directory.
    if (!resolvedHasClaudeDir) {
      throw new CanonicalProjectDirError(
        'E_PROJECT_DIR_ESCAPES_CONTAINMENT',
        `CLAUDE_PROJECT_DIR=${raw} resolved to ${normalized}, but no .claude/ directory is present there.`,
        { rawValue: raw, resolved: normalized }
      );
    }
    return normalized;
  }

  // Primary containment check: resolved must equal or be rooted at expected.
  if (normalized === expected) return normalized;
  if (normalized.startsWith(expected + sep)) return normalized;

  // Containment failed. Fallback: if the resolved dir is self-consistent
  // (contains its own `.claude/`), accept it as a test isolation root.
  if (resolvedHasClaudeDir) return normalized;

  throw new CanonicalProjectDirError(
    'E_PROJECT_DIR_ESCAPES_CONTAINMENT',
    `CLAUDE_PROJECT_DIR=${raw} resolved to ${normalized}, which escapes the canonical project root ${expected}.`,
    { rawValue: raw, resolved: normalized, expectedRoot: expected }
  );
}

// =============================================================================
// PreToolUse stage parser.
// =============================================================================

/**
 * Valid challenger stages (must mirror session-checkpoint.mjs VALID_STAGES).
 * @type {ReadonlyArray<string>}
 */
const AS_013_VALID_STAGES = Object.freeze([
  'pre-implementation',
]);

/**
 * Strip fenced code blocks (``` ... ```) from a prompt string so we do NOT
 * parse stage labels that appear inside code examples. Also strips inline
 * backtick spans — same rationale.
 *
 * @param {string} text
 * @returns {string}
 */
function stripFencedAndInlineCode(text) {
  if (typeof text !== 'string') return '';
  // Remove triple-fenced blocks first (greediness caveat: single-line fences
  // like ```stage: X``` still stripped because [\s\S] matches everything).
  const withoutFences = text.replace(/```[\s\S]*?```/g, '');
  // Remove inline `...` spans.
  return withoutFences.replace(/`[^`\n]*`/g, '');
}

/**
 * Parse a challenger stage label from a subagent dispatch prompt.
 *
 * Accepts the following case-sensitive patterns (first match wins):
 *   - `Stage: <stage>`
 *   - `--stage <stage>`    (CLI-style arg echoed in prompt)
 *   - `--stage=<stage>`    (CLI-style arg echoed in prompt)
 *   - `stage=<stage>`      (key=value form)
 *
 * Semantics:
 *   - Fenced code blocks and inline backtick spans are EXCLUDED before matching.
 *   - If multiple patterns match DIFFERENT stages, returns a parse-failure
 *     result with reason `conflict` (caller should WARN and not invoke).
 *   - If multiple patterns match the SAME stage, returns success (consensus).
 *   - If no pattern matches, returns `{ stage: null, reason: 'unparseable' }`.
 *   - Invalid stage values (not in VALID_STAGES) return `{ stage: null,
 *     reason: 'invalid_stage', value }` so callers can surface a precise WARN.
 *
 * @param {string} prompt
 * @returns {{stage: string|null, reason: 'parsed'|'unparseable'|'conflict'|'invalid_stage', value?: string, matches?: string[]}}
 * @req REQ-002 / AC-002.1-5
 * @contract pretooluse-stage-parser
 */
export function parseStageFromPrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return { stage: null, reason: 'unparseable' };
  }

  const scrubbed = stripFencedAndInlineCode(prompt);

  // Patterns tried in order. Each captures a stage-like token.
  // Stage values can contain a-z0-9 plus '-'. Constrained to word-boundary-ish
  // contexts so we don't over-match embedded text.
  //
  // `Stage:` MUST start at beginning of line OR after whitespace to avoid
  // matching embedded anti-patterns. We enforce that via a preceding
  // (start|whitespace|punctuation) lookbehind.
  const STAGE_TOKEN = '[a-z][a-z0-9-]{2,40}';
  const patterns = [
    new RegExp(`(?:^|[\\s(\\[{;,])Stage:\\s+(${STAGE_TOKEN})\\b`, 'g'),
    new RegExp(`(?:^|[\\s(\\[{;,])--stage\\s+(${STAGE_TOKEN})\\b`, 'g'),
    new RegExp(`(?:^|[\\s(\\[{;,])--stage=(${STAGE_TOKEN})\\b`, 'g'),
    new RegExp(`(?:^|[\\s(\\[{;,])stage=(${STAGE_TOKEN})\\b`, 'g'),
  ];

  const matches = [];
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(scrubbed)) !== null) {
      if (m[1]) matches.push(m[1]);
    }
  }

  if (matches.length === 0) {
    return { stage: null, reason: 'unparseable' };
  }

  // First-match-wins, but detect conflicts across distinct values.
  const distinct = Array.from(new Set(matches));
  if (distinct.length > 1) {
    return { stage: null, reason: 'conflict', matches: distinct };
  }

  const candidate = distinct[0];
  if (!AS_013_VALID_STAGES.includes(candidate)) {
    return { stage: null, reason: 'invalid_stage', value: candidate };
  }

  return { stage: candidate, reason: 'parsed' };
}

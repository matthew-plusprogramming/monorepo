/**
 * Code constants for the metaclaude registry sync system.
 *
 * Per org-context convention "Code constants over registry metadata for security-relevant
 * values" (see spec §Security), these values are hard-coded in source instead of read
 * from the registry. The registry is the trust root -- reading security-relevant values
 * from it creates circular trust (tampering with the registry tampers with the check
 * that would detect tampering).
 *
 * Changes to these constants show up in `git diff` and require code review.
 *
 * Spec: sg-sync-registry-gaps REQ-010, REQ-011, REQ-012, REQ-013, REQ-026, AC-10.3,
 * AC-10.4, AC-11.2, AC-13.2, §5.4.1, §5.7.
 */

/**
 * Bundle inheritance chain, fully expanded (no transitive computation at runtime).
 *
 * Each key maps to its ANCESTOR list -- the bundles whose artifacts a bundle at that key
 * may import. The empty array for `minimal` is the explicit base case (AC-10.3): it
 * means "no ancestors", NOT "any bundle allowed". The closure check (AC-10.4) first
 * short-circuits when `importerBundle === importeeBundle`, then walks this array.
 *
 * To add a new bundle, edit this constant AND the registry's `bundles[]` section. The
 * closure check uses this constant exclusively -- it never reads `bundles[].extends`
 * from the registry.
 */
export const BUNDLE_INHERITANCE = Object.freeze({
  minimal: Object.freeze([]),
  'core-workflow': Object.freeze(['minimal']),
  'full-workflow': Object.freeze(['core-workflow', 'minimal']),
});

/**
 * Globs matched against file paths during orphan-detection. Matching files are
 * silently skipped (not flagged as orphans). Test files and fixtures are "leaves":
 * they may exist on disk without being registered, but no registered artifact may
 * import them (see AC-11.3 test-leaf-violation, enforced by the import-graph
 * validator rather than the orphan detector).
 *
 * Matches glob semantics:
 *   - `**` matches any number of path segments (including zero)
 *   - `*`  matches any characters except `/`
 *   - trailing `/**` matches the directory and everything beneath it
 */
export const WHITELIST_GLOBS = Object.freeze([
  '**/__tests__/**',
  '**/__fixtures__/**',
  '**/.gitkeep',
]);

/**
 * Sync-scoped roots. Files under these directories are expected to be either
 * registered in `artifacts[]`, listed in `orphans[]`, or matched by WHITELIST_GLOBS.
 * Anything else triggers the orphan rule.
 *
 * Paths are relative to the repo root (no leading slash).
 */
export const SYNC_SCOPED_ROOTS = Object.freeze([
  '.claude/scripts/',
  '.claude/agents/',
  '.claude/skills/',
  '.claude/templates/',
  '.claude/docs/',
  '.claude/memory-bank/',
  '.claude/hooks/',
  '.claude/specs/schema/',
]);

/**
 * Directories explicitly EXCLUDED from the orphan walk. Files under these roots are
 * ephemeral, session-local, or auto-generated and have no business being in the
 * registry.
 *
 * Paths are relative to the repo root (no leading slash).
 */
export const EXCLUDED_ROOTS = Object.freeze([
  '.claude/traces/',
  '.claude/locks/',
  '.claude/coordination/',
  '.claude/journal/',
  '.claude/specs/groups/',
  '.claude/specs/archive/',
  '.claude/prds/',
  '.claude/context/',
  '.claude/audit/',
  '.claude/scripts/archive/',
]);

/**
 * Threshold for the skip-gates overuse WARNING. If 5 or more `--skip-gates` invocations
 * appear in the audit log within the past 7 days, `compute-hashes --update` emits a
 * non-blocking WARNING listing the entries. The check is code-constant (AC-13.2) so a
 * compromised registry cannot raise the threshold to hide abuse.
 */
export const SKIP_GATES_OVERUSE_THRESHOLD = 5;

/**
 * Window over which the overuse threshold is measured (milliseconds).
 * 7 days = 7 * 24 * 60 * 60 * 1000.
 */
export const SKIP_GATES_OVERUSE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Minimum length for the `--skip-gates=<reason>` flag value. Shorter reasons (or
 * whitespace-only reasons) are rejected at CLI parse time (AC-12.1).
 */
export const SKIP_GATES_MIN_REASON_LENGTH = 10;

/**
 * Legacy-orphans backlog deadline. After this date, any `orphans[]` entry with
 * `reason: "legacy"` triggers a non-blocking WARNING (AC-6.3). This is a soft
 * reminder -- the entries must eventually be resolved (either by archiving the files
 * or replacing the legacy reason with a real justification).
 */
export const LEGACY_ORPHANS_DEADLINE = '2026-09-30';

/**
 * Performance budgets (REQ-021, REQ-021a). Used by the orphan detector and
 * import-graph validator for optional wall-clock measurement emitted at --verbose
 * level. No enforcement at runtime: the tests pin these budgets explicitly.
 */
export const ORPHAN_DETECTOR_BUDGET_MS = 2000;
export const IMPORT_GRAPH_VALIDATOR_BUDGET_MS = 5000;

/**
 * Closed enum of structured-violation rule names (AC-23.1).
 *
 * Extending this list requires updating all three gates AND the corresponding test
 * file in `.claude/scripts/__tests__/import-graph-validator.test.mjs` AC-23.1 test.
 */
export const VIOLATION_RULES = Object.freeze([
  'orphan',
  'import-unregistered',
  'cross-bundle-closure',
  'parse-error',
  'import-target-missing',
  'import-target-unresolvable',
  'legacy-orphans-inventory-missing',
  'provenance-invalid',
  'path-escape',
  'toctou-containment',
  'test-leaf-violation',
]);

/**
 * Deterministic registry serialization (AC-24.1, AC-24.2).
 *
 * Produces a string with alphabetized keys at every object level, 2-space indentation,
 * and a trailing newline. Two consecutive runs over the same data produce byte-identical
 * output (idempotent).
 *
 * @param {*} value - JSON-serializable value (registry object)
 * @returns {string} Deterministic JSON text
 */
export function sortedJsonStringify(value) {
  const sorted = sortKeysDeep(value);
  return JSON.stringify(sorted, null, 2) + '\n';
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Minimal glob matcher for WHITELIST_GLOBS. Supports `**` (any segments), `*` (any
 * characters in one segment), and literal path parts. Implemented inline instead of
 * pulling in a `glob`/`minimatch` runtime dependency.
 *
 * @param {string} filePath - Path to test (relative to repo root, posix separators)
 * @param {readonly string[]} patterns - Glob patterns
 * @returns {boolean} true if any pattern matches
 */
export function matchesAnyGlob(filePath, patterns) {
  for (const pattern of patterns) {
    if (globToRegex(pattern).test(filePath)) return true;
  }
  return false;
}

function globToRegex(pattern) {
  // Escape regex metacharacters except * and /
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**` matches any number of characters including `/`
        re += '.*';
        i += 2;
        // Consume an optional trailing slash so `/**/` and `/**` both work
        if (pattern[i] === '/') i += 1;
      } else {
        // Single `*` matches any character except `/`
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '/' || c === '.') {
      re += '\\' + c;
      i += 1;
    } else if ('+?()[]{}^$|\\'.includes(c)) {
      re += '\\' + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}

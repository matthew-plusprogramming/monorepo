/**
 * Atomic-spec filename-convention validator library.
 *
 * Spec: sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-013 / REQ-008 /
 *       AC13.1, AC13.2, AC13.3.
 *
 * Purpose
 * -------
 * Validates filenames under `<spec-group-dir>/atomic/*.md` against the three
 * canonical forms declared by MasterSpec Contract Registry §Atomic-Spec
 * Filename Convention, and enforces per-workstream (workstream_id, id)
 * uniqueness.
 *
 * AC coverage
 * -----------
 *   - AC13.1 — slug form `as-NNN-<slug>.md` → zero errors / zero warnings.
 *   - AC13.2 — plain `as-NNN.md` AND legacy `<ws-id>-as-NNN-<slug>.md` →
 *             zero errors / zero warnings. Filenames matching NONE of the
 *             three canonical forms (e.g., `foo-001.md`, `as-0001.md`,
 *             `as-01.md`) produce a blocking error.
 *   - AC13.3 — two files parsing to the same `(workstream_id, id)` tuple
 *             emit a blocking error (duplicate atomic-id within the
 *             workstream).
 *
 * Contract
 * --------
 * Primary entry point:
 *
 *     validateAtomicFilenames(specGroupDirAbsolute) → Promise<{
 *         errors:   StructuredFinding[],
 *         warnings: StructuredFinding[],
 *     }>
 *
 *   - `specGroupDirAbsolute` is an absolute filesystem path to the
 *     containing spec-group directory (e.g., `/path/to/sg-foo-ws3-bar`).
 *     The function lists `<specGroupDir>/atomic/*.md` and applies the
 *     per-filename and cross-filename checks.
 *   - Return shape: `{ errors, warnings }`. `warnings` is always `[]` in the
 *     current design — Investigation Pass 1 amendment inv-atomic-id-7f91e3
 *     removed the legacy-warning behaviour; all three canonical forms
 *     are accepted without warning. The field is preserved in the shape so
 *     future extensions (e.g., soft-deprecation notices) can emit warnings
 *     without breaking consumers.
 *   - Async because the filesystem adapter uses `fs/promises.readdir`. The
 *     pure inner function `validateAtomicFilenamesSync` is also exported
 *     for callers that already have the filename list in hand (e.g., the
 *     `/enforce` skill CLI wrapper).
 *
 * Design notes
 * ------------
 * - Filename parsing routes through `parseAtomicFilename(filename, specGroupDir)`
 *   from `.claude/scripts/lib/atomic-id-schema.mjs`. All three canonical
 *   forms (plain / slug / legacy ws-prefixed) are accepted without warning.
 * - The `specGroupDir` argument passed to `parseAtomicFilename` MUST be the
 *   basename only (e.g., `sg-foo-ws3-bar`) so the inference regex
 *   `/-ws(\d+)(?:-|$)/` can match. Absolute paths break inference. We take
 *   the basename here.
 * - Uniqueness scope = `(workstream_id, atomic_id)` tuple. Inside one
 *   spec-group dir all files share a single workstream_id (inferred from
 *   the dir) so duplicates collapse to duplicate atomic_id values.
 * - Structured finding shape (compatible with the test-writer contract):
 *     {
 *       severity: 'error' | 'warning',
 *       code: 'ATOMIC_FILENAME_VIOLATION',
 *       reason: 'malformed-filename' | 'duplicate-atomic-id-in-workstream',
 *       ...context-specific fields...
 *     }
 *   The test suite accepts either a `{ errors, warnings }` object OR an
 *   array of findings with `severity`; we return the object form for
 *   clarity.
 *
 * Acceptable Assumption Domains (per Self-Answer Protocol)
 * --------------------------------------------------------
 * - SELF-RESOLVED(spec §AC13.1-AC13.3): return shape follows the test
 *   contract declared at `__tests__/ws3-orchestrator-hygiene/as-013-enforce-filename-validator.test.mjs`
 *   lines 104-134 (either object form `{errors, warnings}` or array with
 *   `severity`; we return the object form).
 * - SELF-RESOLVED(code §validate-minimum-pruning-floor.mjs): structured
 *   finding shape (`code` + `reason` + context fields) follows the same
 *   convention used by `lib/minimum-pruning-floor.mjs`.
 */

import { readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { parseAtomicFilename } from './atomic-id-schema.mjs';

// =============================================================================
// Constants
// =============================================================================

export const ATOMIC_FILENAME_VIOLATION = 'ATOMIC_FILENAME_VIOLATION';

/**
 * Canonical-form strings emitted in error records so consumers can show the
 * user exactly what's accepted without reaching into the regex.
 */
export const CANONICAL_FILENAME_FORMS = Object.freeze([
  'as-NNN.md',
  'as-NNN-<slug>.md',
  '<ws-id>-as-NNN-<slug>.md',
]);

// =============================================================================
// Pure core
// =============================================================================

/**
 * Pure / synchronous core: validate a pre-read list of filenames against the
 * atomic-spec filename contract.
 *
 * Callers that already have the filename list (test harnesses, CLI wrappers)
 * can call this directly; the async `validateAtomicFilenames` wraps it with
 * a filesystem read.
 *
 * @param {{ specGroupDirBasename: string, filenames: string[] }} args
 * @returns {{
 *   errors:   Array<StructuredFinding>,
 *   warnings: Array<StructuredFinding>,
 * }}
 */
export function validateAtomicFilenamesSync({ specGroupDirBasename, filenames }) {
  /** @type {Array<StructuredFinding>} */
  const errors = [];
  /** @type {Array<StructuredFinding>} */
  const warnings = []; // Always empty in current design; preserved for shape stability.

  // Stable ordering so duplicate-cluster error ordering is deterministic.
  const sorted = [...filenames].sort();

  // Map of tuple-key -> list of {filename, parsed} for duplicate detection.
  /** @type {Map<string, Array<{ filename: string, parsed: object }>>} */
  const byTuple = new Map();

  for (const filename of sorted) {
    const parsed = parseAtomicFilename(filename, specGroupDirBasename);
    if (!parsed) {
      // AC13.2 — malformed filename (matches none of the three canonical forms).
      errors.push({
        severity: 'error',
        code: ATOMIC_FILENAME_VIOLATION,
        reason: 'malformed-filename',
        filename,
        expected: CANONICAL_FILENAME_FORMS.slice(),
      });
      continue;
    }
    const tupleKey = `${parsed.workstream_id ?? '<no-ws>'}::${parsed.id}`;
    const bucket = byTuple.get(tupleKey);
    if (bucket) {
      bucket.push({ filename, parsed });
    } else {
      byTuple.set(tupleKey, [{ filename, parsed }]);
    }
  }

  // AC13.3 — per-workstream ID uniqueness.
  for (const [tupleKey, bucket] of byTuple.entries()) {
    if (bucket.length > 1) {
      const first = bucket[0];
      errors.push({
        severity: 'error',
        code: ATOMIC_FILENAME_VIOLATION,
        reason: 'duplicate-atomic-id-in-workstream',
        workstream_id: first.parsed.workstream_id,
        atomic_id: first.parsed.id,
        tuple_key: tupleKey,
        filenames: bucket.map((b) => b.filename),
      });
    }
  }

  return { errors, warnings };
}

// =============================================================================
// Async entry point (filesystem adapter)
// =============================================================================

/**
 * Primary entry point: validate atomic-spec filenames under `<sgDir>/atomic/`.
 *
 * Contract (see test suite `__tests__/ws3-orchestrator-hygiene/as-013-enforce-filename-validator.test.mjs`):
 *
 *   - Accepts a single `specGroupDirAbsolute` argument (absolute filesystem
 *     path to the spec-group directory).
 *   - Reads `<sgDir>/atomic/*.md` (non-`.md` siblings are ignored so stray
 *     `.DS_Store` / `.gitkeep` do not produce false positives).
 *   - Passes the spec-group directory BASENAME to `parseAtomicFilename` so
 *     the workstream-inference regex can match on `-ws<N>-` infix.
 *   - Returns `{ errors, warnings }` (both arrays; warnings always empty).
 *
 * Throws if `<sgDir>/atomic/` does not exist — the `/enforce` skill
 * guarantees the directory exists via its own precondition check, so a
 * thrown error here indicates a broken invariant, not a user-facing issue.
 *
 * @param {string} specGroupDirAbsolute — absolute path to the spec-group dir
 * @returns {Promise<{
 *   errors:   Array<StructuredFinding>,
 *   warnings: Array<StructuredFinding>,
 * }>}
 */
export async function validateAtomicFilenames(specGroupDirAbsolute) {
  if (typeof specGroupDirAbsolute !== 'string' || !specGroupDirAbsolute) {
    throw new Error(
      'validateAtomicFilenames: specGroupDirAbsolute must be a non-empty string',
    );
  }
  const atomicDir = resolve(specGroupDirAbsolute, 'atomic');
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await readdir(atomicDir, { withFileTypes: true });
  } catch (err) {
    // Re-throw with a contextual message; callers decide whether to treat
    // "missing atomic/" as a hard error or ignore (the /enforce skill's
    // prerequisite check already asserts existence).
    const msg = err && err.code === 'ENOENT'
      ? `atomic/ directory not found under ${specGroupDirAbsolute}`
      : `failed to read ${atomicDir}: ${err?.message || err}`;
    throw new Error(msg);
  }

  const filenames = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name);

  return validateAtomicFilenamesSync({
    specGroupDirBasename: basename(specGroupDirAbsolute),
    filenames,
  });
}

// =============================================================================
// Default export (for test-writer's fallback path `mod.default`)
// =============================================================================

export default validateAtomicFilenames;

// =============================================================================
// Type shapes (JSDoc only)
// =============================================================================

/**
 * @typedef {Object} StructuredFinding
 * @property {'error' | 'warning'} severity
 * @property {string} code
 * @property {string} reason
 * @property {string} [filename]
 * @property {string[]} [filenames]
 * @property {string|null} [workstream_id]
 * @property {string} [atomic_id]
 * @property {string} [tuple_key]
 * @property {string[]} [expected]
 */

/**
 * Per-Gate Threshold Table -- Initial Content
 *
 * Canonical in-memory table of per-gate convergence thresholds, attestation
 * modes, and hash-input manifests. Validated at module-load (AC2.6);
 * invalid entries throw at import time so any downstream consumer failing to
 * import cannot silently degrade onto stale defaults.
 *
 * Seeding defaults (SC-1 Decision Table, via AC2.1..AC2.4):
 *
 *   Gate                      required_clean_passes  attestation_mode   hash_input_manifest
 *   -----------------------   ---------------------  -----------------  ------------------------------------
 *   unifier                   1                      content-hash       .claude/specs/groups/<id>/spec.md,
 *                                                                       requirements.md, manifest.json,
 *                                                                       spec-linked docs
 *   completion-verifier       1                      content-hash       manifest.json, registry content,
 *                                                                       trace files
 *   code-review               2                      content-hash       git-diff descriptor
 *   security                  2                      content-hash       git-diff descriptor
 *   investigation             2                      none               (rationale required)
 *   challenger-pre-impl       2                      none               (rationale required)
 *
 * Rationale for "none" gates (AC2.2): investigation and challenger gates
 * surface distinct findings per pass observed in evidence runs; attestation
 * by content hash would falsely equate two runs that uncovered different
 * issues. Pass counting alone is the intended clearance signal.
 *
 * Rationale for unifier/completion-verifier at 1 pass (REQ-001): these gates
 * are content-hashed; a second pass cannot uncover new information when the
 * inputs are byte-identical, so the redundant re-dispatch is waste.
 *
 * Rationale for code-review/security at 2 passes this ship (REQ-001 deferred):
 * per parent-prompt and spec.md §Phase A, this ship preserves 2 passes for
 * these two gates until content-hash attestation baselines are collected;
 * REQ-001 reduces them to 1 in a follow-up ship.
 *
 * Export contract: returns the frozen table; callers MUST treat the returned
 * value as read-only. `Object.freeze` applies to the top-level record only;
 * entries are also individually frozen via `freezeTable`.
 *
 * Implements: REQ-001, REQ-002
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning / as-002
 *   - AC2.1: table covers all 6 canonical gates.
 *   - AC2.2: investigation + challenger at 2/none + rationale.
 *   - AC2.3: unifier + completion-verifier at 1/content-hash; code-review
 *            + security at 2/content-hash (git-diff descriptor).
 *   - AC2.4: unifier + completion-verifier hash_input_manifest populated.
 *   - AC2.6: validation at module-load (throws on invalid).
 */

import { validatePerGateThresholdTable } from './schemas/per-gate-threshold-table.schema.mjs';

// =============================================================================
// Constants -- hash_input_manifest groupings (AC2.4)
// =============================================================================

/**
 * Unifier input manifest (AC2.4 runtime-resolvable form).
 * Entries are repo-root relative because recordPass() runs from the project
 * root. The <id> placeholder resolves to session.active_work.spec_group_id.
 *
 * @type {readonly string[]}
 */
const UNIFIER_HASH_INPUT_MANIFEST = Object.freeze([
  '.claude/specs/groups/<id>/spec.md',
  '.claude/specs/groups/<id>/requirements.md',
  '.claude/specs/groups/<id>/manifest.json',
]);

/**
 * Completion-verifier input manifest (AC2.4 verbatim).
 *
 * @type {readonly string[]}
 */
const COMPLETION_VERIFIER_HASH_INPUT_MANIFEST = Object.freeze([
  'manifest.json',
  'registry content',
  'trace files',
]);

/**
 * Code-review / security input manifest (AC2.3: "git-diff descriptor pending
 * baseline evidence"). Represented as a single descriptor entry that the
 * attestation logic (as-018..as-020) will expand to the concrete diff range
 * against the branch base. Kept as a string descriptor so shape-lint does not
 * flag an empty array.
 *
 * @type {readonly string[]}
 */
const GIT_DIFF_HASH_INPUT_MANIFEST = Object.freeze([
  'git-diff:<branch-base>..HEAD',
]);

/**
 * Rationale for attestation_mode: "none" gates (AC2.2).
 *
 * @type {string}
 */
const FINDINGS_VARIANCE_RATIONALE =
  'distinct findings per pass observed in evidence runs';

// =============================================================================
// Table Content (AC2.1..AC2.4)
// =============================================================================

/**
 * Raw table content -- validated below at module load.
 * Not exported directly; consumers import `PerGateThresholdTable`.
 */
const RAW_TABLE = {
  unifier: {
    required_clean_passes: 1,
    attestation_mode: 'content-hash',
    hash_input_manifest: [...UNIFIER_HASH_INPUT_MANIFEST],
  },
  'code-review': {
    required_clean_passes: 2,
    attestation_mode: 'content-hash',
    hash_input_manifest: [...GIT_DIFF_HASH_INPUT_MANIFEST],
  },
  security: {
    required_clean_passes: 2,
    attestation_mode: 'content-hash',
    hash_input_manifest: [...GIT_DIFF_HASH_INPUT_MANIFEST],
  },
  'completion-verifier': {
    required_clean_passes: 1,
    attestation_mode: 'content-hash',
    hash_input_manifest: [...COMPLETION_VERIFIER_HASH_INPUT_MANIFEST],
  },
  investigation: {
    required_clean_passes: 2,
    attestation_mode: 'none',
    hash_input_manifest: [],
    rationale: FINDINGS_VARIANCE_RATIONALE,
  },
  'challenger-pre-impl': {
    required_clean_passes: 2,
    attestation_mode: 'none',
    hash_input_manifest: [],
    rationale: FINDINGS_VARIANCE_RATIONALE,
  },
};

// =============================================================================
// Validation + Freeze
// =============================================================================

/**
 * Deep-freeze a validated table: freeze each entry and its
 * `hash_input_manifest` array, then freeze the top-level record.
 *
 * The validator strips unknown keys and returns a plain object; we freeze the
 * returned value in place (it is a fresh object not shared with callers of
 * `validatePerGateThresholdTable`).
 *
 * @param {Record<string, { required_clean_passes: number, attestation_mode: string, hash_input_manifest: string[], rationale?: string }>} table
 * @returns {Readonly<typeof table>}
 */
function freezeTable(table) {
  for (const entry of Object.values(table)) {
    Object.freeze(entry.hash_input_manifest);
    Object.freeze(entry);
  }
  return Object.freeze(table);
}

/**
 * Validate RAW_TABLE at module-load (AC2.6). Any schema violation -- invalid
 * attestation_mode, missing rationale for mode "none", non-integer pass count
 * -- throws before any consumer can read the export.
 */
const VALIDATED_TABLE = validatePerGateThresholdTable(RAW_TABLE);

/**
 * Canonical per-gate threshold table (AC2.1, AC2.5).
 *
 * Frozen at module-load. Downstream readers obtain this value by importing
 * it from `workflow-dag.mjs` (which re-exports it) or directly from this
 * module (as-005 SessionThresholdSnapshot capture).
 *
 * @type {Readonly<Record<string, Readonly<{ required_clean_passes: number, attestation_mode: "content-hash" | "timestamp" | "none", hash_input_manifest: readonly string[], rationale?: string }>>>}
 */
export const PerGateThresholdTable = freezeTable(VALIDATED_TABLE);

// =============================================================================
// Named gate constants (for consumer ergonomics -- optional)
// =============================================================================

/**
 * Frozen list of canonical gate names in the initial table.
 * Exported for consumers that iterate (e.g., SessionThresholdSnapshot build).
 *
 * @type {readonly string[]}
 */
export const PER_GATE_THRESHOLD_TABLE_GATES = Object.freeze([
  'unifier',
  'code-review',
  'security',
  'completion-verifier',
  'investigation',
  'challenger-pre-impl',
]);

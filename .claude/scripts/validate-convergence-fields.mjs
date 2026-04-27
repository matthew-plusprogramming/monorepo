#!/usr/bin/env node

/**
 * Validate convergence fields in manifest.json files.
 *
 * Checks that all keys in the `convergence` object are canonical field names.
 * Provides suggestions for common aliases/misspellings.
 *
 * Ported from ai-eng-dashboard with adaptations:
 * - Blocks on non-canonical fields (exit 1)
 * - Extended alias map per spec Non-Canonical Alias Map table
 * - traceability_complete maps to unifier_passed (DEC-003)
 * - test_coverage flagged as not-a-gate
 * - No hardcoded project-specific paths
 *
 * Usage:
 *   node validate-convergence-fields.mjs <manifest.json>
 *
 * Exit codes:
 *   0 - Valid (no convergence, empty convergence, all fields canonical)
 *   1 - Error (missing args, file not found, parse error, or non-canonical fields found)
 *   2 - WORKTREE_PATH_VIOLATION (env-parity mismatch with pin; as-021)
 *
 * as-021 / REQ-007 / AC21.1–AC21.4: worktree-canon env-parity enforced on
 * invocation. A mutated `CLAUDE_PROJECT_DIR` must not silently validate a
 * manifest in the wrong worktree root — the check fails loudly with
 * `WORKTREE_PATH_VIOLATION` + exit 2 before the canonical-field scan runs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 11 fields: 9 gate-result fields
// plus 2 convergence process fields (investigation_converged, challenger_converged) that
// track multi-pass loop state.
// During the manual-test migration window, BOTH `browser_tests_passed` (the
// legacy name used by in-flight manifests) and `manual_tests_passed` (the new
// canonical name going forward) are accepted as valid top-level convergence keys.
// REQ-009-b prohibits bulk-renaming the in-flight manifests; they resolve
// opportunistically on next touch. The ALIASES map handles misspellings of either
// name (e.g. `browser_tested` -> `manual_tests_passed`).
const CANONICAL_FIELDS = new Set([
  'spec_complete',
  'investigation_converged',
  'challenger_converged',
  'all_acs_implemented',
  'all_tests_passing',
  'unifier_passed',
  'code_review_passed',
  'security_review_passed',
  'browser_tests_passed', // legacy; kept valid during migration window (REQ-009-b)
  'manual_tests_passed',
  'docs_generated',
  'completion_verification_passed',
]);

// AC2.4: 20+ known non-canonical variants with alias suggestions
// Merged from ai-eng-dashboard source and spec Non-Canonical Alias Map table
const ALIASES = {
  // -> investigation_converged
  investigation_complete: 'investigation_converged',
  investigation_passed: 'investigation_converged',

  // -> challenger_converged
  challenger_complete: 'challenger_converged',
  challenger_passed: 'challenger_converged',

  // -> all_acs_implemented
  implemented: 'all_acs_implemented',
  implementation_complete: 'all_acs_implemented',
  impl_complete: 'all_acs_implemented',
  implementation_aligned: 'all_acs_implemented',
  all_acs_verified: 'all_acs_implemented',
  all_acs_complete: 'all_acs_implemented',
  acs_implemented: 'all_acs_implemented',

  // -> all_tests_passing
  tested: 'all_tests_passing',
  tests_passing: 'all_tests_passing',
  tests_complete: 'all_tests_passing',
  test_complete: 'all_tests_passing',
  all_tests_written: 'all_tests_passing',

  // -> unifier_passed (DEC-003: traceability_complete maps here)
  traceability_complete: 'unifier_passed',
  unified: 'unifier_passed',
  unify_passed: 'unifier_passed',
  unification_complete: 'unifier_passed',
  unifier_complete: 'unifier_passed',

  // -> code_review_passed
  code_reviewed: 'code_review_passed',
  code_review_complete: 'code_review_passed',
  review_complete: 'code_review_passed',
  reviewed: 'code_review_passed',

  // -> security_review_passed
  security_reviewed: 'security_review_passed',
  security_review_complete: 'security_review_passed',

  // -> manual_tests_passed (canonical after the manual-test migration)
  // Legacy alias entries — repointed from browser_tests_passed to manual_tests_passed.
  // The old canonical name browser_tests_passed itself remains a valid top-level field
  // (see CANONICAL_FIELDS) during the REQ-009-b migration window.
  browser_tested: 'manual_tests_passed',
  browser_test_passed: 'manual_tests_passed',
  browser_test_complete: 'manual_tests_passed',

  // -> docs_generated
  documentation_complete: 'docs_generated',
  docs_complete: 'docs_generated',
  documented: 'docs_generated',

  // -> completion_verification_passed
  completion_verified: 'completion_verification_passed',
  completion_gates_passed: 'completion_verification_passed',
  completion_check_passed: 'completion_verification_passed',
  post_completion_passed: 'completion_verification_passed',
};

// Special case: test_coverage is not a convergence gate
const NOT_A_GATE = new Set([
  'test_coverage',
]);

/**
 * Snapshot-absent fallback threshold (AC9.4). Matches CLAUDE.md convergence
 * loop protocol default of 2 consecutive clean passes. Consumed only when
 * `session.active_work.threshold_snapshot` is missing (pre-as-005 sessions,
 * session.json absent, or malformed JSON).
 *
 * Implements: REQ-012 (snapshot reader pattern) per
 * sg-pipeline-efficiency-ws1-convergence-pruning/as-009. Contract source:
 * spec.md §Contract: threshold-reader superset.
 */
const DEFAULT_REQUIRED_CLEAN_PASSES = 2;

/**
 * Mapping from manifest convergence boolean field name -> snapshot threshold
 * gate key. Covers only the fields that correspond to convergence-loop gates
 * with a per-gate entry in `lib/per-gate-threshold-table.mjs`. Other fields
 * (e.g. `spec_complete`, `all_acs_implemented`, `docs_generated`) are
 * non-loop convergence markers and have no threshold entry; they are
 * intentionally omitted from this map.
 */
const FIELD_TO_THRESHOLD_GATE = {
  unifier_passed: 'unifier',
  code_review_passed: 'code-review',
  security_review_passed: 'security',
  completion_verification_passed: 'completion-verifier',
  investigation_converged: 'investigation',
  challenger_converged: 'challenger-pre-impl',
};

/**
 * Read per-gate `required_clean_passes` from the session snapshot, falling
 * back to DEFAULT_REQUIRED_CLEAN_PASSES when the snapshot or the per-gate
 * entry is absent.
 *
 * Snapshot path: `session.active_work.threshold_snapshot.per_gate[gate]`.
 * Shape (from as-005 / lib/snapshot-capture.mjs):
 *   per_gate: { [gate_name]: { required_clean_passes, captured_at } }
 *
 * Deferred-consumer note: upgrade to the NFR-WORKTREE-CANON canon helper
 * lands in ws-3 as-021 (see as-009 Deferred consumer obligation section).
 *
 * @param {object | null} session - Loaded session object (or null).
 * @param {string} thresholdGate - Gate key in the snapshot's per_gate map.
 * @returns {number} required_clean_passes for the gate.
 */
function readThresholdFromSnapshot(session, thresholdGate) {
  const perGate = session?.active_work?.threshold_snapshot?.per_gate;
  const entry = perGate?.[thresholdGate];
  if (entry && typeof entry.required_clean_passes === 'number') {
    return entry.required_clean_passes;
  }
  return DEFAULT_REQUIRED_CLEAN_PASSES;
}

/**
 * Load session.json. Resolution order:
 *   1. `CLAUDE_PROJECT_DIR` env var → `<root>/.claude/context/session.json`.
 *      Consistent with `findClaudeDir` (lib/hook-utils.mjs:81-85) — enables
 *      test isolation via per-fixture temp directories.
 *   2. Script-relative fallback: `<scriptDir>/../context/session.json`.
 *      Preserves legacy behavior when env var is unset.
 *
 * Returns null on any error (absent, unreadable, malformed). Graceful
 * degradation preserves AC9.3 (error-message shape unchanged); consumers
 * fall back to the default threshold when null.
 *
 * as-021 / REQ-007: env-aware path so `enforceWorktreeCanonEnvParity` sees
 * the fixture's session during subprocess tests (matches the pattern that
 * workflow-gate-enforcement.mjs uses via `findClaudeDir`).
 *
 * @returns {object | null}
 */
function loadSessionSnapshot() {
  try {
    let sessionPath;
    // as-021 canon-helper note: this env read feeds `enforceEnvParity(pin)`
    // below (session loaded here → pin extracted → canonicalize + validate).
    // The raw env read is authorized at this sole session-root location per
    // the worktree-canon integration contract (as-005 / as-007 pattern).
    if (process.env.CLAUDE_PROJECT_DIR) {
      sessionPath = join(
        // Read feeds worktree-canon enforceEnvParity path below.
        process.env.CLAUDE_PROJECT_DIR,
        '.claude',
        'context',
        'session.json',
      );
    } else {
      const scriptDir = dirname(fileURLToPath(import.meta.url));
      // Script path: .claude/scripts/validate-convergence-fields.mjs
      // Session path: .claude/context/session.json
      sessionPath = join(scriptDir, '..', 'context', 'session.json');
    }
    if (!existsSync(sessionPath)) {
      return null;
    }
    return JSON.parse(readFileSync(sessionPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * as-021 / REQ-007 / AC21.1–AC21.3: Worktree-canon env-parity check.
 *
 * Pattern mirrors workflow-gate-enforcement.mjs (as-007 wiring): dynamic
 * import of the as-005 canon library + shared audit shim. On violation:
 * emit structured stderr + append `worktree_path_violation` audit entry +
 * exit 2. Legacy-session guard: pin absent → no-op.
 *
 * Called before the canonical-field scan so a mutated `CLAUDE_PROJECT_DIR`
 * cannot silently validate a manifest in the wrong worktree root.
 */
async function enforceWorktreeCanonEnvParity(session) {
  const projectDirPin = session?.active_work?.project_dir_pin;
  if (!projectDirPin || typeof projectDirPin !== 'string' || projectDirPin.length === 0) {
    return; // legacy-session guard: pin absent → skip enforcement
  }
  try {
    const canonMod = await import('./lib/worktree-canon.mjs');
    canonMod.enforceEnvParity(projectDirPin);
    return;
  } catch (canonErr) {
    const isMissingModule =
      canonErr &&
      (canonErr.code === 'ERR_MODULE_NOT_FOUND' ||
        /Cannot find module/.test(String(canonErr.message || '')));
    if (isMissingModule) {
      process.stderr.write(
        '[validate-convergence-fields] worktree-canon module absent -- env-parity check skipped\n'
      );
      return;
    }
    // Violation path — shape matches NFR-WORKTREE-CANON contract.
    const reason = canonErr.reason || 'unknown';
    // as-021 canon-lock: worktree-canon enforceEnvParity already rejected;
    // the process.env read below is strictly for the violation message.
    const attemptedPath =
      canonErr.attempted_path || process.env.CLAUDE_PROJECT_DIR || '<unset>';
    const code = canonErr.code || 'WORKTREE_PATH_VIOLATION';

    try {
      const { appendWorktreeAuditEntry } = await import(
        './lib/worktree-enforcement.mjs'
      );
      const result = await appendWorktreeAuditEntry(reason, {
        attempted_path: attemptedPath,
        pinned_root: projectDirPin,
        consumer: 'validate-convergence-fields',
        hook: 'validate-convergence-fields',
      });
      if (!result || result.audited !== true) {
        process.stderr.write(
          `[validate-convergence-fields] WARNING: audit-append failed for WORKTREE_PATH_VIOLATION: ${result && result.error}\n`
        );
      }
    } catch (auditErr) {
      process.stderr.write(
        `[validate-convergence-fields] WARNING: audit-append failed for WORKTREE_PATH_VIOLATION: ${auditErr && auditErr.message}\n`
      );
    }

    process.stderr.write('\n');
    process.stderr.write('========================================\n');
    process.stderr.write('BLOCKED: WORKTREE_PATH_VIOLATION\n');
    process.stderr.write('========================================\n');
    process.stderr.write('\n');
    process.stderr.write(`code:           ${code}\n`);
    process.stderr.write(`reason:         ${reason}\n`);
    process.stderr.write(`attempted_path: ${attemptedPath}\n`);
    process.stderr.write(`pinned_root:    ${projectDirPin}\n`);
    process.stderr.write('\n');
    process.stderr.write(
      'CLAUDE_PROJECT_DIR does not canonicalize to session.active_work.project_dir_pin.\n'
    );
    process.stderr.write(
      'Resolve by restoring the pinned CLAUDE_PROJECT_DIR, or re-pin via:\n'
    );
    process.stderr.write(
      '  node .claude/scripts/session-checkpoint.mjs rotate-worktree <new-root>\n'
    );
    process.stderr.write('\n');
    process.stderr.write('========================================\n');
    process.stderr.write('\n');
    process.exit(2);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: validate-convergence-fields.mjs <manifest.json>');
    // Missing required argument is an error
    process.exit(1);
  }

  const filePath = resolve(args[0]);

  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    // Missing file is an error
    process.exit(1);
  }

  // as-021 / AC21.1–AC21.3: env-parity check BEFORE any manifest inspection.
  // Session load is best-effort (loadSessionSnapshot returns null on absence /
  // malformed JSON). When the session has a pin AND env mismatches, this
  // exits 2 internally before control returns.
  const sessionForCanon = loadSessionSnapshot();
  await enforceWorktreeCanonEnvParity(sessionForCanon);

  let data;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error(`Invalid JSON in ${filePath}: ${err.message}`);
    // Parse error is an error
    process.exit(1);
  }

  // When manifest has no convergence object, nothing to validate
  if (!data.convergence || typeof data.convergence !== 'object') {
    process.exit(0);
  }

  // Inspect convergence object keys
  const nonCanonical = [];

  for (const key of Object.keys(data.convergence)) {
    if (!CANONICAL_FIELDS.has(key)) {
      nonCanonical.push(key);
    }
  }

  // All fields canonical or empty convergence - valid
  if (nonCanonical.length === 0) {
    process.exit(0);
  }

  // Warn with message suggesting the canonical alternative
  // AC9.3: pre-existing error-message shape preserved verbatim; snapshot
  // threshold info is appended only after the canonical-fields list so the
  // primary diagnostic lines tested by validate-convergence-fields-alias.test
  // remain byte-identical.
  console.error(`ERROR: Non-canonical convergence fields in ${filePath}`);
  console.error('');

  for (const field of nonCanonical) {
    if (NOT_A_GATE.has(field)) {
      console.error(`  "${field}" -> Not a convergence gate. Remove from convergence object.`);
    } else {
      const suggestion = ALIASES[field];
      if (suggestion) {
        console.error(`  "${field}" -> Did you mean "${suggestion}"?`);
      } else {
        console.error(`  "${field}" -> Unknown convergence field -- remove or use a canonical name.`);
      }
    }
  }

  console.error('');
  console.error('Canonical convergence fields:');

  // as-009 AC9.1: read required_clean_passes from session snapshot for gates
  // that participate in a convergence loop. Fallback to
  // DEFAULT_REQUIRED_CLEAN_PASSES when snapshot absent (AC9.4). Threshold is
  // surfaced as a diagnostic suffix only -- canonical-field enumeration order
  // and the exit code (1) are unchanged (AC9.3).
  //
  // as-021: reuse the earlier `sessionForCanon` load rather than double-reading.
  const session = sessionForCanon;
  for (const field of CANONICAL_FIELDS) {
    const thresholdGate = FIELD_TO_THRESHOLD_GATE[field];
    if (thresholdGate) {
      const required = readThresholdFromSnapshot(session, thresholdGate);
      console.error(`  - ${field} (gate '${thresholdGate}', required_clean_passes=${required})`);
    } else {
      console.error(`  - ${field}`);
    }
  }

  // Exit 1 to block the edit until fixed
  process.exit(1);
}

main().catch((err) => {
  // as-021: defense-in-depth fail-open on async-path unexpected errors.
  // The env-parity violation branch calls process.exit(2) inline; this catch
  // only fires for unexpected awaited-promise rejections.
  process.stderr.write(`Error in validate-convergence-fields: ${err && err.message}\n`);
  process.exit(1);
});

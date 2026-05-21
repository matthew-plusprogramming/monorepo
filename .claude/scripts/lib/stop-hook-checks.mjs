/**
 * Stop Hook Checks — Shared Pure-Function Library
 *
 * Single source of truth for the five completion-invariant checks invoked by
 * both `workflow-stop-enforcement.mjs` (coercive Stop gate) and
 * `session-checkpoint.mjs verify`.
 *
 * Import footprint:
 *   Keep this module independent of `session-checkpoint.mjs`,
 *   `workflow-stop-enforcement.mjs`, `atomic-write.mjs`, and unrelated
 *   `lib/*.mjs` modules to avoid circular dependencies in hook execution.
 *
 * Purity:
 *   - All functions are side-effect-free (no fs writes, no process.exit,
 *     no console output).
 *   - `checkArtifactInventory` calls `existsSync` (read-only, idempotent
 *     against a stable directory snapshot); still considered pure
 *     at the granularity of a single hook/CLI run.
 *   - Functions may throw `TypeError` on structurally invalid input (e.g.,
 *     `session` is null). Callers catch and map to fail-open.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  REQUIRED_CHALLENGER_STAGES,
  VALID_CONVERGENCE_GATES,
  REQUIRED_CLEAN_PASSES,
  getPredecessorGraph,
  wasPredecessorVisited,
  getWorkflowTypeStrict,
  isExemptWorkflow,
  getAllTasks,
} from './workflow-dag.mjs';
// =============================================================================
// Constants
// =============================================================================

/**
 * Regex matching a valid spec group id.
 * Must match the SEC-001 regex used in workflow-stop-enforcement.mjs.
 */
const SPEC_GROUP_ID_RE = /^sg-[a-z0-9.-]+$/;

/**
 * Strict-mode complete phase name.
 * shouldRunChecks uses strict equality against this value.
 */
const PHASE_COMPLETE = 'complete';

/**
 * Gate pair mapping for convergence-field sanity checks.
 * Each entry: [session convergence key, manifest convergence key].
 */
const GATE_PAIRS = [
  ['code_review', 'code_review_passed'],
  ['security_review', 'security_review_passed'],
  ['investigation', 'investigation_converged'],
  ['challenger', 'challenger_converged'],
  ['unifier', 'unifier_passed'],
  ['completion_verifier', 'completion_verification_passed'],
];

/**
 * Artifact files required at completion for oneoff-spec workflows.
 * Paths are relative to the spec group directory.
 */
const ONEOFF_SPEC_REQUIRED_ARTIFACTS = [
  'investigation-report.md',
  'unify-report.md',
  'docs/COVERAGE.md',
];

// =============================================================================
// Guard
// =============================================================================

/**
 * Precondition guard for the five completion-invariant checks.
 *
 * Returns true iff ALL THREE conditions hold:
 *   (a) session.active_work.spec_group_id is set AND matches /^sg-[a-z0-9.-]+$/,
 *   (b) session.active_work.current_phase === 'complete' (strict equality),
 *   (c) getWorkflowTypeStrict(session) returns a non-exempt workflow.
 *
 * When false, callers SHALL skip all five completion-invariant checks (existing dispatch/
 * obligation guards continue per their pre-existing behavior).
 *
 * Closes chk-primitives-d4e7b128.
 *
 * @param {object} session - Parsed session.json (may be null/undefined)
 * @returns {boolean}
 */
export function shouldRunChecks(session) {
  if (!session || typeof session !== 'object') return false;
  const activeWork = session.active_work;
  if (!activeWork || typeof activeWork !== 'object') return false;

  // (a) spec_group_id present and format-valid
  const specGroupId = activeWork.spec_group_id;
  if (typeof specGroupId !== 'string' || !SPEC_GROUP_ID_RE.test(specGroupId)) {
    return false;
  }

  // (b) current_phase === 'complete' via strict equality
  if (activeWork.current_phase !== PHASE_COMPLETE) return false;

  // (c) workflow non-exempt
  const workflow = getWorkflowTypeStrict(session);
  if (!workflow || isExemptWorkflow(workflow)) return false;

  return true;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Normalize clean_pass_count to a number.
 * Treats missing/non-number values as 0 (fail-closed).
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeCleanPassCount(value) {
  return typeof value === 'number' ? value : 0;
}

/**
 * Collect challenger dispatch stages from session task arrays.
 * Reads from both `in_flight` and `completed_this_session`.
 *
 * @param {object} session
 * @returns {Set<string>} Set of stage strings observed.
 */
function collectChallengerStages(session) {
  const stages = new Set();
  const tasks = getAllTasks(session);
  for (const task of tasks) {
    if (task && task.subagent_type === 'challenger' && typeof task.stage === 'string') {
      stages.add(task.stage);
    }
  }
  return stages;
}

/**
 * Build the set of visited phase keys from session.history.
 * Includes both phase_transition events (details.to_phase) and override_skip
 * events (details.phase).
 *
 * @param {object} session
 * @returns {{ visitedPlain: Set<string>, overriddenPlain: Set<string> }}
 */
function collectPhaseEvidence(session) {
  const visitedPlain = new Set();
  const overriddenPlain = new Set();
  const history = Array.isArray(session?.history) ? session.history : [];

  for (const entry of history) {
    if (!entry || typeof entry !== 'object') continue;
    const eventType = entry.event_type;
    const details = entry.details;
    if (!details || typeof details !== 'object') continue;

    if (eventType === 'phase_transition' && typeof details.to_phase === 'string') {
      visitedPlain.add(details.to_phase);
    } else if (eventType === 'override_skip' && typeof details.phase === 'string') {
      overriddenPlain.add(details.phase);
    }
  }

  return { visitedPlain, overriddenPlain };
}

/**
 * Collect all predecessor keys reachable in the supplied predecessor graph.
 * Returns an ordered array of keys; duplicates removed. `complete` is a
 * terminal node never present in the graph itself, so every graph key (and
 * every referenced parent) is a predecessor candidate — no filtering needed.
 *
 * @param {Record<string, string[]>} graph
 * @returns {string[]}
 */
function collectAllPredecessors(graph) {
  const visited = new Set();
  const ordered = [];
  const queue = [];

  for (const key of Object.keys(graph)) {
    queue.push(key);
  }

  while (queue.length > 0) {
    const key = queue.shift();
    if (visited.has(key)) continue;
    visited.add(key);
    ordered.push(key);

    const parents = graph[key] || [];
    for (const parent of parents) {
      if (!visited.has(parent)) {
        queue.push(parent);
      }
    }
  }

  return ordered;
}

// =============================================================================
// Check 1: Convergence Depth
// =============================================================================

/**
 * Verify every convergence gate has clean_pass_count >= REQUIRED_CLEAN_PASSES (2).
 *
 * Missing/non-number clean_pass_count values are normalized to 0 via the
 * `typeof` guard, which is strictly tighter than `?? 0` to reject
 * coerced-string bypass under data corruption.
 *
 * The `manifest` parameter is accepted for signature symmetry with
 * `checkConvergenceFieldSanity` and to allow future cross-source verification
 * without a breaking signature change. It is not currently read.
 *
 * @param {object} session - Parsed session.json
 * @param {object|null} _manifest - Parsed manifest.json (unused, signature symmetry only)
 * @returns {{passed: boolean, failures: Array<{gate: string, observed: number, required: number}>}}
 */
export function checkConvergenceDepth(session, _manifest) {
  const failures = [];
  const convergence = session?.convergence || {};

  for (const gate of VALID_CONVERGENCE_GATES) {
    const gateRecord = convergence[gate];
    const observed = normalizeCleanPassCount(gateRecord?.clean_pass_count);
    if (observed < REQUIRED_CLEAN_PASSES) {
      failures.push({
        gate,
        observed,
        required: REQUIRED_CLEAN_PASSES,
      });
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

// =============================================================================
// Check 2: Challenger Stage Coverage
// =============================================================================

/**
 * Verify every required challenger stage for the workflow has a dispatch record.
 *
 * Stage set comes from REQUIRED_CHALLENGER_STAGES[workflow] — authoritative
 * source from workflow-dag.mjs.
 *
 * An override_skip history event with `details.phase === 'challenging:<stage>'`
 * satisfies the requirement for that stage.
 *
 * @param {object} session
 * @param {string} workflow
 * @returns {{passed: boolean, failures: Array<{stage: string, workflow: string}>}}
 */
export function checkChallengerStages(session, workflow) {
  const requiredStages = REQUIRED_CHALLENGER_STAGES[workflow];
  if (!requiredStages || requiredStages.length === 0) {
    return { passed: true, failures: [] };
  }

  const dispatchedStages = collectChallengerStages(session);
  const { overriddenPlain } = collectPhaseEvidence(session);

  const failures = [];
  for (const stage of requiredStages) {
    if (dispatchedStages.has(stage)) continue;
    // Honor override-skip events with parameterized key `challenging:<stage>`
    if (overriddenPlain.has(`challenging:${stage}`)) continue;
    failures.push({ stage, workflow });
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

// =============================================================================
// Check 3: Phase DAG Predecessor Completeness
// =============================================================================

/**
 * Verify every mandatory predecessor of `complete` (transitively) appears in
 * session.history as either a phase_transition event or a matching
 * override_skip event.
 *
 * Failures carry a `finding_type` enum distinguishing:
 *   - 'phase_not_visited': history exists and is non-empty but a specific
 *     predecessor_key was not observed.
 *   - 'history_missing': session.history is absent or empty (length === 0);
 *     a SINGLE failure is emitted (not per-predecessor) because no transition
 *     evidence exists at all.
 *   - 'clean': reserved for internal use when passed === true (not populated
 *     in failures[]).
 *
 * @param {object} session
 * @param {string} workflow
 * @returns {{passed: boolean, failures: Array<{finding_type: string, details: object}>}}
 */
export function checkPhaseDagPredecessors(session, workflow) {
  const graph = getPredecessorGraph(workflow);
  if (!graph) {
    // Exempt workflow — no predecessors to check.
    return { passed: true, failures: [] };
  }

  const history = Array.isArray(session?.history) ? session.history : [];

  // If history is entirely empty (no transitions ever), emit a SINGLE
  // history_missing failure rather than one-per-predecessor.
  if (history.length === 0) {
    return {
      passed: false,
      failures: [
        {
          finding_type: 'history_missing',
          details: {
            reason: 'no_history',
            history_length: 0,
          },
        },
      ],
    };
  }

  const { overriddenPlain } = collectPhaseEvidence(session);
  const failures = [];
  const predecessors = collectAllPredecessors(graph);

  for (const predKey of predecessors) {
    if (wasPredecessorVisited(predKey, session)) continue;
    // Honor override-skip for both plain phase names and parameterized keys.
    if (overriddenPlain.has(predKey)) continue;
    failures.push({
      finding_type: 'phase_not_visited',
      details: {
        predecessor_key: predKey,
        reason: 'not_visited',
      },
    });
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

// =============================================================================
// Check 4: Artifact Inventory
// =============================================================================

/**
 * Verify the spec group directory contains the workflow-specific required
 * artifact set.
 *
 * For spec work: investigation-report.md, unify-report.md, docs/COVERAGE.md.
 *
 * Precondition: caller MUST validate `specGroupDir` path format against
 * `/^sg-[a-z0-9.-]+$/` before invoking (SEC-001 parity).
 *
 * Nonexistent `specGroupDir` does NOT throw. Returns a single failure with
 * `reason: 'spec_group_missing'`. Caller classifies this as structural
 * (Fail-Open case 1) and typically skips the block decision.
 *
 * @param {string} specGroupDir - Absolute path to spec group directory
 * @param {string} workflow
 * @returns {{passed: boolean, failures: Array<{file: string, reason: string}>}}
 */
export function checkArtifactInventory(specGroupDir, workflow) {
  // Pre-flight: spec group directory must exist.
  if (!existsSync(specGroupDir)) {
    return {
      passed: false,
      failures: [
        {
          file: specGroupDir,
          reason: 'spec_group_missing',
        },
      ],
    };
  }

  const failures = [];

  // Required files for all spec-based workflows.
  for (const relPath of ONEOFF_SPEC_REQUIRED_ARTIFACTS) {
    const abs = join(specGroupDir, relPath);
    if (!existsSync(abs)) {
      failures.push({ file: relPath, reason: 'missing' });
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

// =============================================================================
// Check 5: Convergence-Field Sanity
// =============================================================================

/**
 * Verify `manifest.convergence.<gate>_passed` and
 * `session.convergence[gate].clean_pass_count >= 2` agree for every gate pair.
 *
 * Manifest-side uses strict `=== true` equality (NOT truthiness); any
 * non-boolean value is treated as `false` per the workflow-dag.mjs
 * `validateObligations` strict-equality pattern.
 *
 * Session-side applies the same typeof guard before the `>= 2` comparison.
 *
 * Disagreement between the two sides emits a failure naming the gate pair AND
 * both observed values (raw manifest for debugging; normalized session count
 * for decision evidence).
 *
 * @param {object} session
 * @param {object|null} manifest - Parsed manifest.json (null -> pass, fail-open)
 * @returns {{passed: boolean, failures: Array<{gate_pair: string, manifest_value: unknown, session_count: number}>}}
 */
export function checkConvergenceFieldSanity(session, manifest) {
  // Fail-open when manifest is not available — this is a structural condition
  // that callers already handle via their fail-open path.
  if (!manifest || typeof manifest !== 'object') {
    return { passed: true, failures: [] };
  }

  const manifestConvergence = (manifest.convergence && typeof manifest.convergence === 'object')
    ? manifest.convergence
    : {};
  const sessionConvergence = (session?.convergence && typeof session.convergence === 'object')
    ? session.convergence
    : {};

  const failures = [];

  for (const [sessionKey, manifestKey] of GATE_PAIRS) {
    const manifestValue = manifestConvergence[manifestKey];
    const manifestConverged = manifestValue === true; // strict equality
    const sessionCount = normalizeCleanPassCount(sessionConvergence[sessionKey]?.clean_pass_count);
    const sessionConverged = sessionCount >= REQUIRED_CLEAN_PASSES;

    if (manifestConverged !== sessionConverged) {
      failures.push({
        gate_pair: `${sessionKey}/${manifestKey}`,
        manifest_value: manifestValue,
        session_count: sessionCount,
      });
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

// =============================================================================
// Failure formatters (shared between Stop hook and CLI `verify` subcommand)
// =============================================================================
//
// Each helper accepts a failure record (from the corresponding check) plus an
// optional `prefix` string. Callers that render a multi-reason block (the Stop
// hook) pass "  - " to get indented dash-prefixed lines; callers that render
// individual inline lines (the verify CLI) omit the prefix.
//
// Second-argument `specGroupDir` on formatArtifactInventoryFailure is the
// absolute path used to construct actionable "missing under <dir>" messages.

/**
 * @param {{gate: string, observed: number, required: number}} f
 * @param {string} [prefix='']
 * @returns {string}
 */
export function formatConvergenceDepthFailure(f, prefix = '') {
  return `${prefix}${f.gate}: clean_pass_count=${f.observed} (required ${f.required})`;
}

/**
 * @param {{stage: string, workflow: string}} f
 * @param {string} [prefix='']
 * @returns {string}
 */
export function formatChallengerStagesFailure(f, prefix = '') {
  return `${prefix}missing challenger stage: ${f.stage} (workflow: ${f.workflow})`;
}

/**
 * @param {{finding_type: string, details?: {predecessor_key?: string}}} f
 * @param {string} [prefix='']
 * @returns {string}
 */
export function formatPhaseDagFailure(f, prefix = '') {
  if (f.finding_type === 'history_missing') {
    return `${prefix}no phase transitions found -- was session.json mutated out of band?`;
  }
  return `${prefix}predecessor not visited: ${f.details.predecessor_key}`;
}

/**
 * @param {{file: string, reason: string}} f
 * @param {string} specGroupDir - absolute path to spec group dir
 * @param {string} [prefix='']
 * @returns {string}
 */
export function formatArtifactInventoryFailure(f, specGroupDir, prefix = '') {
  if (f.reason === 'spec_group_missing') {
    return `${prefix}spec group directory missing: ${specGroupDir}`;
  }
  return `${prefix}${f.file}: missing under ${specGroupDir}/`;
}

/**
 * @param {{gate_pair: string, manifest_value: unknown, session_count: number}} f
 * @param {string} [prefix='']
 * @returns {string}
 */
export function formatConvergenceSanityFailure(f, prefix = '') {
  return `${prefix}${f.gate_pair}: manifest=${JSON.stringify(f.manifest_value)}, session clean_pass_count=${f.session_count}`;
}

// =============================================================================
// Enforcement policy (documented in spec § Enforcement-level interaction)
// =============================================================================

/**
 * Per-check enforcement policy.
 *
 * Under `warn-only` mode, checks with policy='respect' emit stderr warnings
 * instead of blocking. Checks with policy='always' block regardless of
 * enforcement level.
 *
 * Spec source: spec.md § Enforcement-level interaction.
 */
export const CHECK_ENFORCEMENT_POLICY = Object.freeze({
  convergenceDepth: 'always',
  convergenceFieldSanity: 'always',
  artifactInventory: 'always',
  challengerStages: 'respect',
  phaseDag: 'respect',
});

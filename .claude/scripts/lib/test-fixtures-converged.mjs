/**
 * Shared fixture helpers for Stop-hook testing.
 *
 * Converged workflow fixtures for Stop-hook and verify CLI tests.
 *
 * Exports builders for session.json and manifest.json shapes that satisfy all
 * five new completion-invariant checks documented in the spec:
 *   - checkConvergenceDepth (clean_pass_count >= 2 for all six gates)
 *   - checkChallengerStages (challenger dispatches for every required stage
 *     per REQUIRED_CHALLENGER_STAGES[workflow])
 *   - checkPhaseDagPredecessors (phase_transition history for every mandatory
 *     predecessor of 'complete' per ONEOFF_SPEC_PREDECESSORS /
 *     ORCHESTRATOR_PREDECESSORS)
 *   - checkArtifactInventory (investigation-report.md, unify-report.md,
 *     docs/COVERAGE.md, atomic/*.md for orchestrator)
 *   - checkConvergenceFieldSanity (manifest.convergence.<gate>_passed booleans
 *     agree with session.convergence[gate].clean_pass_count >= 2)
 *
 * Data shapes match the authoritative layouts documented in spec.md
 * § Session data shapes consumed (verified accurate against real code).
 *
 * Importers SHOULD be test files under .claude/scripts/__tests__/; functions
 * use relative fs helpers from node:fs rather than opening files directly so
 * tests stay deterministic across OS temp dirs. Relocated from
 * .claude/scripts/__tests__/fixtures/converged-fixtures.mjs to
 * .claude/scripts/lib/test-fixtures-converged.mjs so that registered test
 * artifacts can import it without triggering the test-leaf-violation rule
 * (helpers must live outside __tests__/ and __fixtures__/).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// CR-M3: Import DAG constants directly from the shared workflow-dag module.
// These are module-level static data (not behavioral SUT), so importing them
// does not invert the test->SUT dependency -- the real SUTs (the hook, the
// check functions, the CLI) are still exercised through their public
// entry points. Previously these were hand-copied into this fixture; that
// created a silent drift risk as the DAG evolved.
import {
  REQUIRED_CHALLENGER_STAGES,
  ONEOFF_SPEC_PREDECESSORS,
  ORCHESTRATOR_PREDECESSORS,
  VALID_CONVERGENCE_GATES,
} from './workflow-dag.mjs';

const ALL_MANDATORY_DISPATCHES = [
  { subagent_type: 'code-reviewer', status: 'completed' },
  { subagent_type: 'security-reviewer', status: 'completed' },
  { subagent_type: 'completion-verifier', status: 'completed' },
  { subagent_type: 'documenter', status: 'completed' },
  { subagent_type: 'e2e-test-writer', status: 'completed' },
];

const DEFAULT_TIMESTAMP = '2026-04-17T12:00:00.000Z';

/**
 * Build challenger dispatch entries for all required stages of a workflow.
 * Shape matches spec.md § Session data shapes consumed (a).
 *
 * @param {'oneoff-spec'|'orchestrator'} workflow
 * @param {object} [opts]
 * @param {string} [opts.specGroupId]
 * @returns {Array<object>} Task record entries
 */
export function makeChallengerDispatches(workflow, opts = {}) {
  const stages = REQUIRED_CHALLENGER_STAGES[workflow] || [];
  const specGroupId = opts.specGroupId ?? 'sg-test-fixture';
  return stages.map((stage, idx) => ({
    task_id: `challenger-${stage}-${idx}`,
    subagent_type: 'challenger',
    description: `challenger stage ${stage}`,
    dispatched_at: DEFAULT_TIMESTAMP,
    completed_at: DEFAULT_TIMESTAMP,
    status: 'completed',
    result_summary: 'clean',
    spec_group_id: specGroupId,
    atomic_spec_id: null,
    stage,
  }));
}

/**
 * Build phase_transition history entries for every mandatory predecessor of
 * 'complete' in the given workflow.
 *
 * @param {'oneoff-spec'|'orchestrator'} workflow
 * @param {object} [opts]
 * @param {string} [opts.specGroupId]
 * @returns {Array<object>} session.history[] entries
 */
export function makePhaseTransitionHistory(workflow, opts = {}) {
  const graph =
    workflow === 'orchestrator'
      ? ORCHESTRATOR_PREDECESSORS
      : ONEOFF_SPEC_PREDECESSORS;
  const specGroupId = opts.specGroupId ?? 'sg-test-fixture';
  // Walk every predecessor key (to-phases) AND every value in the graph
  // (predecessors including root 'prd_gathering'). Every phase referenced
  // anywhere in the graph must appear as a phase_transition target so the
  // DAG check sees a complete visited set.
  const allPhases = new Set();
  for (const [toPhase, fromList] of Object.entries(graph)) {
    allPhases.add(toPhase);
    for (const fromPhase of fromList) {
      allPhases.add(fromPhase);
    }
  }
  // Also include 'complete' as the final visited phase
  allPhases.add('complete');
  const entries = [];
  for (const phase of allPhases) {
    const fromPhase = graph[phase]?.[0] || 'prd_gathering';
    entries.push({
      timestamp: DEFAULT_TIMESTAMP,
      event_type: 'phase_transition',
      details: {
        from_phase: fromPhase,
        to_phase: phase,
        spec_group_id: specGroupId,
        message: `Phase transition: -> ${phase}`,
      },
    });
  }
  return entries;
}

/**
 * Build a convergence object for session.json with all six gates at
 * clean_pass_count >= 2.
 */
function makeSessionConvergence(count = 2) {
  const obj = {};
  for (const gate of VALID_CONVERGENCE_GATES) {
    obj[gate] = { clean_pass_count: count };
  }
  return obj;
}

/**
 * Build a session.json that satisfies ALL FIVE new completion-invariant checks
 * by default. Each check can be independently unsatisfied via overrides.
 *
 * @param {object} [overrides]
 * @param {'oneoff-spec'|'orchestrator'} [overrides.workflow]
 * @param {string} [overrides.currentPhase]
 * @param {string|undefined} [overrides.specGroupId]
 * @param {string} [overrides.enforcementLevel]
 * @param {object} [overrides.convergence] - override the session.convergence block wholesale
 * @param {Array} [overrides.tasks] - overrides completed_this_session
 * @param {Array} [overrides.inFlight] - overrides in_flight
 * @param {Array} [overrides.history] - override history wholesale
 * @param {Array} [overrides.extraTasks] - append additional tasks to default set
 * @param {boolean} [overrides.includeChallengers=true]
 * @param {boolean} [overrides.includeHistory=true]
 * @param {boolean} [overrides.includeMandatory=true]
 * @returns {object} session.json shape
 */
export function makeConvergedSession(overrides = {}) {
  const workflow = overrides.workflow ?? 'oneoff-spec';
  const currentPhase = overrides.currentPhase ?? 'complete';
  // Distinguish "key not provided" (default to fixture sg-id) from
  // "key explicitly set to undefined/null" (omit from active_work).
  // Callers that want to simulate a session with NO spec_group_id pass
  // { specGroupId: null } or { specGroupId: undefined } explicitly.
  let specGroupId;
  if ('specGroupId' in overrides) {
    // Explicit override — may be a string, null, or undefined.
    // null/undefined => omit. string => use as-is.
    specGroupId = overrides.specGroupId ?? null;
  } else {
    specGroupId = 'sg-test-fixture';
  }
  const enforcementLevel = overrides.enforcementLevel ?? 'graduated';

  const includeMandatory = overrides.includeMandatory !== false;
  const includeChallengers = overrides.includeChallengers !== false;
  const includeHistory = overrides.includeHistory !== false;

  const baseTasks = includeMandatory ? [...ALL_MANDATORY_DISPATCHES] : [];
  const challengers = includeChallengers
    ? makeChallengerDispatches(workflow, { specGroupId })
    : [];
  const tasks =
    overrides.tasks !== undefined
      ? overrides.tasks
      : [...baseTasks, ...challengers, ...(overrides.extraTasks || [])];

  const history =
    overrides.history !== undefined
      ? overrides.history
      : includeHistory
        ? makePhaseTransitionHistory(workflow, { specGroupId })
        : [];

  const convergence =
    overrides.convergence !== undefined
      ? overrides.convergence
      : makeSessionConvergence(2);

  const active_work = {
    workflow,
    current_phase: currentPhase,
    objective: 'fixture objective',
    started_at: DEFAULT_TIMESTAMP,
    // Only include spec_group_id when non-null. null/undefined => omit.
    ...(specGroupId !== null && specGroupId !== undefined ? { spec_group_id: specGroupId } : {}),
  };

  return {
    version: '1.0.0',
    updated_at: DEFAULT_TIMESTAMP,
    active_work,
    phase_checkpoint: {
      phase: currentPhase,
      enforcement_level: enforcementLevel,
      phase_skip_warnings: {},
      enforcement_counter: 0,
      next_actions: [],
    },
    subagent_tasks: {
      in_flight: overrides.inFlight || [],
      completed_this_session: tasks,
    },
    history,
    convergence,
  };
}

/**
 * Build a complete session with challenger dispatch entries present in
 * subagent_tasks.completed_this_session for all required stages.
 * Alias for makeConvergedSession({...}) with emphasis on the challenger stage
 * assertion path.
 */
export function makeCompleteSessionWithStages(overrides = {}) {
  return makeConvergedSession(overrides);
}

/**
 * Build a converged session that ALSO has a FAILED manual-tester dispatch
 * appended to subagent_tasks.completed_this_session[]. Used to assert the Stop
 * hook ignores manual-tester outcome (AC-15 part 2).
 *
 * Behavior:
 *   - Base session from makeConvergedSession(overrides) so every mandatory
 *     Stop-hook dispatch (code-reviewer, security-reviewer,
 *     completion-verifier, documenter, e2e-test-writer) is present and
 *     successful.
 *   - Appends one task record: subagent_type='manual-tester', status='failed'.
 *
 * @param {object} [overrides] - forwarded to makeConvergedSession, plus:
 * @param {string} [overrides.manualTesterSummary] - result_summary for the
 *   failed manual-tester entry (default: generic failure string).
 * @param {string} [overrides.manualTesterTaskId] - task_id for the failed
 *   entry (default: 'task-manual-tester-failed').
 * @returns {object} session.json shape
 */
export function makeFailedManualTesterSession(overrides = {}) {
  const {
    manualTesterSummary,
    manualTesterTaskId,
    ...sessionOverrides
  } = overrides;
  const session = makeConvergedSession(sessionOverrides);
  const specGroupId =
    session.active_work?.spec_group_id ?? 'sg-test-fixture';
  session.subagent_tasks.completed_this_session.push({
    task_id: manualTesterTaskId ?? 'task-manual-tester-failed',
    subagent_type: 'manual-tester',
    description: 'exploratory verification after /docs',
    dispatched_at: DEFAULT_TIMESTAMP,
    completed_at: DEFAULT_TIMESTAMP,
    status: 'failed',
    result_summary:
      manualTesterSummary ??
      'FAILURE: exploratory findings recorded; see evidence/*.png',
    spec_group_id: specGroupId,
    atomic_spec_id: null,
  });
  return session;
}

/**
 * Build a manifest.json with all convergence flags true.
 *
 * The manifest uses both naming conventions observed in real manifests:
 *   convergence.<gate>_passed (booleans — code_review_passed, security_review_passed)
 *   convergence.<gate>_converged (booleans — investigation_converged, challenger_converged)
 *   convergence.unifier_passed
 *   convergence.completion_verification_passed
 *
 * @param {object} [overrides]
 * @returns {object} manifest.json shape
 */
export function makeConvergedManifest(overrides = {}) {
  const convergence = {
    spec_complete: true,
    investigation_converged: true,
    challenger_converged: true,
    all_acs_implemented: true,
    all_tests_passing: true,
    unifier_passed: true,
    code_review_passed: true,
    security_review_passed: true,
    completion_verification_passed: true,
    docs_generated: true,
    ...(overrides.convergence || {}),
  };
  return {
    id: overrides.id ?? 'sg-test-fixture',
    title: overrides.title ?? 'Test Fixture',
    description: overrides.description ?? 'Fixture manifest',
    workflow: overrides.workflow ?? 'oneoff-spec',
    review_state: overrides.review_state ?? 'APPROVED',
    work_state: overrides.work_state ?? 'READY_TO_MERGE',
    created_at: overrides.created_at ?? DEFAULT_TIMESTAMP,
    updated_at: overrides.updated_at ?? DEFAULT_TIMESTAMP,
    convergence,
    decision_log: overrides.decision_log ?? [],
    ...(overrides.extras || {}),
  };
}

/**
 * Create a spec group directory under a temp root with the optional artifact
 * files specified. Used for AC9 (oneoff-spec artifact inventory) and AC10
 * (orchestrator atomic/*.md inventory).
 *
 * @param {string} tmpRoot - absolute path to .claude/specs/groups/ parent
 *                           (i.e., the tests pass the real CLAUDE_DIR/specs/groups)
 * @param {string} specGroupId - e.g., 'sg-test-ac9'
 * @param {object} [artifacts]
 * @param {boolean} [artifacts.requirements=false]
 * @param {boolean} [artifacts.spec=false]
 * @param {boolean|object} [artifacts.manifest=false] - true for default, object for content
 * @param {boolean} [artifacts.investigation=false] - create investigation-report.md
 * @param {boolean} [artifacts.unify=false] - create unify-report.md
 * @param {boolean} [artifacts.coverage=false] - create docs/COVERAGE.md
 * @param {boolean|number} [artifacts.atomic=false] - true=1 file; number=N files; false=no atomic dir
 * @param {boolean} [artifacts.atomicDirEmpty=false] - creates atomic/ but no *.md
 * @returns {string} absolute path of the created spec-group directory
 */
export function makeSpecGroupDir(tmpRoot, specGroupId, artifacts = {}) {
  const dir = join(tmpRoot, specGroupId);
  mkdirSync(dir, { recursive: true });

  if (artifacts.requirements) {
    writeFileSync(
      join(dir, 'requirements.md'),
      '---\nspec_group: ' + specGroupId + '\n---\n\n# Requirements\n',
    );
  }
  if (artifacts.spec) {
    writeFileSync(
      join(dir, 'spec.md'),
      '---\nid: ' + specGroupId + '\n---\n\n# Spec\n',
    );
  }
  if (artifacts.manifest) {
    const manifest =
      artifacts.manifest === true
        ? makeConvergedManifest({ id: specGroupId })
        : artifacts.manifest;
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );
  }
  if (artifacts.investigation) {
    writeFileSync(
      join(dir, 'investigation-report.md'),
      '# Investigation Report\n\nFixture.\n',
    );
  }
  if (artifacts.unify) {
    writeFileSync(
      join(dir, 'unify-report.md'),
      '# Unify Report\n\nFixture.\n',
    );
  }
  if (artifacts.coverage) {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(
      join(dir, 'docs', 'COVERAGE.md'),
      '# Coverage\n\nFixture.\n',
    );
  }
  if (artifacts.atomicDirEmpty) {
    // Create atomic/ with no *.md files (for AC10 orchestrator zero-atomic case)
    mkdirSync(join(dir, 'atomic'), { recursive: true });
  } else if (artifacts.atomic) {
    const count = artifacts.atomic === true ? 1 : artifacts.atomic;
    mkdirSync(join(dir, 'atomic'), { recursive: true });
    for (let i = 1; i <= count; i++) {
      const idStr = String(i).padStart(3, '0');
      writeFileSync(
        join(dir, 'atomic', `as-${idStr}-fixture.md`),
        '---\nid: as-' + idStr + '-fixture\n---\n\n# Atomic\n',
      );
    }
  }

  return dir;
}

/**
 * Re-export constants for tests that need to assert against them.
 */
export const FIXTURE_CONSTANTS = {
  REQUIRED_CHALLENGER_STAGES,
  ONEOFF_SPEC_PREDECESSORS,
  ORCHESTRATOR_PREDECESSORS,
  VALID_CONVERGENCE_GATES,
  ALL_MANDATORY_DISPATCHES,
  DEFAULT_TIMESTAMP,
};

/**
 * Shared Workflow DAG Module
 *
 * Extracted from session-checkpoint.mjs to provide a single source of truth
 * for workflow DAG definitions, enforcement constants, and query functions.
 * Consumed by both the cooperative layer (session-checkpoint.mjs) and the
 * coercive layer (enforcement hooks).
 *
 * Implements: REQ-001, REQ-002
 * Spec: sg-coercive-gate-enforcement
 */

// =============================================================================
// DAG Constants
// =============================================================================

/**
 * Predecessor graph for orchestrator workflow (14 entries).
 * Keys use parameterized encoding: "challenging:<stage>" maps to challenger
 * dispatch with that stage value, not a literal phase name in VALID_PHASES.
 */
export const ORCHESTRATOR_PREDECESSORS = {
  'spec_authoring': ['prd_gathering'],
  'atomizing': ['spec_authoring'],
  'enforcing': ['atomizing'],
  'investigating': ['enforcing'],
  'challenging:pre-orchestration': ['investigating'],
  'auto_approval': ['challenging:pre-orchestration'],
  'implementing': ['auto_approval'],
  'challenging:pre-test': ['implementing'],
  'testing': ['challenging:pre-test'],
  'verifying': ['testing'],
  'challenging:pre-review': ['verifying'],
  'reviewing': ['challenging:pre-review'],
  'completion_verifying': ['reviewing'],
  'documenting': ['completion_verifying'],
};

/**
 * Predecessor graph for oneoff-spec workflow (12 entries).
 */
export const ONEOFF_SPEC_PREDECESSORS = {
  'spec_authoring': ['prd_gathering'],
  'investigating': ['spec_authoring'],
  'challenging:pre-implementation': ['investigating'],
  'auto_approval': ['challenging:pre-implementation'],
  'implementing': ['auto_approval'],
  'challenging:pre-test': ['implementing'],
  'testing': ['challenging:pre-test'],
  'verifying': ['testing'],
  'challenging:pre-review': ['verifying'],
  'reviewing': ['challenging:pre-review'],
  'completion_verifying': ['reviewing'],
  'documenting': ['completion_verifying'],
};

/**
 * Workflow types exempt from enforcement.
 * Includes journal-only per DEC-003.
 * @type {string[]}
 */
export const EXEMPT_WORKFLOWS = ['oneoff-vibe', 'refactor', 'journal-only'];

/**
 * Valid subagent types (21 entries).
 * @type {string[]}
 */
export const VALID_SUBAGENT_TYPES = [
  'explore',
  'spec-author',
  'atomizer',
  'atomicity-enforcer',
  'interface-investigator',
  'implementer',
  'test-writer',
  'e2e-test-writer',
  'unifier',
  'code-reviewer',
  'security-reviewer',
  'documenter',
  'refactorer',
  'facilitator',
  'browser-tester',
  'prd-writer',
  'prd-critic',
  'prd-reader',
  'prd-amender',
  'challenger',
  'completion-verifier'
];

/**
 * Mandatory dispatches per phase per workflow.
 * Used by SubagentStop advisory hooks and completion checklist.
 */
export const MANDATORY_DISPATCHES = {
  orchestrator: {
    'implementing': [{ type: 'challenger', stage: 'pre-orchestration' }],
    'testing': [{ type: 'challenger', stage: 'pre-test' }],
    'reviewing': [{ type: 'challenger', stage: 'pre-review' }, { type: 'code-reviewer' }],
    'complete': [{ type: 'completion-verifier' }, { type: 'documenter' }],
  },
  'oneoff-spec': {
    'implementing': [{ type: 'challenger', stage: 'pre-implementation' }],
    'testing': [{ type: 'challenger', stage: 'pre-test' }],
    'reviewing': [{ type: 'challenger', stage: 'pre-review' }, { type: 'code-reviewer' }],
    'complete': [{ type: 'completion-verifier' }, { type: 'documenter' }],
  },
};

/**
 * Required challenger stages per workflow.
 */
export const REQUIRED_CHALLENGER_STAGES = {
  orchestrator: ['pre-orchestration', 'pre-test', 'pre-review'],
  'oneoff-spec': ['pre-implementation', 'pre-test', 'pre-review'],
};

// =============================================================================
// Enforcement Table for Coercive Hooks
// =============================================================================

/**
 * Subagent types subject to coercive gate enforcement.
 * Non-enforced types pass through without prerequisite checks.
 * @type {string[]}
 */
export const ENFORCED_SUBAGENT_TYPES = [
  'implementer',
  'test-writer',
  'e2e-test-writer',
  'code-reviewer',
  'security-reviewer',
  'documenter',
  'completion-verifier',
];

/**
 * Mandatory dispatches checked by the Stop hook.
 * The Stop hook checks for the presence of dispatch records (any status)
 * for these four subagent types.
 * @type {string[]}
 */
export const STOP_MANDATORY_DISPATCHES = [
  'code-reviewer',
  'security-reviewer',
  'completion-verifier',
  'documenter',
  'e2e-test-writer',
];

/**
 * Phase-aware dispatch requirements for the Stop hook.
 *
 * Maps session phases to the set of mandatory Stop-hook dispatches required
 * when the session is ending at that phase. Phases not listed require zero
 * dispatches (pre-implementation and implementation phases).
 *
 * Implements: REQ-002 through REQ-006 of sg-phase-aware-stop-hook
 * @type {Record<string, string[]>}
 */
export const STOP_PHASE_REQUIREMENTS = {
  // Pre-implementation phases: no dispatches required (implicit default)
  // Implementation phases: no dispatches required (implicit default)

  // Review phases
  reviewing: ['code-reviewer', 'security-reviewer', 'e2e-test-writer'],
  completion_verifying: ['code-reviewer', 'security-reviewer', 'completion-verifier', 'e2e-test-writer'],

  // Terminal phases
  documenting: ['code-reviewer', 'security-reviewer', 'completion-verifier', 'documenter', 'e2e-test-writer'],
  complete: ['code-reviewer', 'security-reviewer', 'completion-verifier', 'documenter', 'e2e-test-writer'],
};

/**
 * Valid rationale values for e2e_skip opt-out in spec frontmatter.
 * Shared across spec validation hooks and the stop hook for defense-in-depth.
 *
 * Implements: REQ-003 of sg-e2e-default-dispatch
 * @type {string[]}
 */
export const VALID_E2E_SKIP_RATIONALES = [
  'pure-refactor',
  'test-infra',
  'type-only',
  'docs-only',
];

/**
 * Override gate name mapping.
 * Maps prerequisite conditions to canonical gate names for gate-override.json.
 */
export const OVERRIDE_GATE_NAMES = {
  investigation: 'investigation',
  investigation_convergence: 'investigation_convergence',
  challenger_convergence: 'challenger_convergence',
  challenge_pre_impl: 'challenge_pre_impl',
  challenge_pre_orchestration: 'challenge_pre_orchestration',
  implementer_dispatch: 'implementer_dispatch',
  challenge_pre_review: 'challenge_pre_review',
  unifier_dispatch: 'unifier_dispatch',
  code_review_convergence: 'code_review_convergence',
  security_review_convergence: 'security_review_convergence',
  documenter_dispatch: 'documenter_dispatch',
  stop_mandatory_dispatches: 'stop_mandatory_dispatches',
  status_obligations: 'status_obligations',
};

/**
 * Number of consecutive clean passes required for a convergence gate.
 * Referenced by getPrerequisites() when building convergence prerequisites.
 * @type {number}
 */
export const REQUIRED_CLEAN_PASSES = 2;

/**
 * Valid convergence gate names for the update-convergence command.
 * @type {string[]}
 */
export const VALID_CONVERGENCE_GATES = ['code_review', 'security_review', 'investigation', 'challenger'];

// =============================================================================
// Phase Obligations (Status Obligation Enforcement)
// =============================================================================

/**
 * Static phase-to-obligation mapping.
 * Each entry defines the manifest fields that must have specific values
 * when leaving (exiting) the specified phase.
 *
 * Field paths use dot notation for nested fields:
 * - "review_state" -> manifest.review_state
 * - "convergence.spec_complete" -> manifest.convergence.spec_complete
 *
 * 13 obligation entries across 8 phases. Entry-semantics obligations
 * (e.g., work_state = IMPLEMENTING) are checked at exit time alongside
 * exit-semantics obligations (TECH-101 resolution).
 *
 * Implements: REQ-001, REQ-002, REQ-020 of sg-status-obligation-enforcement
 */
export const PHASE_OBLIGATIONS = Object.freeze({
  spec_authoring: Object.freeze([
    Object.freeze({ field: 'review_state', expected: 'DRAFT' }),
    Object.freeze({ field: 'convergence.spec_complete', expected: true }),
  ]),
  investigating: Object.freeze([
    Object.freeze({ field: 'convergence.investigation_converged', expected: true }),
  ]),
  challenging: Object.freeze([
    Object.freeze({ field: 'convergence.challenger_converged', expected: true }),
  ]),
  implementing: Object.freeze([
    Object.freeze({ field: 'work_state', expected: 'IMPLEMENTING' }),
    Object.freeze({ field: 'convergence.all_acs_implemented', expected: true }),
  ]),
  testing: Object.freeze([
    Object.freeze({ field: 'convergence.all_tests_passing', expected: true }),
  ]),
  verifying: Object.freeze([
    Object.freeze({ field: 'convergence.unifier_passed', expected: true }),
    Object.freeze({ field: 'work_state', expected: 'VERIFYING' }),
  ]),
  reviewing: Object.freeze([
    Object.freeze({ field: 'convergence.code_review_passed', expected: true }),
    Object.freeze({ field: 'convergence.security_review_passed', expected: true }),
  ]),
  completion_verifying: Object.freeze([
    Object.freeze({ field: 'convergence.completion_verification_passed', expected: true }),
  ]),
  documenting: Object.freeze([
    Object.freeze({ field: 'convergence.docs_generated', expected: true }),
    Object.freeze({ field: 'work_state', expected: 'READY_TO_MERGE' }),
  ]),
});

/**
 * Resolve a dot-notation field path against an object.
 * Returns undefined if any segment is missing.
 *
 * @param {string} path - Dot-notation field path (e.g., "convergence.spec_complete")
 * @param {object} obj - Object to resolve against
 * @returns {*} The resolved value, or undefined if any segment is missing
 */
function resolveFieldPath(path, obj) {
  const segments = path.split('.');
  let current = obj;
  for (const segment of segments) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    // SEC-002: Guard against prototype pollution via crafted field paths
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/**
 * Validate manifest fields against obligations for a given phase.
 *
 * Uses strict equality (===) for all comparisons -- no truthy coercion (REQ-012).
 * Missing fields (undefined) are returned as null in the violation report (REQ-011).
 * Returns { passed: true, violations: [] } for phases with no obligations (AC-1.3).
 *
 * Implements: REQ-001, REQ-011, REQ-012 of sg-status-obligation-enforcement
 *
 * @param {string} phase - Phase being left (outgoing phase)
 * @param {object} manifest - Parsed manifest.json object
 * @returns {{ passed: boolean, violations: Array<{field: string, expected: any, actual: any}> }}
 */
export function validateObligations(phase, manifest) {
  const obligations = PHASE_OBLIGATIONS[phase];
  if (!obligations || obligations.length === 0) {
    return { passed: true, violations: [] };
  }

  const violations = [];
  for (const { field, expected } of obligations) {
    const actual = resolveFieldPath(field, manifest);
    if (actual !== expected) { // strict equality (===)
      violations.push({ field, expected, actual: actual === undefined ? null : actual });
    }
  }

  return { passed: violations.length === 0, violations };
}

// =============================================================================
// Query Functions
// =============================================================================

/**
 * Get the workflow type from session state.
 * Returns the workflow from active_work, defaulting to 'orchestrator' if missing.
 * Backward-compatible -- used by session-checkpoint.mjs (cooperative layer).
 *
 * @param {object} session - Session object from session.json
 * @returns {string} Workflow type string
 */
export function getWorkflowType(session) {
  const workflow = session?.active_work?.workflow;
  if (!workflow) {
    return 'orchestrator';
  }
  return workflow;
}

/**
 * Get the workflow type from session state, strict mode.
 * Returns null if workflow is not set -- used by coercive hooks for fail-open behavior.
 *
 * @param {object} session - Session object from session.json
 * @returns {string|null} Workflow type string or null
 */
export function getWorkflowTypeStrict(session) {
  return session?.active_work?.workflow || null;
}

/**
 * Check if a workflow type is exempt from enforcement.
 *
 * @param {string} workflow - Workflow type string
 * @returns {boolean} True if exempt
 */
export function isExemptWorkflow(workflow) {
  return EXEMPT_WORKFLOWS.includes(workflow);
}

/**
 * Get the predecessor graph for a given workflow type.
 * Returns null for exempt workflows. Defaults to orchestrator when unknown.
 *
 * @param {string} workflow - Workflow type string
 * @returns {object|null} Predecessor graph or null for exempt workflows
 */
export function getPredecessorGraph(workflow) {
  if (EXEMPT_WORKFLOWS.includes(workflow)) return null;
  if (workflow === 'oneoff-spec') return ONEOFF_SPEC_PREDECESSORS;
  return ORCHESTRATOR_PREDECESSORS; // default to most restrictive
}

/**
 * Check if a parameterized predecessor was visited.
 * For "challenging:<stage>" keys, checks dispatch history for a challenger
 * subagent with the matching stage field. For plain phase names, checks
 * session history for a phase_transition event to that phase.
 *
 * @param {string} predecessorKey - Predecessor key (e.g., "challenging:pre-test" or "spec_authoring")
 * @param {object} session - Session object from session.json
 * @returns {boolean} True if the predecessor was visited
 */
export function wasPredecessorVisited(predecessorKey, session) {
  const challengeMatch = predecessorKey.match(/^challenging:(.+)$/);

  if (challengeMatch) {
    const requiredStage = challengeMatch[1];
    // Check dispatch history for a challenger with this stage
    const allTasks = [
      ...(session.subagent_tasks?.in_flight || []),
      ...(session.subagent_tasks?.completed_this_session || [])
    ];
    return allTasks.some(
      t => t.subagent_type === 'challenger' && t.stage === requiredStage
    );
  }

  // Plain phase: check if it appears in session history as a phase_transition target
  return (session.history || []).some(
    h => h.event_type === 'phase_transition' && h.details?.to_phase === predecessorKey
  );
}

/**
 * Get all dispatch tasks from session (both in-flight and completed).
 *
 * @param {object} session - Session object from session.json
 * @returns {Array} Array of dispatch task records
 */
export function getAllTasks(session) {
  return [
    ...(session.subagent_tasks?.in_flight || []),
    ...(session.subagent_tasks?.completed_this_session || [])
  ];
}

/**
 * Get the prerequisites for a given subagent type in a given workflow.
 * Returns an array of prerequisite descriptors.
 *
 * Each prerequisite is one of:
 * - { type: 'dispatch', subagent_type: string } - a dispatch must exist
 * - { type: 'dispatch', subagent_type: string, stage: string } - a staged dispatch must exist
 * - { type: 'convergence', gate: string, required_count: number } - convergence count must be met
 *
 * @param {string} workflow - Workflow type ('oneoff-spec' or 'orchestrator')
 * @param {string} subagentType - The subagent type to check prerequisites for
 * @returns {Array<object>} Prerequisites array
 */
export function getPrerequisites(workflow, subagentType) {
  if (!ENFORCED_SUBAGENT_TYPES.includes(subagentType)) {
    return [];
  }

  const prerequisites = [];

  switch (subagentType) {
    case 'implementer': {
      // AC-1.7, AC-1.8: Convergence-type prerequisites for investigation and challenger
      prerequisites.push({
        type: 'convergence',
        gate: 'investigation',
        required_count: REQUIRED_CLEAN_PASSES,
        gate_name: OVERRIDE_GATE_NAMES.investigation_convergence,
      });
      prerequisites.push({
        type: 'convergence',
        gate: 'challenger',
        required_count: REQUIRED_CLEAN_PASSES,
        gate_name: OVERRIDE_GATE_NAMES.challenger_convergence,
      });
      break;
    }

    case 'test-writer': {
      // No coercive prerequisites — test-writer works from spec only (Practice 2.4)
      // Implementer dispatch ordering is a workflow convention, not a gate requirement
      break;
    }

    case 'e2e-test-writer': {
      // No coercive prerequisites — e2e-test-writer works from spec/contracts only (Practice 2.4)
      // Same dispatch pattern as test-writer: parallel with implementer, no ordering dependency
      break;
    }

    case 'code-reviewer': {
      prerequisites.push({
        type: 'dispatch',
        subagent_type: 'challenger',
        stage: 'pre-review',
        gate_name: OVERRIDE_GATE_NAMES.challenge_pre_review,
      });
      prerequisites.push({
        type: 'dispatch',
        subagent_type: 'unifier',
        gate_name: OVERRIDE_GATE_NAMES.unifier_dispatch,
      });
      break;
    }

    case 'security-reviewer': {
      // Same prerequisites as code-reviewer — both run in parallel after review prerequisites
      prerequisites.push({
        type: 'dispatch',
        subagent_type: 'challenger',
        stage: 'pre-review',
        gate_name: OVERRIDE_GATE_NAMES.challenge_pre_review,
      });
      prerequisites.push({
        type: 'dispatch',
        subagent_type: 'unifier',
        gate_name: OVERRIDE_GATE_NAMES.unifier_dispatch,
      });
      break;
    }

    case 'documenter': {
      // Requires BOTH review convergence gates — both run in parallel, both must converge
      prerequisites.push({
        type: 'convergence',
        gate: 'code_review',
        required_count: REQUIRED_CLEAN_PASSES,
        gate_name: OVERRIDE_GATE_NAMES.code_review_convergence,
      });
      prerequisites.push({
        type: 'convergence',
        gate: 'security_review',
        required_count: REQUIRED_CLEAN_PASSES,
        gate_name: OVERRIDE_GATE_NAMES.security_review_convergence,
      });
      break;
    }

    case 'completion-verifier': {
      prerequisites.push({
        type: 'dispatch',
        subagent_type: 'documenter',
        gate_name: OVERRIDE_GATE_NAMES.documenter_dispatch,
      });
      break;
    }
  }

  return prerequisites;
}

/**
 * Check whether prerequisites are met in session state.
 *
 * @param {object} session - Session object from session.json
 * @param {Array<object>} prerequisites - Prerequisites from getPrerequisites()
 * @returns {{ met: boolean, missing: Array<{ prerequisite: object, gate_name: string }> }}
 */
export function werePrerequisitesMet(session, prerequisites) {
  const missing = [];
  const allTasks = getAllTasks(session);

  for (const prereq of prerequisites) {
    if (prereq.type === 'dispatch') {
      let found;
      if (prereq.stage) {
        found = allTasks.some(
          t => t.subagent_type === prereq.subagent_type && t.stage === prereq.stage
        );
      } else {
        found = allTasks.some(
          t => t.subagent_type === prereq.subagent_type
        );
      }

      if (!found) {
        missing.push({
          prerequisite: prereq,
          gate_name: prereq.gate_name,
        });
      }
    } else if (prereq.type === 'convergence') {
      // Fail-CLOSED: missing convergence field treated as 0 (REQ-031)
      const count = session.convergence?.[prereq.gate]?.clean_pass_count ?? 0;
      if (count < prereq.required_count) {
        missing.push({
          prerequisite: prereq,
          gate_name: prereq.gate_name,
        });
      }
    }
  }

  return {
    met: missing.length === 0,
    missing,
  };
}

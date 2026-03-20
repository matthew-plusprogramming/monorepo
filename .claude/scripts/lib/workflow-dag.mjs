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
  'awaiting_approval': ['investigating'],
  'challenging:pre-orchestration': ['awaiting_approval'],
  'implementing': ['challenging:pre-orchestration'],
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
  'awaiting_approval': ['investigating'],
  'challenging:pre-implementation': ['awaiting_approval'],
  'implementing': ['challenging:pre-implementation'],
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
 * Valid subagent types (20 entries).
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
  reviewing: ['code-reviewer', 'security-reviewer'],
  completion_verifying: ['code-reviewer', 'security-reviewer', 'completion-verifier'],

  // Terminal phases
  documenting: ['code-reviewer', 'security-reviewer', 'completion-verifier', 'documenter'],
  complete: ['code-reviewer', 'security-reviewer', 'completion-verifier', 'documenter'],
};

/**
 * Override gate name mapping.
 * Maps prerequisite conditions to canonical gate names for gate-override.json.
 */
export const OVERRIDE_GATE_NAMES = {
  investigation: 'investigation',
  challenge_pre_impl: 'challenge_pre_impl',
  challenge_pre_orchestration: 'challenge_pre_orchestration',
  implementer_dispatch: 'implementer_dispatch',
  challenge_pre_review: 'challenge_pre_review',
  unifier_dispatch: 'unifier_dispatch',
  code_review_convergence: 'code_review_convergence',
  security_review_convergence: 'security_review_convergence',
  documenter_dispatch: 'documenter_dispatch',
  stop_mandatory_dispatches: 'stop_mandatory_dispatches',
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
export const VALID_CONVERGENCE_GATES = ['code_review', 'security_review'];

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
      // interface-investigator dispatched
      prerequisites.push({
        type: 'dispatch',
        subagent_type: 'interface-investigator',
        gate_name: OVERRIDE_GATE_NAMES.investigation,
      });
      // challenger with appropriate stage
      if (workflow === 'oneoff-spec') {
        prerequisites.push({
          type: 'dispatch',
          subagent_type: 'challenger',
          stage: 'pre-implementation',
          gate_name: OVERRIDE_GATE_NAMES.challenge_pre_impl,
        });
      } else {
        // orchestrator (default)
        prerequisites.push({
          type: 'dispatch',
          subagent_type: 'challenger',
          stage: 'pre-orchestration',
          gate_name: OVERRIDE_GATE_NAMES.challenge_pre_orchestration,
        });
      }
      break;
    }

    case 'test-writer': {
      prerequisites.push({
        type: 'dispatch',
        subagent_type: 'implementer',
        gate_name: OVERRIDE_GATE_NAMES.implementer_dispatch,
      });
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
      prerequisites.push({
        type: 'convergence',
        gate: 'code_review',
        required_count: REQUIRED_CLEAN_PASSES,
        gate_name: OVERRIDE_GATE_NAMES.code_review_convergence,
      });
      break;
    }

    case 'documenter': {
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

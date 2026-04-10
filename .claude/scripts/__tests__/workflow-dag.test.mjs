/**
 * Tests for the shared DAG module (workflow-dag.mjs)
 *
 * Spec: sg-coercive-gate-enforcement
 * Component 1: Shared DAG Module
 *
 * Covers: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-1.7
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs workflow-dag
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The module under test
const MODULE_PATH = join(__dirname, '..', 'lib', 'workflow-dag.mjs');

/**
 * Helper: dynamically import the module, returning null if not yet implemented.
 * This allows tests to be written before implementation exists.
 */
async function loadModule() {
  try {
    const url = new URL(`file://${MODULE_PATH}`);
    return await import(url.href);
  } catch {
    return null;
  }
}

/**
 * Helper: stringify a prerequisite for human-readable matching.
 * Handles both string prerequisites and typed object prerequisites.
 */
function prereqToString(p) {
  if (typeof p === 'string') return p;
  if (typeof p === 'object' && p !== null) {
    return JSON.stringify(p);
  }
  return String(p);
}

/**
 * Helper: check if a prerequisites array contains a reference to a specific
 * subagent type, handling both string and object formats.
 */
function hasPrereqForType(prereqs, subagentType) {
  return prereqs.some((p) => {
    if (typeof p === 'string') return p === subagentType || p.includes(subagentType);
    if (typeof p === 'object' && p !== null) {
      return (
        p.subagent_type === subagentType ||
        p.type === subagentType ||
        JSON.stringify(p).includes(subagentType)
      );
    }
    return false;
  });
}

/**
 * Helper: check if a prerequisites array contains a challenger with a specific stage.
 */
function hasPrereqForChallengerStage(prereqs, stage) {
  return prereqs.some((p) => {
    const str = prereqToString(p);
    return str.includes('challenger') && str.includes(stage);
  });
}

/**
 * Helper: check if a prerequisites array contains a convergence requirement.
 */
function hasPrereqForConvergence(prereqs, gateName) {
  return prereqs.some((p) => {
    const str = prereqToString(p);
    return str.includes('convergence') || str.includes(gateName);
  });
}

// ============================================================
// AC-1.1: Module exports all required constants and functions
// ============================================================

describe('AC-1.1: Module exports all expected constants and functions', () => {
  it('should export ORCHESTRATOR_PREDECESSORS with 14 entries', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const { ORCHESTRATOR_PREDECESSORS } = mod;

    // Assert
    expect(ORCHESTRATOR_PREDECESSORS).toBeDefined();
    expect(typeof ORCHESTRATOR_PREDECESSORS).toBe('object');
    expect(Object.keys(ORCHESTRATOR_PREDECESSORS).length).toBe(14);
  });

  it('should export ONEOFF_SPEC_PREDECESSORS with 12 entries', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const { ONEOFF_SPEC_PREDECESSORS } = mod;

    // Assert
    expect(ONEOFF_SPEC_PREDECESSORS).toBeDefined();
    expect(typeof ONEOFF_SPEC_PREDECESSORS).toBe('object');
    expect(Object.keys(ONEOFF_SPEC_PREDECESSORS).length).toBe(12);
  });

  it('should export EXEMPT_WORKFLOWS as an array containing oneoff-vibe, refactor, journal-only', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const { EXEMPT_WORKFLOWS } = mod;

    // Assert
    expect(Array.isArray(EXEMPT_WORKFLOWS)).toBe(true);
    expect(EXEMPT_WORKFLOWS).toContain('oneoff-vibe');
    expect(EXEMPT_WORKFLOWS).toContain('refactor');
    expect(EXEMPT_WORKFLOWS).toContain('journal-only');
  });

  it('should export VALID_SUBAGENT_TYPES with 22 entries', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const { VALID_SUBAGENT_TYPES } = mod;

    // Assert
    expect(Array.isArray(VALID_SUBAGENT_TYPES)).toBe(true);
    expect(VALID_SUBAGENT_TYPES.length).toBe(22);
  });

  it('should export MANDATORY_DISPATCHES covering mandatory dispatch types', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const { MANDATORY_DISPATCHES } = mod;

    // Assert -- MANDATORY_DISPATCHES is a structured object defining required dispatches per workflow
    expect(MANDATORY_DISPATCHES).toBeDefined();
    const mandatoryStr = JSON.stringify(MANDATORY_DISPATCHES);
    // The 4 mandatory types from the spec: code-reviewer, security-reviewer,
    // completion-verifier, documenter. The structure may use hyphenated or type-field format.
    expect(mandatoryStr).toContain('code-reviewer');
    expect(mandatoryStr).toContain('completion-verifier');
    expect(mandatoryStr).toContain('documenter');
    // Note: security-reviewer may not appear in MANDATORY_DISPATCHES directly
    // because it's enforced via convergence, not dispatch presence.
    // The stop hook separately enforces all 4 mandatory dispatches.
  });

  it('should export REQUIRED_CHALLENGER_STAGES constant', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const { REQUIRED_CHALLENGER_STAGES } = mod;

    // Assert
    expect(REQUIRED_CHALLENGER_STAGES).toBeDefined();
  });

  it('should export all required functions', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Assert
    expect(typeof mod.getWorkflowType).toBe('function');
    expect(typeof mod.getWorkflowTypeStrict).toBe('function');
    expect(typeof mod.isExemptWorkflow).toBe('function');
    expect(typeof mod.getPrerequisites).toBe('function');
    expect(typeof mod.werePrerequisitesMet).toBe('function');
    expect(typeof mod.getPredecessorGraph).toBe('function');
    expect(typeof mod.wasPredecessorVisited).toBe('function');
  });
});

// ============================================================
// AC-1.2: getWorkflowType and getWorkflowTypeStrict
// ============================================================

describe('AC-1.2: getWorkflowType returns correct values', () => {
  it('should return workflow from session.active_work.workflow when present', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    const session = { active_work: { workflow: 'oneoff-spec' } };

    // Act
    const result = mod.getWorkflowType(session);

    // Assert
    expect(result).toBe('oneoff-spec');
  });

  it('should return "orchestrator" as default when workflow is missing', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    const session = { active_work: {} };

    // Act
    const result = mod.getWorkflowType(session);

    // Assert
    expect(result).toBe('orchestrator');
  });

  it('should return "orchestrator" as default when active_work is missing', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    const session = {};

    // Act
    const result = mod.getWorkflowType(session);

    // Assert
    expect(result).toBe('orchestrator');
  });
});

describe('AC-1.2: getWorkflowTypeStrict returns workflow or null', () => {
  it('should return workflow from session.active_work.workflow when present', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    const session = { active_work: { workflow: 'orchestrator' } };

    // Act
    const result = mod.getWorkflowTypeStrict(session);

    // Assert
    expect(result).toBe('orchestrator');
  });

  it('should return null when workflow is missing', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    const session = { active_work: {} };

    // Act
    const result = mod.getWorkflowTypeStrict(session);

    // Assert
    expect(result).toBeNull();
  });

  it('should return null when active_work is missing', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    const session = {};

    // Act
    const result = mod.getWorkflowTypeStrict(session);

    // Assert
    expect(result).toBeNull();
  });
});

// ============================================================
// AC-1.3: isExemptWorkflow
// ============================================================

describe('AC-1.3: isExemptWorkflow identifies exempt workflows', () => {
  it('should return true for "oneoff-vibe"', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act & Assert
    expect(mod.isExemptWorkflow('oneoff-vibe')).toBe(true);
  });

  it('should return true for "refactor"', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act & Assert
    expect(mod.isExemptWorkflow('refactor')).toBe(true);
  });

  it('should return true for "journal-only"', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act & Assert
    expect(mod.isExemptWorkflow('journal-only')).toBe(true);
  });

  it('should return false for "oneoff-spec"', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act & Assert
    expect(mod.isExemptWorkflow('oneoff-spec')).toBe(false);
  });

  it('should return false for "orchestrator"', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act & Assert
    expect(mod.isExemptWorkflow('orchestrator')).toBe(false);
  });

  it('should return false for unknown workflow types', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act & Assert
    expect(mod.isExemptWorkflow('unknown')).toBe(false);
    expect(mod.isExemptWorkflow('')).toBe(false);
  });
});

// ============================================================
// AC-1.4: getPrerequisites returns correct prerequisites
// ============================================================

describe('AC-1.4: getPrerequisites returns correct prerequisites per enforcement table', () => {
  it('should return convergence prerequisites for investigation and challenger gates for implementer in oneoff-spec', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const prereqs = mod.getPrerequisites('oneoff-spec', 'implementer');

    // Assert -- convergence-type prerequisites (WS-4 change)
    expect(Array.isArray(prereqs)).toBe(true);
    expect(prereqs.length).toBe(2);
    expect(hasPrereqForConvergence(prereqs, 'investigation')).toBe(true);
  });

  it('should return convergence prerequisite for challenger gate for implementer in oneoff-spec', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const prereqs = mod.getPrerequisites('oneoff-spec', 'implementer');

    // Assert
    expect(hasPrereqForConvergence(prereqs, 'challenger')).toBe(true);
  });

  it('should return convergence prerequisites for investigation and challenger gates for implementer in orchestrator', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const prereqs = mod.getPrerequisites('orchestrator', 'implementer');

    // Assert -- same convergence-type prerequisites regardless of workflow
    expect(hasPrereqForConvergence(prereqs, 'investigation')).toBe(true);
    expect(hasPrereqForConvergence(prereqs, 'challenger')).toBe(true);
  });

  it('should return empty prerequisites for test-writer (works from spec only, Practice 2.4)', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const prereqs = mod.getPrerequisites('oneoff-spec', 'test-writer');

    // Assert — no coercive prerequisites, test-writer works from spec only
    expect(Array.isArray(prereqs)).toBe(true);
    expect(prereqs.length).toBe(0);
  });

  it('should return prerequisites including unifier and pre-review challenger for code-reviewer', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const prereqs = mod.getPrerequisites('oneoff-spec', 'code-reviewer');

    // Assert
    expect(hasPrereqForType(prereqs, 'unifier')).toBe(true);
    expect(hasPrereqForChallengerStage(prereqs, 'pre-review')).toBe(true);
  });

  it('should return dispatch prerequisites for security-reviewer (same as code-reviewer, parallel execution)', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const prereqs = mod.getPrerequisites('oneoff-spec', 'security-reviewer');

    // Assert — same prerequisites as code-reviewer: challenger pre-review + unifier
    expect(Array.isArray(prereqs)).toBe(true);
    expect(prereqs.length).toBe(2);
    expect(hasPrereqForChallengerStage(prereqs, 'pre-review')).toBe(true);
    expect(hasPrereqForType(prereqs, 'unifier')).toBe(true);
  });

  it('should return both convergence prerequisites for documenter (code_review + security_review)', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const prereqs = mod.getPrerequisites('oneoff-spec', 'documenter');

    // Assert — requires BOTH review convergences since they run in parallel
    expect(Array.isArray(prereqs)).toBe(true);
    expect(prereqs.length).toBe(2);
    expect(hasPrereqForConvergence(prereqs, 'code_review')).toBe(true);
    expect(hasPrereqForConvergence(prereqs, 'security_review')).toBe(true);
  });

  it('should return prerequisites including documenter for completion-verifier', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const prereqs = mod.getPrerequisites('oneoff-spec', 'completion-verifier');

    // Assert
    expect(Array.isArray(prereqs)).toBe(true);
    expect(prereqs.length).toBeGreaterThanOrEqual(1);
    expect(hasPrereqForType(prereqs, 'documenter')).toBe(true);
  });

  it('should return empty array for non-enforced subagent types', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act & Assert
    expect(mod.getPrerequisites('oneoff-spec', 'explore')).toEqual([]);
    expect(mod.getPrerequisites('oneoff-spec', 'spec-author')).toEqual([]);
    expect(mod.getPrerequisites('oneoff-spec', 'atomizer')).toEqual([]);
  });
});

// ============================================================
// AC-1.5: werePrerequisitesMet checks dispatch history
// ============================================================

describe('AC-1.5: werePrerequisitesMet checks dispatch history', () => {
  it('should return met:true when all convergence prerequisites are satisfied for implementer', async () => {
    // Arrange -- implementer now uses convergence-type prerequisites (WS-4 change)
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    const session = {
      subagent_tasks: {
        in_flight: [],
        completed_this_session: [],
      },
      history: [],
      convergence: {
        investigation: { clean_pass_count: 2 },
        challenger: { clean_pass_count: 2 },
      },
    };

    // Get actual prerequisite format
    const prereqs = mod.getPrerequisites('oneoff-spec', 'implementer');

    // Act
    const result = mod.werePrerequisitesMet(session, prereqs);

    // Assert
    expect(result.met).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('should return met:false when prerequisites are not satisfied', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    const session = {
      subagent_tasks: { in_flight: [], completed_this_session: [] },
      history: [],
      convergence: {},
    };

    // Get prerequisites for implementer -- they won't be in the session
    const prereqs = mod.getPrerequisites('oneoff-spec', 'implementer');

    // Act
    const result = mod.werePrerequisitesMet(session, prereqs);

    // Assert
    expect(result.met).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it('should return met:true when prerequisites array is empty', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    const session = { subagent_tasks: [], history: [], convergence: {} };

    // Act
    const result = mod.werePrerequisitesMet(session, []);

    // Assert
    expect(result.met).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('should check convergence counts regardless of dispatch records for implementer', async () => {
    // Arrange -- implementer uses convergence-type prerequisites (WS-4 change)
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    const session = {
      subagent_tasks: {
        in_flight: [{ subagent_type: 'interface-investigator', status: 'running' }],
        completed_this_session: [
          { subagent_type: 'challenger', stage: 'pre-implementation', status: 'completed' },
        ],
      },
      history: [],
      convergence: {
        investigation: { clean_pass_count: 2 },
        challenger: { clean_pass_count: 2 },
      },
    };

    // implementer requires convergence gates for investigation + challenger
    const prereqs = mod.getPrerequisites('oneoff-spec', 'implementer');

    // Act
    const result = mod.werePrerequisitesMet(session, prereqs);

    // Assert — convergence counts satisfy convergence prerequisites
    expect(result.met).toBe(true);
  });

  it('should handle convergence prerequisites correctly (documenter requires both reviews converged)', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    const session = {
      subagent_tasks: [],
      history: [],
      convergence: { code_review: { clean_pass_count: 2 }, security_review: { clean_pass_count: 2 } },
    };

    const prereqs = mod.getPrerequisites('oneoff-spec', 'documenter');

    // Act
    const result = mod.werePrerequisitesMet(session, prereqs);

    // Assert — both reviews converged (>= 2), so should be met
    expect(result.met).toBe(true);
  });

  it('should fail convergence prerequisites when clean_pass_count < 2', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    const session = {
      subagent_tasks: [],
      history: [],
      convergence: { code_review: { clean_pass_count: 2 }, security_review: { clean_pass_count: 1 } },
    };

    const prereqs = mod.getPrerequisites('oneoff-spec', 'documenter');

    // Act
    const result = mod.werePrerequisitesMet(session, prereqs);

    // Assert — security_review has NOT converged (< 2), blocks documenter
    expect(result.met).toBe(false);
  });
});

// ============================================================
// AC-1.7: wasPredecessorVisited handles challenge keys and plain phases
// ============================================================

describe('AC-1.7: wasPredecessorVisited handles challenge keys and plain phases', () => {
  it('should return true for challenging:<stage> key when matching challenger dispatch exists', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    const session = {
      subagent_tasks: {
        in_flight: [],
        completed_this_session: [
          { subagent_type: 'challenger', stage: 'pre-implementation', status: 'completed' },
        ],
      },
      history: [],
    };

    // Act
    const result = mod.wasPredecessorVisited('challenging:pre-implementation', session);

    // Assert
    expect(result).toBe(true);
  });

  it('should return false when challenger with matching stage is not in dispatch history', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    const session = {
      subagent_tasks: {
        in_flight: [],
        completed_this_session: [
          { subagent_type: 'challenger', stage: 'pre-review', status: 'completed' },
        ],
      },
      history: [],
    };

    // Act
    const result = mod.wasPredecessorVisited('challenging:pre-implementation', session);

    // Assert
    expect(result).toBe(false);
  });

  it('should check session history for a plain phase name', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    const session = {
      subagent_tasks: { in_flight: [], completed_this_session: [] },
      history: [
        { event_type: 'phase_transition', details: { to_phase: 'implementation' } },
      ],
    };

    // Act
    const result = mod.wasPredecessorVisited('implementation', session);

    // Assert
    expect(result).toBe(true);
  });

  it('should return false when phase is not in session history', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    const session = {
      subagent_tasks: { in_flight: [], completed_this_session: [] },
      history: [],
    };

    // Act
    const result = mod.wasPredecessorVisited('implementation', session);

    // Assert
    expect(result).toBe(false);
  });
});

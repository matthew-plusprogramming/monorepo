/**
 * Convergence Gate Types for Spec Group Display (AS-008)
 *
 * Defines the gate types, statuses, and data structures for the convergence
 * gate checklist display.
 */

/**
 * Gate status values (AC8.2).
 * - passed: Green check - gate requirement met
 * - failed: Red X - gate requirement failed
 * - pending: Gray circle - gate not yet evaluated
 * - na: Dash - gate not applicable for this spec group
 */
export type GateStatus = 'passed' | 'failed' | 'pending' | 'na';

/**
 * Gate identifiers (AC8.3).
 * These are the quality gates that must pass before state transitions.
 */
export type GateId =
  | 'spec_complete'
  | 'acs_implemented'
  | 'tests_passing'
  | 'unifier'
  | 'code_review'
  | 'security_review'
  | 'browser_tests'
  | 'docs';

/**
 * Display configuration for each gate.
 */
export type GateDisplayConfig = {
  readonly id: GateId;
  readonly label: string;
  readonly description: string;
};

/**
 * Gate detail information for expanded view (AC8.5).
 */
export type GateDetail = {
  /** Type of detail (e.g., 'test_failure', 'review_comment') */
  readonly type: string;
  /** Human-readable message */
  readonly message: string;
  /** Optional file/location reference */
  readonly location?: string;
  /** Optional timestamp */
  readonly timestamp?: string;
  /** Optional severity for failures */
  readonly severity?: 'info' | 'warning' | 'error';
};

/**
 * Individual gate status with optional details.
 */
export type Gate = {
  readonly id: GateId;
  readonly status: GateStatus;
  /** Details shown when gate is expanded (AC8.5) */
  readonly details?: readonly GateDetail[];
  /** Last update timestamp */
  readonly updatedAt?: string;
};

/**
 * Complete convergence gate state for a spec group.
 */
export type ConvergenceGateState = {
  readonly specGroupId: string;
  readonly gates: readonly Gate[];
  /** Whether all required gates have passed */
  readonly allGatesPassed: boolean;
  /** Last update timestamp */
  readonly updatedAt: string;
};

/**
 * Gate display configuration - defines label and description for each gate.
 */
export const GATE_DISPLAY_CONFIG: Record<GateId, GateDisplayConfig> = {
  spec_complete: {
    id: 'spec_complete',
    label: 'Spec complete',
    description: 'All specification sections are filled out and approved',
  },
  acs_implemented: {
    id: 'acs_implemented',
    label: 'ACs implemented',
    description: 'All acceptance criteria have been implemented',
  },
  tests_passing: {
    id: 'tests_passing',
    label: 'Tests passing',
    description: 'All unit and integration tests pass',
  },
  unifier: {
    id: 'unifier',
    label: 'Unifier',
    description: 'Spec-implementation-test alignment validated',
  },
  code_review: {
    id: 'code_review',
    label: 'Code review',
    description: 'Code review completed with no blocking issues',
  },
  security_review: {
    id: 'security_review',
    label: 'Security review',
    description: 'Security review passed',
  },
  browser_tests: {
    id: 'browser_tests',
    label: 'Browser tests',
    description: 'UI browser tests pass (if applicable)',
  },
  docs: {
    id: 'docs',
    label: 'Docs',
    description: 'Documentation generated and reviewed',
  },
} as const;

/**
 * Default gate order for display.
 */
export const GATE_ORDER: readonly GateId[] = [
  'spec_complete',
  'acs_implemented',
  'tests_passing',
  'unifier',
  'code_review',
  'security_review',
  'browser_tests',
  'docs',
] as const;

/**
 * Check if all required gates have passed.
 * N/A gates are not considered blockers.
 */
export const checkAllGatesPassed = (gates: readonly Gate[]): boolean => {
  return gates.every((gate) => gate.status === 'passed' || gate.status === 'na');
};

/**
 * Create default gates with pending status.
 */
export const createDefaultGates = (): readonly Gate[] => {
  return GATE_ORDER.map((id) => ({
    id,
    status: 'pending' as GateStatus,
  }));
};

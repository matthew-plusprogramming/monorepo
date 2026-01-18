/**
 * Spec Group State Machine Types
 *
 * Defines the states and transitions for spec group lifecycle management.
 * State transitions follow a linear progression with validation requirements.
 */

/**
 * Valid states for a spec group in the lifecycle.
 *
 * State Progression:
 * DRAFT -> REVIEWED -> APPROVED -> IN_PROGRESS -> CONVERGED -> MERGED
 */
export const SpecGroupState = {
  DRAFT: 'DRAFT',
  REVIEWED: 'REVIEWED',
  APPROVED: 'APPROVED',
  IN_PROGRESS: 'IN_PROGRESS',
  CONVERGED: 'CONVERGED',
  MERGED: 'MERGED',
} as const;

export type SpecGroupStateType =
  (typeof SpecGroupState)[keyof typeof SpecGroupState];

/**
 * Represents a single entry in the decision log for state transitions.
 */
export type DecisionLogEntry = {
  readonly timestamp: string;
  readonly actor: string;
  readonly action: 'STATE_TRANSITION';
  readonly fromState: SpecGroupStateType;
  readonly toState: SpecGroupStateType;
  readonly reason?: string;
};

/**
 * Represents a spec group entity in DynamoDB.
 */
export type SpecGroup = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly state: SpecGroupStateType;
  readonly decisionLog: readonly DecisionLogEntry[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string;
  readonly sectionsCompleted?: boolean;
  readonly allGatesPassed?: boolean;
  readonly prMerged?: boolean;
};

/**
 * Input for creating a new spec group.
 */
export type CreateSpecGroupInput = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly createdBy: string;
};

/**
 * Input for transitioning a spec group to a new state.
 */
export type TransitionStateInput = {
  readonly specGroupId: string;
  readonly toState: SpecGroupStateType;
  readonly actor: string;
  readonly reason?: string;
};

/**
 * Result of a state transition validation.
 */
export type TransitionValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/**
 * Defines a valid transition with its preconditions.
 */
export type TransitionDefinition = {
  readonly from: SpecGroupStateType;
  readonly to: SpecGroupStateType;
  readonly precondition?: (specGroup: SpecGroup) => TransitionValidationResult;
  readonly description: string;
};

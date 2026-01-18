/**
 * Spec Group State Machine
 *
 * Implements the state machine logic for spec group lifecycle transitions.
 * Validates transitions and enforces preconditions.
 */

import {
  SpecGroupState,
  type SpecGroup,
  type SpecGroupStateType,
  type TransitionDefinition,
  type TransitionValidationResult,
} from './types.js';

/**
 * Defines all valid state transitions with their preconditions.
 */
export const TRANSITION_DEFINITIONS: readonly TransitionDefinition[] = [
  {
    from: SpecGroupState.DRAFT,
    to: SpecGroupState.REVIEWED,
    description: 'Mark spec group as reviewed',
    precondition: (specGroup: SpecGroup): TransitionValidationResult => {
      if (specGroup.sectionsCompleted !== true) {
        return {
          valid: false,
          reason: 'All sections must be completed before review',
        };
      }
      return { valid: true };
    },
  },
  {
    from: SpecGroupState.REVIEWED,
    to: SpecGroupState.APPROVED,
    description: 'Approve spec group for implementation',
  },
  {
    from: SpecGroupState.APPROVED,
    to: SpecGroupState.IN_PROGRESS,
    description: 'Start implementation',
  },
  {
    from: SpecGroupState.IN_PROGRESS,
    to: SpecGroupState.CONVERGED,
    description: 'Mark implementation as converged',
    precondition: (specGroup: SpecGroup): TransitionValidationResult => {
      if (specGroup.allGatesPassed !== true) {
        return {
          valid: false,
          reason: 'All gates must pass before convergence',
        };
      }
      return { valid: true };
    },
  },
  {
    from: SpecGroupState.CONVERGED,
    to: SpecGroupState.MERGED,
    description: 'Mark PR as merged',
    precondition: (specGroup: SpecGroup): TransitionValidationResult => {
      if (specGroup.prMerged !== true) {
        return {
          valid: false,
          reason: 'PR must be merged before finalizing',
        };
      }
      return { valid: true };
    },
  },
] as const;

/**
 * Get the valid next states from a given state.
 */
export const getValidNextStates = (
  currentState: SpecGroupStateType,
): readonly SpecGroupStateType[] => {
  return TRANSITION_DEFINITIONS.filter((def) => def.from === currentState).map(
    (def) => def.to,
  );
};

/**
 * Get the transition definition for a given from/to pair.
 */
export const getTransitionDefinition = (
  fromState: SpecGroupStateType,
  toState: SpecGroupStateType,
): TransitionDefinition | undefined => {
  return TRANSITION_DEFINITIONS.find(
    (def) => def.from === fromState && def.to === toState,
  );
};

/**
 * Check if a transition is structurally valid (exists in the state machine).
 */
export const isTransitionValid = (
  fromState: SpecGroupStateType,
  toState: SpecGroupStateType,
): boolean => {
  return getTransitionDefinition(fromState, toState) !== undefined;
};

/**
 * Validate a state transition including preconditions.
 *
 * @param specGroup - The spec group to transition
 * @param toState - The target state
 * @returns Validation result with success or failure reason
 */
export const validateTransition = (
  specGroup: SpecGroup,
  toState: SpecGroupStateType,
): TransitionValidationResult => {
  const fromState = specGroup.state;

  // Check if transition is valid in the state machine
  const definition = getTransitionDefinition(fromState, toState);
  if (!definition) {
    const validNextStates = getValidNextStates(fromState);
    const validStatesStr =
      validNextStates.length > 0 ? validNextStates.join(', ') : 'none';
    return {
      valid: false,
      reason: `Invalid transition from ${fromState} to ${toState}. Valid transitions from ${fromState}: ${validStatesStr}`,
    };
  }

  // Check preconditions if any
  if (definition.precondition) {
    return definition.precondition(specGroup);
  }

  return { valid: true };
};

/**
 * Get available transitions for a spec group with their validity status.
 */
export const getAvailableTransitions = (
  specGroup: SpecGroup,
): readonly {
  readonly toState: SpecGroupStateType;
  readonly description: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
}[] => {
  return TRANSITION_DEFINITIONS.filter(
    (def) => def.from === specGroup.state,
  ).map((def) => {
    const validation = def.precondition
      ? def.precondition(specGroup)
      : ({ valid: true } as const);

    return {
      toState: def.to,
      description: def.description,
      enabled: validation.valid,
      disabledReason: !validation.valid ? validation.reason : undefined,
    };
  });
};

/**
 * State display configuration for UI badges.
 */
export const STATE_DISPLAY_CONFIG: Record<
  SpecGroupStateType,
  {
    readonly label: string;
    readonly color: 'gray' | 'blue' | 'green' | 'yellow' | 'purple' | 'emerald';
  }
> = {
  [SpecGroupState.DRAFT]: { label: 'Draft', color: 'gray' },
  [SpecGroupState.REVIEWED]: { label: 'Reviewed', color: 'blue' },
  [SpecGroupState.APPROVED]: { label: 'Approved', color: 'green' },
  [SpecGroupState.IN_PROGRESS]: { label: 'In Progress', color: 'yellow' },
  [SpecGroupState.CONVERGED]: { label: 'Converged', color: 'purple' },
  [SpecGroupState.MERGED]: { label: 'Merged', color: 'emerald' },
};

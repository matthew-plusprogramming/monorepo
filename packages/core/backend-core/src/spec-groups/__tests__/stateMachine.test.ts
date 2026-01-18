/**
 * State Machine Tests
 *
 * Tests for spec group state machine transition logic.
 * Covers AC3.2, AC3.3, AC3.4 - transition validation and button enable/disable logic.
 */

import { describe, expect, it } from 'vitest';

import {
  getAvailableTransitions,
  getTransitionDefinition,
  getValidNextStates,
  isTransitionValid,
  STATE_DISPLAY_CONFIG,
  TRANSITION_DEFINITIONS,
  validateTransition,
} from '../stateMachine.js';
import { SpecGroupState, type SpecGroup } from '../types.js';

/**
 * Helper to create a mock spec group.
 */
const createMockSpecGroup = (
  overrides: Partial<SpecGroup> = {},
): SpecGroup => ({
  id: 'test-spec-group-id',
  name: 'Test Spec Group',
  description: 'A test spec group',
  state: SpecGroupState.DRAFT,
  decisionLog: [],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'test-user',
  sectionsCompleted: false,
  allGatesPassed: false,
  prMerged: false,
  ...overrides,
});

describe('stateMachine', () => {
  describe('TRANSITION_DEFINITIONS', () => {
    it('defines exactly 5 valid transitions', () => {
      expect(TRANSITION_DEFINITIONS).toHaveLength(5);
    });

    it('defines transitions in correct order', () => {
      const transitions = TRANSITION_DEFINITIONS.map(
        (def) => `${def.from} -> ${def.to}`,
      );
      expect(transitions).toEqual([
        'DRAFT -> REVIEWED',
        'REVIEWED -> APPROVED',
        'APPROVED -> IN_PROGRESS',
        'IN_PROGRESS -> CONVERGED',
        'CONVERGED -> MERGED',
      ]);
    });
  });

  describe('getValidNextStates', () => {
    it('returns REVIEWED as the only valid next state from DRAFT', () => {
      const nextStates = getValidNextStates(SpecGroupState.DRAFT);
      expect(nextStates).toEqual([SpecGroupState.REVIEWED]);
    });

    it('returns APPROVED as the only valid next state from REVIEWED', () => {
      const nextStates = getValidNextStates(SpecGroupState.REVIEWED);
      expect(nextStates).toEqual([SpecGroupState.APPROVED]);
    });

    it('returns IN_PROGRESS as the only valid next state from APPROVED', () => {
      const nextStates = getValidNextStates(SpecGroupState.APPROVED);
      expect(nextStates).toEqual([SpecGroupState.IN_PROGRESS]);
    });

    it('returns CONVERGED as the only valid next state from IN_PROGRESS', () => {
      const nextStates = getValidNextStates(SpecGroupState.IN_PROGRESS);
      expect(nextStates).toEqual([SpecGroupState.CONVERGED]);
    });

    it('returns MERGED as the only valid next state from CONVERGED', () => {
      const nextStates = getValidNextStates(SpecGroupState.CONVERGED);
      expect(nextStates).toEqual([SpecGroupState.MERGED]);
    });

    it('returns empty array for MERGED (terminal state)', () => {
      const nextStates = getValidNextStates(SpecGroupState.MERGED);
      expect(nextStates).toEqual([]);
    });
  });

  describe('getTransitionDefinition', () => {
    it('returns definition for valid transition', () => {
      const def = getTransitionDefinition(
        SpecGroupState.DRAFT,
        SpecGroupState.REVIEWED,
      );
      expect(def).toBeDefined();
      expect(def?.from).toBe(SpecGroupState.DRAFT);
      expect(def?.to).toBe(SpecGroupState.REVIEWED);
      expect(def?.description).toBe('Mark spec group as reviewed');
    });

    it('returns undefined for invalid transition', () => {
      const def = getTransitionDefinition(
        SpecGroupState.DRAFT,
        SpecGroupState.APPROVED,
      );
      expect(def).toBeUndefined();
    });

    it('returns undefined for backward transition', () => {
      const def = getTransitionDefinition(
        SpecGroupState.REVIEWED,
        SpecGroupState.DRAFT,
      );
      expect(def).toBeUndefined();
    });
  });

  describe('isTransitionValid', () => {
    it('returns true for valid forward transition', () => {
      expect(
        isTransitionValid(SpecGroupState.DRAFT, SpecGroupState.REVIEWED),
      ).toBe(true);
    });

    it('returns false for skipping states', () => {
      expect(
        isTransitionValid(SpecGroupState.DRAFT, SpecGroupState.APPROVED),
      ).toBe(false);
    });

    it('returns false for backward transition', () => {
      expect(
        isTransitionValid(SpecGroupState.REVIEWED, SpecGroupState.DRAFT),
      ).toBe(false);
    });

    it('returns false for same state transition', () => {
      expect(
        isTransitionValid(SpecGroupState.DRAFT, SpecGroupState.DRAFT),
      ).toBe(false);
    });
  });

  describe('validateTransition', () => {
    describe('DRAFT -> REVIEWED transition', () => {
      it('fails when sections are not completed', () => {
        const specGroup = createMockSpecGroup({
          state: SpecGroupState.DRAFT,
          sectionsCompleted: false,
        });

        const result = validateTransition(specGroup, SpecGroupState.REVIEWED);

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(
            'All sections must be completed before review',
          );
        }
      });

      it('succeeds when sections are completed', () => {
        const specGroup = createMockSpecGroup({
          state: SpecGroupState.DRAFT,
          sectionsCompleted: true,
        });

        const result = validateTransition(specGroup, SpecGroupState.REVIEWED);

        expect(result.valid).toBe(true);
      });
    });

    describe('REVIEWED -> APPROVED transition', () => {
      it('succeeds without preconditions', () => {
        const specGroup = createMockSpecGroup({
          state: SpecGroupState.REVIEWED,
        });

        const result = validateTransition(specGroup, SpecGroupState.APPROVED);

        expect(result.valid).toBe(true);
      });
    });

    describe('APPROVED -> IN_PROGRESS transition', () => {
      it('succeeds without preconditions', () => {
        const specGroup = createMockSpecGroup({
          state: SpecGroupState.APPROVED,
        });

        const result = validateTransition(
          specGroup,
          SpecGroupState.IN_PROGRESS,
        );

        expect(result.valid).toBe(true);
      });
    });

    describe('IN_PROGRESS -> CONVERGED transition', () => {
      it('fails when gates have not passed', () => {
        const specGroup = createMockSpecGroup({
          state: SpecGroupState.IN_PROGRESS,
          allGatesPassed: false,
        });

        const result = validateTransition(specGroup, SpecGroupState.CONVERGED);

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(
            'All gates must pass before convergence',
          );
        }
      });

      it('succeeds when all gates have passed', () => {
        const specGroup = createMockSpecGroup({
          state: SpecGroupState.IN_PROGRESS,
          allGatesPassed: true,
        });

        const result = validateTransition(specGroup, SpecGroupState.CONVERGED);

        expect(result.valid).toBe(true);
      });
    });

    describe('CONVERGED -> MERGED transition', () => {
      it('fails when PR is not merged', () => {
        const specGroup = createMockSpecGroup({
          state: SpecGroupState.CONVERGED,
          prMerged: false,
        });

        const result = validateTransition(specGroup, SpecGroupState.MERGED);

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe('PR must be merged before finalizing');
        }
      });

      it('succeeds when PR is merged', () => {
        const specGroup = createMockSpecGroup({
          state: SpecGroupState.CONVERGED,
          prMerged: true,
        });

        const result = validateTransition(specGroup, SpecGroupState.MERGED);

        expect(result.valid).toBe(true);
      });
    });

    describe('invalid transitions', () => {
      it('fails for skipping states', () => {
        const specGroup = createMockSpecGroup({
          state: SpecGroupState.DRAFT,
          sectionsCompleted: true,
        });

        const result = validateTransition(specGroup, SpecGroupState.APPROVED);

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toContain('Invalid transition from DRAFT to APPROVED');
        }
      });

      it('fails for backward transitions', () => {
        const specGroup = createMockSpecGroup({
          state: SpecGroupState.REVIEWED,
        });

        const result = validateTransition(specGroup, SpecGroupState.DRAFT);

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toContain('Invalid transition from REVIEWED to DRAFT');
        }
      });

      it('includes valid transitions in error message', () => {
        const specGroup = createMockSpecGroup({
          state: SpecGroupState.REVIEWED,
        });

        const result = validateTransition(specGroup, SpecGroupState.MERGED);

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toContain('Valid transitions from REVIEWED: APPROVED');
        }
      });

      it('shows none for terminal state', () => {
        const specGroup = createMockSpecGroup({
          state: SpecGroupState.MERGED,
        });

        const result = validateTransition(specGroup, SpecGroupState.DRAFT);

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toContain('Valid transitions from MERGED: none');
        }
      });
    });
  });

  describe('getAvailableTransitions (AC3.2, AC3.3, AC3.4)', () => {
    it('returns enabled transition when preconditions are met', () => {
      const specGroup = createMockSpecGroup({
        state: SpecGroupState.DRAFT,
        sectionsCompleted: true,
      });

      const transitions = getAvailableTransitions(specGroup);

      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toEqual({
        toState: SpecGroupState.REVIEWED,
        description: 'Mark spec group as reviewed',
        enabled: true,
        disabledReason: undefined,
      });
    });

    it('returns disabled transition with reason when preconditions fail', () => {
      const specGroup = createMockSpecGroup({
        state: SpecGroupState.DRAFT,
        sectionsCompleted: false,
      });

      const transitions = getAvailableTransitions(specGroup);

      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toEqual({
        toState: SpecGroupState.REVIEWED,
        description: 'Mark spec group as reviewed',
        enabled: false,
        disabledReason: 'All sections must be completed before review',
      });
    });

    it('returns empty array for terminal state', () => {
      const specGroup = createMockSpecGroup({
        state: SpecGroupState.MERGED,
      });

      const transitions = getAvailableTransitions(specGroup);

      expect(transitions).toHaveLength(0);
    });

    it('returns enabled transition for states without preconditions', () => {
      const specGroup = createMockSpecGroup({
        state: SpecGroupState.REVIEWED,
      });

      const transitions = getAvailableTransitions(specGroup);

      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toEqual({
        toState: SpecGroupState.APPROVED,
        description: 'Approve spec group for implementation',
        enabled: true,
        disabledReason: undefined,
      });
    });
  });

  describe('STATE_DISPLAY_CONFIG (AC3.1)', () => {
    it('defines display config for all states', () => {
      expect(Object.keys(STATE_DISPLAY_CONFIG)).toHaveLength(6);
    });

    it('provides correct labels', () => {
      expect(STATE_DISPLAY_CONFIG[SpecGroupState.DRAFT].label).toBe('Draft');
      expect(STATE_DISPLAY_CONFIG[SpecGroupState.REVIEWED].label).toBe(
        'Reviewed',
      );
      expect(STATE_DISPLAY_CONFIG[SpecGroupState.APPROVED].label).toBe(
        'Approved',
      );
      expect(STATE_DISPLAY_CONFIG[SpecGroupState.IN_PROGRESS].label).toBe(
        'In Progress',
      );
      expect(STATE_DISPLAY_CONFIG[SpecGroupState.CONVERGED].label).toBe(
        'Converged',
      );
      expect(STATE_DISPLAY_CONFIG[SpecGroupState.MERGED].label).toBe('Merged');
    });

    it('provides distinct colors for each state', () => {
      const colors = Object.values(STATE_DISPLAY_CONFIG).map((c) => c.color);
      expect(colors).toEqual([
        'gray',
        'blue',
        'green',
        'yellow',
        'purple',
        'emerald',
      ]);
    });
  });
});

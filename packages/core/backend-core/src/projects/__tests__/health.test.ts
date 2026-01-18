import { describe, expect, it } from 'vitest';

import type { SpecGroup } from '../../spec-groups/types.js';
import {
  calculateHealthFromSpecGroups,
  calculateProjectHealth,
  calculateSpecGroupSummary,
} from '../health.js';
import type { SpecGroupSummary } from '../types.js';

const createMockSpecGroup = (
  overrides: Partial<SpecGroup> = {},
): SpecGroup => ({
  id: 'sg-test-001',
  name: 'Test Spec Group',
  state: 'DRAFT',
  decisionLog: [],
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  createdBy: 'user-1',
  sectionsCompleted: false,
  allGatesPassed: false,
  prMerged: false,
  ...overrides,
});

describe('calculateSpecGroupSummary', () => {
  it('returns correct counts for empty array', () => {
    const summary = calculateSpecGroupSummary([]);

    expect(summary.total).toBe(0);
    expect(summary.allGatesPassed).toBe(0);
    expect(summary.criticalGatesFailed).toBe(0);
    expect(summary.byState).toEqual({});
  });

  it('counts spec groups by state correctly', () => {
    const specGroups = [
      createMockSpecGroup({ state: 'DRAFT' }),
      createMockSpecGroup({ state: 'DRAFT' }),
      createMockSpecGroup({ state: 'IN_PROGRESS' }),
      createMockSpecGroup({ state: 'MERGED' }),
    ];

    const summary = calculateSpecGroupSummary(specGroups);

    expect(summary.total).toBe(4);
    expect(summary.byState.DRAFT).toBe(2);
    expect(summary.byState.IN_PROGRESS).toBe(1);
    expect(summary.byState.MERGED).toBe(1);
  });

  it('counts all gates passed correctly', () => {
    const specGroups = [
      createMockSpecGroup({ allGatesPassed: true }),
      createMockSpecGroup({ allGatesPassed: true }),
      createMockSpecGroup({ allGatesPassed: false }),
    ];

    const summary = calculateSpecGroupSummary(specGroups);

    expect(summary.allGatesPassed).toBe(2);
  });

  it('counts critical gates failed correctly', () => {
    const specGroups = [
      createMockSpecGroup({ state: 'DRAFT', sectionsCompleted: false }),
      createMockSpecGroup({ state: 'REVIEWED', sectionsCompleted: false }),
      createMockSpecGroup({ state: 'IN_PROGRESS', sectionsCompleted: false }),
    ];

    const summary = calculateSpecGroupSummary(specGroups);

    // Only DRAFT and REVIEWED are blocked states without sections completed
    expect(summary.criticalGatesFailed).toBe(2);
  });
});

describe('calculateProjectHealth', () => {
  describe('AC1.3: Health calculation based on convergence gates', () => {
    it('returns green when all gates pass', () => {
      const summary: SpecGroupSummary = {
        total: 3,
        byState: { MERGED: 3 },
        allGatesPassed: 3,
        criticalGatesFailed: 0,
      };

      expect(calculateProjectHealth(summary)).toBe('green');
    });

    it('returns green for empty project', () => {
      const summary: SpecGroupSummary = {
        total: 0,
        byState: {},
        allGatesPassed: 0,
        criticalGatesFailed: 0,
      };

      expect(calculateProjectHealth(summary)).toBe('green');
    });

    it('returns yellow when some gates pass', () => {
      const summary: SpecGroupSummary = {
        total: 4,
        byState: { MERGED: 2, IN_PROGRESS: 2 },
        allGatesPassed: 2,
        criticalGatesFailed: 0,
      };

      expect(calculateProjectHealth(summary)).toBe('yellow');
    });

    it('returns yellow when projects are in progress', () => {
      const summary: SpecGroupSummary = {
        total: 2,
        byState: { IN_PROGRESS: 2 },
        allGatesPassed: 0,
        criticalGatesFailed: 0,
      };

      expect(calculateProjectHealth(summary)).toBe('yellow');
    });

    it('returns yellow when projects are approved', () => {
      const summary: SpecGroupSummary = {
        total: 2,
        byState: { APPROVED: 2 },
        allGatesPassed: 0,
        criticalGatesFailed: 0,
      };

      expect(calculateProjectHealth(summary)).toBe('yellow');
    });

    it('returns yellow when some projects are converged', () => {
      const summary: SpecGroupSummary = {
        total: 3,
        byState: { CONVERGED: 1, DRAFT: 2 },
        allGatesPassed: 0,
        criticalGatesFailed: 2,
      };

      expect(calculateProjectHealth(summary)).toBe('yellow');
    });

    it('returns red when majority have critical failures', () => {
      const summary: SpecGroupSummary = {
        total: 4,
        byState: { DRAFT: 4 },
        allGatesPassed: 0,
        criticalGatesFailed: 3,
      };

      expect(calculateProjectHealth(summary)).toBe('red');
    });
  });
});

describe('calculateHealthFromSpecGroups', () => {
  it('calculates health directly from spec groups', () => {
    const specGroups = [
      createMockSpecGroup({ state: 'MERGED', allGatesPassed: true }),
      createMockSpecGroup({ state: 'MERGED', allGatesPassed: true }),
    ];

    expect(calculateHealthFromSpecGroups(specGroups)).toBe('green');
  });

  it('returns green for empty spec groups', () => {
    expect(calculateHealthFromSpecGroups([])).toBe('green');
  });

  it('returns yellow for mixed states', () => {
    const specGroups = [
      createMockSpecGroup({ state: 'MERGED', allGatesPassed: true }),
      createMockSpecGroup({ state: 'IN_PROGRESS', allGatesPassed: false }),
    ];

    expect(calculateHealthFromSpecGroups(specGroups)).toBe('yellow');
  });
});

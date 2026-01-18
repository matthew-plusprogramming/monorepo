/**
 * Project Health Calculation (AS-001, AC1.3)
 *
 * Calculates project health based on convergence gates:
 * - Green: All gates pass
 * - Yellow: Some gates pass (partial progress)
 * - Red: Critical gates fail (no progress or blocked)
 */

import type { SpecGroup, SpecGroupStateType } from '../spec-groups/types.js';
import type { ProjectHealth, SpecGroupSummary } from './types.js';

/**
 * States considered as "progressing" (not blocked).
 */
const PROGRESSING_STATES: readonly SpecGroupStateType[] = [
  'IN_PROGRESS',
  'CONVERGED',
  'MERGED',
];

/**
 * States considered as "completed" (gates passed).
 */
const COMPLETED_STATES: readonly SpecGroupStateType[] = ['CONVERGED', 'MERGED'];

/**
 * States considered as "blocked" or "not started".
 */
const BLOCKED_STATES: readonly SpecGroupStateType[] = ['DRAFT', 'REVIEWED'];

/**
 * Calculate the spec group summary from a list of spec groups.
 */
export const calculateSpecGroupSummary = (
  specGroups: readonly SpecGroup[],
): SpecGroupSummary => {
  const byState: Partial<Record<SpecGroupStateType, number>> = {};
  let allGatesPassed = 0;
  let criticalGatesFailed = 0;

  for (const sg of specGroups) {
    byState[sg.state] = (byState[sg.state] ?? 0) + 1;

    // Count spec groups where all gates passed
    if (sg.allGatesPassed) {
      allGatesPassed++;
    }

    // Count spec groups with critical failures (in blocked states without progress)
    if (BLOCKED_STATES.includes(sg.state) && !sg.sectionsCompleted) {
      criticalGatesFailed++;
    }
  }

  return {
    total: specGroups.length,
    byState,
    allGatesPassed,
    criticalGatesFailed,
  };
};

/**
 * Calculate project health from spec group summary (AC1.3).
 *
 * Health calculation logic:
 * - Green: All spec groups have passed gates (allGatesPassed === total)
 * - Yellow: Some spec groups are progressing (at least one in IN_PROGRESS, CONVERGED, or APPROVED)
 * - Red: No progress or all blocked
 */
export const calculateProjectHealth = (
  summary: SpecGroupSummary,
): ProjectHealth => {
  const { total, byState, allGatesPassed, criticalGatesFailed } = summary;

  // No spec groups - considered healthy (empty project)
  if (total === 0) {
    return 'green';
  }

  // All gates passed - project is healthy
  if (allGatesPassed === total) {
    return 'green';
  }

  // Check for any progressing or approved spec groups
  const progressingCount = PROGRESSING_STATES.reduce(
    (acc, state) => acc + (byState[state] ?? 0),
    0,
  );

  const approvedCount = byState['APPROVED'] ?? 0;
  const mergedCount = byState['MERGED'] ?? 0;
  const convergedCount = byState['CONVERGED'] ?? 0;

  // If we have merged or converged specs, or active progress, it's yellow
  if (mergedCount > 0 || convergedCount > 0 || progressingCount > 0 || approvedCount > 0) {
    return 'yellow';
  }

  // If we have some gates passed but not all, it's yellow
  if (allGatesPassed > 0) {
    return 'yellow';
  }

  // If majority are in blocked states with critical failures, it's red
  if (criticalGatesFailed > total / 2) {
    return 'red';
  }

  // Default to yellow for partial progress
  return 'yellow';
};

/**
 * Calculate project health directly from spec groups.
 */
export const calculateHealthFromSpecGroups = (
  specGroups: readonly SpecGroup[],
): ProjectHealth => {
  const summary = calculateSpecGroupSummary(specGroups);
  return calculateProjectHealth(summary);
};

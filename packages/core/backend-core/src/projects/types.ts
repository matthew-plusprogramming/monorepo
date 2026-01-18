/**
 * Project Types (AS-001)
 *
 * Defines types for project entities displayed on the dashboard.
 */

import type { SpecGroupStateType } from '../spec-groups/types.js';

/**
 * Health status for a project based on convergence gates (AC1.3).
 */
export type ProjectHealth = 'green' | 'yellow' | 'red';

/**
 * Summary of spec groups within a project.
 */
export type SpecGroupSummary = {
  readonly total: number;
  readonly byState: Partial<Record<SpecGroupStateType, number>>;
  readonly allGatesPassed: number;
  readonly criticalGatesFailed: number;
};

/**
 * Represents a project entity for the dashboard.
 */
export type Project = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly status: 'active' | 'archived' | 'draft';
  readonly health: ProjectHealth;
  readonly specGroupCount: number;
  readonly specGroupSummary: SpecGroupSummary;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/**
 * Input for creating a new project.
 */
export type CreateProjectInput = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
};

/**
 * Response for listing projects.
 */
export type ListProjectsResponse = {
  readonly projects: readonly Project[];
  readonly total: number;
};

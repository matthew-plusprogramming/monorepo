/**
 * Project Repository (AS-001)
 *
 * Provides operations for listing projects with spec group counts and health.
 * Projects are derived from spec groups - each unique projectId in spec groups
 * represents a project.
 */

import type {
  AttributeValue,
  ScanCommandInput,
} from '@aws-sdk/client-dynamodb';
import { Context, Effect, Option } from 'effect';

import { DynamoDbService } from '../services/dynamodb.js';
import {
  SpecGroupState,
  type SpecGroup,
  type SpecGroupStateType,
} from '../spec-groups/types.js';
import { InternalServerError } from '../types/errors/http.js';

import { ProjectNotFoundError } from './errors.js';
import {
  calculateHealthFromSpecGroups,
  calculateSpecGroupSummary,
} from './health.js';
import type { ListProjectsResponse, Project } from './types.js';

/**
 * Schema for the ProjectRepository service.
 */
export type ProjectRepositorySchema = {
  readonly list: () => Effect.Effect<
    ListProjectsResponse,
    InternalServerError,
    DynamoDbService
  >;

  readonly getById: (
    id: string,
  ) => Effect.Effect<
    Option.Option<Project>,
    InternalServerError,
    DynamoDbService
  >;
};

export class ProjectRepository extends Context.Tag('ProjectRepository')<
  ProjectRepository,
  ProjectRepositorySchema
>() {}

/**
 * Table name for projects (uses same table as spec groups with GSI).
 */
const SPEC_GROUPS_TABLE_NAME =
  process.env.SPEC_GROUPS_TABLE_NAME ?? 'SpecGroups';
const PROJECTS_TABLE_NAME = process.env.PROJECTS_TABLE_NAME ?? 'Projects';

/**
 * Allowlist of valid project statuses (AC3.1).
 * Derived from the Project['status'] type definition.
 */
const VALID_PROJECT_STATUSES: readonly Project['status'][] = [
  'active',
  'archived',
  'draft',
] as const;

/**
 * Allowlist of valid spec group states (AC3.4).
 * Derived from the SpecGroupState const object.
 */
const VALID_SPEC_GROUP_STATES: readonly SpecGroupStateType[] = Object.values(
  SpecGroupState,
) as SpecGroupStateType[];

/**
 * Convert a DynamoDB item to a SpecGroup (for aggregation).
 */
const itemToSpecGroup = (
  item: Record<string, AttributeValue>,
): SpecGroup | undefined => {
  const id = item.id?.S;
  const name = item.name?.S;
  const rawState = item.state?.S;
  const state: SpecGroupStateType | undefined =
    rawState && VALID_SPEC_GROUP_STATES.includes(rawState as SpecGroupStateType)
      ? (rawState as SpecGroupStateType)
      : undefined;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;
  const createdBy = item.createdBy?.S;

  if (!id || !name || !state || !createdAt || !updatedAt || !createdBy) {
    return undefined;
  }

  return {
    id,
    name,
    description: item.description?.S,
    state,
    decisionLog: [],
    createdAt,
    updatedAt,
    createdBy,
    sectionsCompleted: item.sectionsCompleted?.BOOL,
    allGatesPassed: item.allGatesPassed?.BOOL,
    prMerged: item.prMerged?.BOOL,
  };
};

/**
 * Convert a DynamoDB item to a Project.
 */
const itemToProject = (
  item: Record<string, AttributeValue>,
): Project | undefined => {
  const id = item.id?.S;
  const name = item.name?.S;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;

  if (!id || !name || !createdAt || !updatedAt) {
    return undefined;
  }

  return {
    id,
    name,
    description: item.description?.S,
    status: VALID_PROJECT_STATUSES.includes(item.status?.S as Project['status'])
      ? (item.status!.S as Project['status'])
      : 'active',
    health: 'green',
    specGroupCount: 0,
    specGroupSummary: {
      total: 0,
      byState: {},
      allGatesPassed: 0,
      criticalGatesFailed: 0,
    },
    createdAt,
    updatedAt,
  };
};

/**
 * Aggregate spec groups by project and calculate health.
 */
const aggregateByProject = (
  specGroups: readonly SpecGroup[],
  projects: readonly Project[],
): Project[] => {
  // Create a map of projectId -> spec groups
  const projectSpecGroups = new Map<string, SpecGroup[]>();

  // For now, use spec group id prefix as project id (e.g., "sg-my-project-001" -> "my-project")
  // In production, spec groups would have an explicit projectId field
  for (const sg of specGroups) {
    // Extract project id from spec group naming convention: sg-{projectId}-{number}
    const match = sg.id.match(/^sg-(.+?)-\d+$/);
    const projectId = match?.[1] ?? sg.id;

    const existing = projectSpecGroups.get(projectId) ?? [];
    existing.push(sg);
    projectSpecGroups.set(projectId, existing);
  }

  // Build project list with calculated health
  const result: Project[] = [];

  // First, add projects from the Projects table
  for (const project of projects) {
    const sgs = projectSpecGroups.get(project.id) ?? [];
    const summary = calculateSpecGroupSummary(sgs);
    const health = calculateHealthFromSpecGroups(sgs);

    result.push({
      ...project,
      health,
      specGroupCount: sgs.length,
      specGroupSummary: summary,
    });

    // Remove from map so we don't double-count
    projectSpecGroups.delete(project.id);
  }

  // Then, add any projects derived from spec groups that aren't in the Projects table
  for (const [projectId, sgs] of projectSpecGroups) {
    const summary = calculateSpecGroupSummary(sgs);
    const health = calculateHealthFromSpecGroups(sgs);

    // Find the most recent timestamps
    const now = new Date();
    const timestamps = sgs.map((sg) => ({
      created: new Date(sg.createdAt),
      updated: new Date(sg.updatedAt),
    }));

    const firstTimestamp = timestamps[0];
    const initialCreated = firstTimestamp?.created ?? now;
    const initialUpdated = firstTimestamp?.updated ?? now;

    const earliestCreated = timestamps.reduce(
      (min, t) => (t.created < min ? t.created : min),
      initialCreated,
    );

    const latestUpdated = timestamps.reduce(
      (max, t) => (t.updated > max ? t.updated : max),
      initialUpdated,
    );

    result.push({
      id: projectId,
      name: projectId
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()),
      status: 'active',
      health,
      specGroupCount: sgs.length,
      specGroupSummary: summary,
      createdAt: earliestCreated.toISOString(),
      updatedAt: latestUpdated.toISOString(),
    });
  }

  return result;
};

/**
 * Create the live implementation of the ProjectRepository.
 */
export const createProjectRepository = (): ProjectRepositorySchema => ({
  list: () =>
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDbService;

      // Scan spec groups table
      const specGroupsScanInput: ScanCommandInput = {
        TableName: SPEC_GROUPS_TABLE_NAME,
      };

      const specGroupsResult = yield* dynamodb.scan(specGroupsScanInput).pipe(
        Effect.mapError(
          (error) =>
            new InternalServerError({
              message: `Failed to scan spec groups: ${error.message}`,
              cause: error,
            }),
        ),
      );

      const specGroups: SpecGroup[] = [];
      for (const item of specGroupsResult.Items ?? []) {
        const sg = itemToSpecGroup(item);
        if (sg) {
          specGroups.push(sg);
        }
      }

      // Scan projects table - ignore errors if table doesn't exist
      const projectsScanInput: ScanCommandInput = {
        TableName: PROJECTS_TABLE_NAME,
      };

      const projects: Project[] = [];
      const projectsResultEither = yield* dynamodb
        .scan(projectsScanInput)
        .pipe(Effect.either);

      if (projectsResultEither._tag === 'Right') {
        for (const item of projectsResultEither.right.Items ?? []) {
          const project = itemToProject(item);
          if (project) {
            projects.push(project);
          }
        }
      }
      // If Left (error), we continue with empty projects array - table may not exist

      // Aggregate by project
      const aggregatedProjects = aggregateByProject(specGroups, projects);

      // Sort by updatedAt descending
      aggregatedProjects.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );

      return {
        projects: aggregatedProjects,
        total: aggregatedProjects.length,
      };
    }),

  getById: (id: string) =>
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDbService;

      // Scan spec groups for this project
      const scanInput: ScanCommandInput = {
        TableName: SPEC_GROUPS_TABLE_NAME,
        FilterExpression: 'begins_with(id, :prefix)',
        ExpressionAttributeValues: {
          ':prefix': { S: `sg-${id}-` },
        },
      };

      const result = yield* dynamodb.scan(scanInput).pipe(
        Effect.mapError(
          (error) =>
            new InternalServerError({
              message: `Failed to scan spec groups for project: ${error.message}`,
              cause: error,
            }),
        ),
      );

      const specGroups: SpecGroup[] = [];
      for (const item of result.Items ?? []) {
        const sg = itemToSpecGroup(item);
        if (sg) {
          specGroups.push(sg);
        }
      }

      if (specGroups.length === 0) {
        return Option.none();
      }

      const summary = calculateSpecGroupSummary(specGroups);
      const health = calculateHealthFromSpecGroups(specGroups);

      const timestamps = specGroups.map((sg) => ({
        created: new Date(sg.createdAt),
        updated: new Date(sg.updatedAt),
      }));

      // Safe to use ! here since we already checked specGroups.length > 0
      const firstTimestamp = timestamps[0]!;

      const earliestCreated = timestamps.reduce(
        (min, t) => (t.created < min ? t.created : min),
        firstTimestamp.created,
      );

      const latestUpdated = timestamps.reduce(
        (max, t) => (t.updated > max ? t.updated : max),
        firstTimestamp.updated,
      );

      const project: Project = {
        id,
        name: id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        status: 'active',
        health,
        specGroupCount: specGroups.length,
        specGroupSummary: summary,
        createdAt: earliestCreated.toISOString(),
        updatedAt: latestUpdated.toISOString(),
      };

      return Option.some(project);
    }),
});

/**
 * Project Repository Tests (AS-003)
 *
 * Tests for DynamoDB status field allowlist validation in projects repository.
 * AC3.1: VALID_PROJECT_STATUSES const array validates item.status?.S
 * AC3.2: Invalid project status values fall back to 'active'
 * AC3.3: as Project['status'] cast replaced with runtime validation
 * AC3.4 (partial): VALID_SPEC_GROUP_STATES validates state in itemToSpecGroup within projects repo
 */

import type {
  AttributeValue,
  ScanCommandOutput,
} from '@aws-sdk/client-dynamodb';
import { Effect, Layer } from 'effect';
import { describe, expect, it, beforeEach } from 'vitest';

import {
  createDynamoDbServiceFake,
  DynamoDbService,
  type DynamoDbServiceFake,
} from '@/testing/fakes/dynamodb.js';

import {
  createProjectRepository,
  ProjectRepository,
  type ProjectRepositorySchema,
} from '../repository.js';

/**
 * Helper to create mock $metadata for AWS SDK responses.
 */
const createMockMetadata = () => ({
  httpStatusCode: 200,
  requestId: 'test-request-id',
  attempts: 1,
  totalRetryDelay: 0,
});

/**
 * Helper to create a mock project DynamoDB item for the Projects table.
 */
const createMockProjectItem = (
  overrides: Record<string, AttributeValue> = {},
): Record<string, AttributeValue> => ({
  id: { S: 'test-project-id' },
  name: { S: 'Test Project' },
  status: { S: 'active' },
  createdAt: { S: '2024-01-01T00:00:00.000Z' },
  updatedAt: { S: '2024-01-01T00:00:00.000Z' },
  ...overrides,
});

/**
 * Helper to wrap items into a ScanCommandOutput.
 */
const wrapScanOutput = (
  items: Record<string, AttributeValue>[],
): ScanCommandOutput => ({
  $metadata: createMockMetadata(),
  Items: items,
  Count: items.length,
  ScannedCount: items.length,
});

describe('ProjectRepository - Status Validation (AS-003)', () => {
  let dynamoDbFake: DynamoDbServiceFake;
  let repoLayer: Layer.Layer<ProjectRepository | DynamoDbService, never, never>;

  beforeEach(() => {
    dynamoDbFake = createDynamoDbServiceFake();
    const repository = createProjectRepository();
    const repoService = Layer.succeed(ProjectRepository, repository);
    repoLayer = Layer.merge(repoService, dynamoDbFake.layer);
  });

  const withRepo = <R, E>(
    use: (
      repo: ProjectRepositorySchema,
    ) => Effect.Effect<R, E, DynamoDbService>,
  ): Promise<R> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* ProjectRepository;
        return yield* use(repo);
      }).pipe(Effect.provide(repoLayer)),
    );

  /**
   * The list() method does two scans:
   * 1. Scan SpecGroups table
   * 2. Scan Projects table
   * We queue responses for both scans, placing the project item
   * in the second scan (Projects table).
   */
  const queueListScans = (
    projectItem: Record<string, AttributeValue>,
  ): void => {
    // First scan: SpecGroups table (empty for these tests)
    dynamoDbFake.queueSuccess('scan', wrapScanOutput([]));
    // Second scan: Projects table (contains the project item)
    dynamoDbFake.queueSuccess('scan', wrapScanOutput([projectItem]));
  };

  describe('project status validation (AC3.1, AC3.2, AC3.3)', () => {
    it('should accept valid status "active" (AC3.1)', async () => {
      // Arrange
      const item = createMockProjectItem({ status: { S: 'active' } });
      queueListScans(item);

      // Act
      const result = await withRepo((repo) => repo.list());

      // Assert
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0]?.status).toBe('active');
    });

    it('should accept valid status "archived" (AC3.1)', async () => {
      // Arrange
      const item = createMockProjectItem({ status: { S: 'archived' } });
      queueListScans(item);

      // Act
      const result = await withRepo((repo) => repo.list());

      // Assert
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0]?.status).toBe('archived');
    });

    it('should accept valid status "draft" (AC3.1)', async () => {
      // Arrange
      const item = createMockProjectItem({ status: { S: 'draft' } });
      queueListScans(item);

      // Act
      const result = await withRepo((repo) => repo.list());

      // Assert
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0]?.status).toBe('draft');
    });

    it('should fall back to "active" for invalid status string (AC3.2, AC3.3)', async () => {
      // Arrange
      const item = createMockProjectItem({
        status: { S: 'INVALID_STATUS' },
      });
      queueListScans(item);

      // Act
      const result = await withRepo((repo) => repo.list());

      // Assert
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0]?.status).toBe('active');
    });

    it('should fall back to "active" for empty status string (AC3.2)', async () => {
      // Arrange
      const item = createMockProjectItem({ status: { S: '' } });
      queueListScans(item);

      // Act
      const result = await withRepo((repo) => repo.list());

      // Assert
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0]?.status).toBe('active');
    });

    it('should fall back to "active" for missing status field (AC3.2)', async () => {
      // Arrange
      const item = createMockProjectItem();
      delete item.status;
      queueListScans(item);

      // Act
      const result = await withRepo((repo) => repo.list());

      // Assert
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0]?.status).toBe('active');
    });

    it('should fall back to "active" for unknown status value "deleted" (AC3.2, AC3.3)', async () => {
      // Arrange
      const item = createMockProjectItem({
        status: { S: 'deleted' },
      });
      queueListScans(item);

      // Act
      const result = await withRepo((repo) => repo.list());

      // Assert
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0]?.status).toBe('active');
    });
  });

  describe('spec group state validation in projects repo (AC3.4 partial)', () => {
    it('should accept valid spec group state and include in project (AC3.4)', async () => {
      // Arrange - spec group with valid state
      const sgItem: Record<string, AttributeValue> = {
        id: { S: 'sg-myproj-001' },
        name: { S: 'Test SG' },
        state: { S: 'DRAFT' },
        decisionLog: { L: [] },
        createdAt: { S: '2024-01-01T00:00:00.000Z' },
        updatedAt: { S: '2024-01-01T00:00:00.000Z' },
        createdBy: { S: 'test-user' },
        sectionsCompleted: { BOOL: false },
        allGatesPassed: { BOOL: false },
        prMerged: { BOOL: false },
      };
      // First scan: SpecGroups table with one valid spec group
      dynamoDbFake.queueSuccess('scan', wrapScanOutput([sgItem]));
      // Second scan: Projects table (empty)
      dynamoDbFake.queueSuccess('scan', wrapScanOutput([]));

      // Act
      const result = await withRepo((repo) => repo.list());

      // Assert - spec group should be included (project derived from it)
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0]?.specGroupCount).toBe(1);
    });

    it('should reject spec group with invalid state (AC3.4)', async () => {
      // Arrange - spec group with invalid state
      const sgItem: Record<string, AttributeValue> = {
        id: { S: 'sg-myproj-001' },
        name: { S: 'Test SG' },
        state: { S: 'BOGUS_STATE' },
        decisionLog: { L: [] },
        createdAt: { S: '2024-01-01T00:00:00.000Z' },
        updatedAt: { S: '2024-01-01T00:00:00.000Z' },
        createdBy: { S: 'test-user' },
        sectionsCompleted: { BOOL: false },
        allGatesPassed: { BOOL: false },
        prMerged: { BOOL: false },
      };
      // First scan: SpecGroups table with invalid spec group
      dynamoDbFake.queueSuccess('scan', wrapScanOutput([sgItem]));
      // Second scan: Projects table (empty)
      dynamoDbFake.queueSuccess('scan', wrapScanOutput([]));

      // Act
      const result = await withRepo((repo) => repo.list());

      // Assert - invalid spec group rejected, no project derived
      expect(result.projects).toHaveLength(0);
    });
  });
});

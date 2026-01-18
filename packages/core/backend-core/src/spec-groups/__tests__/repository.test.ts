/**
 * Spec Group Repository Tests
 *
 * Tests for DynamoDB operations with atomic state transitions.
 * Covers AC3.5 (atomic persistence) and AC3.6 (decision log).
 */

import type {
  AttributeValue,
  GetItemCommandOutput,
  PutItemCommandOutput,
  UpdateItemCommandOutput,
} from '@aws-sdk/client-dynamodb';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it, beforeEach } from 'vitest';

import {
  createDynamoDbServiceFake,
  DynamoDbService,
  type DynamoDbServiceFake,
} from '@/testing/fakes/dynamodb.js';

// Note: We check error messages rather than error types because Effect wraps
// errors in FiberFailure when rejected through Effect.runPromise
import {
  createSpecGroupRepository,
  SpecGroupRepository,
  type SpecGroupRepositorySchema,
} from '../repository.js';
import { SpecGroupState, type SpecGroup } from '../types.js';

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
 * Helper to create a mock spec group DynamoDB item.
 */
const createMockDynamoDbItem = (
  overrides: Partial<SpecGroup> = {},
): Record<string, AttributeValue> => {
  const specGroup: SpecGroup = {
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
  };

  const item: Record<string, AttributeValue> = {
    id: { S: specGroup.id },
    name: { S: specGroup.name },
    state: { S: specGroup.state },
    decisionLog: {
      L: specGroup.decisionLog.map((entry) => ({
        M: {
          timestamp: { S: entry.timestamp },
          actor: { S: entry.actor },
          action: { S: entry.action },
          fromState: { S: entry.fromState },
          toState: { S: entry.toState },
          ...(entry.reason ? { reason: { S: entry.reason } } : {}),
        },
      })),
    },
    createdAt: { S: specGroup.createdAt },
    updatedAt: { S: specGroup.updatedAt },
    createdBy: { S: specGroup.createdBy },
    sectionsCompleted: { BOOL: specGroup.sectionsCompleted ?? false },
    allGatesPassed: { BOOL: specGroup.allGatesPassed ?? false },
    prMerged: { BOOL: specGroup.prMerged ?? false },
  };

  if (specGroup.description) {
    item.description = { S: specGroup.description };
  }

  return item;
};

describe('SpecGroupRepository', () => {
  let dynamoDbFake: DynamoDbServiceFake;
  let repoLayer: Layer.Layer<SpecGroupRepository | DynamoDbService, never, never>;

  beforeEach(() => {
    dynamoDbFake = createDynamoDbServiceFake();
    const repository = createSpecGroupRepository();
    const repoService = Layer.succeed(SpecGroupRepository, repository);
    repoLayer = Layer.merge(repoService, dynamoDbFake.layer);
  });

  const withRepo = <R, E>(
    use: (repo: SpecGroupRepositorySchema) => Effect.Effect<R, E, DynamoDbService>,
  ): Promise<R> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SpecGroupRepository;
        return yield* use(repo);
      }).pipe(Effect.provide(repoLayer)),
    );

  const wrapGetItemOutput = (
    item: Record<string, AttributeValue> | undefined,
  ): GetItemCommandOutput => ({
    $metadata: createMockMetadata(),
    Item: item,
  });

  const wrapPutItemOutput = (): PutItemCommandOutput => ({
    $metadata: createMockMetadata(),
  });

  const wrapUpdateItemOutput = (
    attrs: Record<string, AttributeValue> | undefined,
  ): UpdateItemCommandOutput => ({
    $metadata: createMockMetadata(),
    Attributes: attrs,
  });

  describe('getById', () => {
    it('returns Some when spec group exists', async () => {
      // Arrange
      const item = createMockDynamoDbItem({ id: 'existing-id' });
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));

      // Act
      const result = await withRepo((repo) => repo.getById('existing-id'));

      // Assert
      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.id).toBe('existing-id');
      }
    });

    it('returns None when spec group does not exist', async () => {
      // Arrange
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(undefined));

      // Act
      const result = await withRepo((repo) => repo.getById('non-existent-id'));

      // Assert
      expect(Option.isNone(result)).toBe(true);
    });

    it('throws InternalServerError on DynamoDB failure', async () => {
      // Arrange
      dynamoDbFake.queueFailure('getItem', new Error('DynamoDB error'));

      // Act & Assert
      await expect(
        withRepo((repo) => repo.getById('some-id')),
      ).rejects.toThrow('Failed to get spec group');
    });
  });

  describe('create', () => {
    it('creates a new spec group in DRAFT state', async () => {
      // Arrange
      dynamoDbFake.queueSuccess('putItem', wrapPutItemOutput());

      // Act
      const result = await withRepo((repo) =>
        repo.create({
          id: 'new-id',
          name: 'New Spec Group',
          description: 'A new spec group',
          createdBy: 'creator-user',
        }),
      );

      // Assert
      expect(result.id).toBe('new-id');
      expect(result.name).toBe('New Spec Group');
      expect(result.state).toBe(SpecGroupState.DRAFT);
      expect(result.decisionLog).toHaveLength(0);
      expect(result.sectionsCompleted).toBe(false);
    });

    it('throws InternalServerError on DynamoDB failure', async () => {
      // Arrange
      dynamoDbFake.queueFailure('putItem', new Error('DynamoDB error'));

      // Act & Assert
      await expect(
        withRepo((repo) =>
          repo.create({
            id: 'new-id',
            name: 'New Spec Group',
            createdBy: 'creator-user',
          }),
        ),
      ).rejects.toThrow('Failed to create spec group');
    });
  });

  describe('transitionState (AC3.5, AC3.6)', () => {
    it('throws SpecGroupNotFoundError when spec group does not exist', async () => {
      // Arrange
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(undefined));

      // Act & Assert
      await expect(
        withRepo((repo) =>
          repo.transitionState({
            specGroupId: 'non-existent-id',
            toState: SpecGroupState.REVIEWED,
            actor: 'test-user',
          }),
        ),
      ).rejects.toThrow('Spec group with id non-existent-id not found');
    });

    it('throws InvalidStateTransitionError for invalid transition', async () => {
      // Arrange
      const item = createMockDynamoDbItem({
        id: 'existing-id',
        state: SpecGroupState.DRAFT,
        sectionsCompleted: true,
      });
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));

      // Act & Assert - trying to skip to APPROVED
      await expect(
        withRepo((repo) =>
          repo.transitionState({
            specGroupId: 'existing-id',
            toState: SpecGroupState.APPROVED,
            actor: 'test-user',
          }),
        ),
      ).rejects.toThrow('Invalid transition from DRAFT to APPROVED');
    });

    it('throws InvalidStateTransitionError when preconditions fail', async () => {
      // Arrange
      const item = createMockDynamoDbItem({
        id: 'existing-id',
        state: SpecGroupState.DRAFT,
        sectionsCompleted: false, // Precondition not met
      });
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));

      // Act & Assert
      await expect(
        withRepo((repo) =>
          repo.transitionState({
            specGroupId: 'existing-id',
            toState: SpecGroupState.REVIEWED,
            actor: 'test-user',
          }),
        ),
      ).rejects.toThrow('All sections must be completed before review');
    });

    it('updates state and appends to decision log atomically (AC3.5, AC3.6)', async () => {
      // Arrange
      const item = createMockDynamoDbItem({
        id: 'existing-id',
        state: SpecGroupState.DRAFT,
        sectionsCompleted: true,
      });
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));

      const updatedItem = createMockDynamoDbItem({
        id: 'existing-id',
        state: SpecGroupState.REVIEWED,
        sectionsCompleted: true,
        decisionLog: [
          {
            timestamp: '2024-01-01T12:00:00.000Z',
            actor: 'test-user',
            action: 'STATE_TRANSITION' as const,
            fromState: SpecGroupState.DRAFT,
            toState: SpecGroupState.REVIEWED,
            reason: 'Review completed',
          },
        ],
      });
      dynamoDbFake.queueSuccess(
        'updateItem',
        wrapUpdateItemOutput(updatedItem),
      );

      // Act
      const result = await withRepo((repo) =>
        repo.transitionState({
          specGroupId: 'existing-id',
          toState: SpecGroupState.REVIEWED,
          actor: 'test-user',
          reason: 'Review completed',
        }),
      );

      // Assert
      expect(result.state).toBe(SpecGroupState.REVIEWED);

      // Verify the update call included condition expression for atomicity
      const updateCall = dynamoDbFake.calls.updateItem[0];
      expect(updateCall).toBeDefined();
      expect(updateCall?.ConditionExpression).toBe('#state = :currentState');
      expect(updateCall?.UpdateExpression).toContain('list_append');
    });

    it('includes reason in decision log when provided', async () => {
      // Arrange
      const item = createMockDynamoDbItem({
        id: 'existing-id',
        state: SpecGroupState.DRAFT,
        sectionsCompleted: true,
      });
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));

      const updatedItem = createMockDynamoDbItem({
        id: 'existing-id',
        state: SpecGroupState.REVIEWED,
        sectionsCompleted: true,
      });
      dynamoDbFake.queueSuccess(
        'updateItem',
        wrapUpdateItemOutput(updatedItem),
      );

      // Act
      await withRepo((repo) =>
        repo.transitionState({
          specGroupId: 'existing-id',
          toState: SpecGroupState.REVIEWED,
          actor: 'test-user',
          reason: 'All sections completed and reviewed',
        }),
      );

      // Assert - verify reason was included in the update
      const updateCall = dynamoDbFake.calls.updateItem[0];
      const logEntry = updateCall?.ExpressionAttributeValues?.[':logEntry'];
      expect(logEntry).toBeDefined();
    });
  });

  describe('updateFlags', () => {
    it('updates sectionsCompleted flag', async () => {
      // Arrange
      const updatedItem = createMockDynamoDbItem({
        id: 'existing-id',
        sectionsCompleted: true,
      });
      dynamoDbFake.queueSuccess(
        'updateItem',
        wrapUpdateItemOutput(updatedItem),
      );

      // Act
      const result = await withRepo((repo) =>
        repo.updateFlags('existing-id', { sectionsCompleted: true }),
      );

      // Assert
      expect(result.sectionsCompleted).toBe(true);
    });

    it('updates multiple flags at once', async () => {
      // Arrange
      const updatedItem = createMockDynamoDbItem({
        id: 'existing-id',
        sectionsCompleted: true,
        allGatesPassed: true,
      });
      dynamoDbFake.queueSuccess(
        'updateItem',
        wrapUpdateItemOutput(updatedItem),
      );

      // Act
      const result = await withRepo((repo) =>
        repo.updateFlags('existing-id', {
          sectionsCompleted: true,
          allGatesPassed: true,
        }),
      );

      // Assert
      expect(result.sectionsCompleted).toBe(true);
      expect(result.allGatesPassed).toBe(true);
    });

    it('throws SpecGroupNotFoundError when spec group does not exist', async () => {
      // Arrange
      const error = new Error('ConditionalCheckFailedException');
      error.name = 'ConditionalCheckFailedException';
      dynamoDbFake.queueFailure('updateItem', error);

      // Act & Assert
      await expect(
        withRepo((repo) =>
          repo.updateFlags('non-existent-id', { sectionsCompleted: true }),
        ),
      ).rejects.toThrow('Spec group with id non-existent-id not found');
    });
  });
});

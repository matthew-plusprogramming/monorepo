/**
 * Agent Task Repository Tests
 *
 * Tests for DynamoDB operations with TTL support.
 * Covers AC6.7 (dispatch attempt logged to AgentTasks table).
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

import {
  createAgentTaskRepository,
  AgentTaskRepository,
  type AgentTaskRepositorySchema,
} from '../repository.js';
import {
  AGENT_TASK_TTL_SECONDS,
  AgentAction,
  AgentTaskStatus,
  type AgentTask,
} from '../types.js';

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
 * Helper to create a mock agent task DynamoDB item.
 */
const createMockDynamoDbItem = (
  overrides: Partial<AgentTask> = {},
): Record<string, AttributeValue> => {
  const task: AgentTask = {
    id: 'test-task-id',
    specGroupId: 'test-spec-group-id',
    action: AgentAction.IMPLEMENT,
    status: AgentTaskStatus.PENDING,
    context: {
      specGroupId: 'test-spec-group-id',
      specGroupName: 'Test Spec Group',
      triggeredBy: 'test-user',
      triggeredAt: '2024-01-01T00:00:00.000Z',
    },
    webhookUrl: 'http://localhost:3001/webhook',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ttl: Math.floor(Date.now() / 1000) + AGENT_TASK_TTL_SECONDS,
    ...overrides,
  };

  const item: Record<string, AttributeValue> = {
    id: { S: task.id },
    specGroupId: { S: task.specGroupId },
    action: { S: task.action },
    status: { S: task.status },
    webhookUrl: { S: task.webhookUrl },
    createdAt: { S: task.createdAt },
    updatedAt: { S: task.updatedAt },
    ttl: { N: task.ttl.toString() },
    context: {
      M: {
        specGroupId: { S: task.context.specGroupId },
        triggeredBy: { S: task.context.triggeredBy },
        triggeredAt: { S: task.context.triggeredAt },
        ...(task.context.specGroupName
          ? { specGroupName: { S: task.context.specGroupName } }
          : {}),
      },
    },
  };

  if (task.dispatchedAt) {
    item.dispatchedAt = { S: task.dispatchedAt };
  }
  if (task.acknowledgedAt) {
    item.acknowledgedAt = { S: task.acknowledgedAt };
  }
  if (task.failedAt) {
    item.failedAt = { S: task.failedAt };
  }
  if (task.errorMessage) {
    item.errorMessage = { S: task.errorMessage };
  }
  if (task.responseStatus !== undefined) {
    item.responseStatus = { N: task.responseStatus.toString() };
  }

  return item;
};

describe('AgentTaskRepository', () => {
  let dynamoDbFake: DynamoDbServiceFake;
  let repoLayer: Layer.Layer<AgentTaskRepository | DynamoDbService, never, never>;

  beforeEach(() => {
    dynamoDbFake = createDynamoDbServiceFake();
    const repository = createAgentTaskRepository();
    const repoService = Layer.succeed(AgentTaskRepository, repository);
    repoLayer = Layer.merge(repoService, dynamoDbFake.layer);
  });

  const withRepo = <R, E>(
    use: (repo: AgentTaskRepositorySchema) => Effect.Effect<R, E, DynamoDbService>,
  ): Promise<R> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* AgentTaskRepository;
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
    it('returns Some when agent task exists', async () => {
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

    it('returns None when agent task does not exist', async () => {
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
      ).rejects.toThrow('Failed to get agent task');
    });
  });

  describe('create (AC6.7)', () => {
    it('creates a new agent task with TTL', async () => {
      // Arrange
      dynamoDbFake.queueSuccess('putItem', wrapPutItemOutput());

      // Act
      const result = await withRepo((repo) =>
        repo.create({
          id: 'new-task-id',
          specGroupId: 'spec-group-id',
          action: AgentAction.IMPLEMENT,
          context: {
            specGroupId: 'spec-group-id',
            specGroupName: 'Test Spec Group',
            triggeredBy: 'test-user',
            triggeredAt: '2024-01-01T00:00:00.000Z',
          },
          webhookUrl: 'http://localhost:3001/webhook',
        }),
      );

      // Assert
      expect(result.id).toBe('new-task-id');
      expect(result.specGroupId).toBe('spec-group-id');
      expect(result.action).toBe(AgentAction.IMPLEMENT);
      expect(result.status).toBe(AgentTaskStatus.PENDING);

      // Verify TTL is set (30 days from now)
      const expectedTtlMin =
        Math.floor(Date.now() / 1000) + AGENT_TASK_TTL_SECONDS - 60;
      const expectedTtlMax =
        Math.floor(Date.now() / 1000) + AGENT_TASK_TTL_SECONDS + 60;
      expect(result.ttl).toBeGreaterThanOrEqual(expectedTtlMin);
      expect(result.ttl).toBeLessThanOrEqual(expectedTtlMax);
    });

    it('throws InternalServerError on DynamoDB failure', async () => {
      // Arrange
      dynamoDbFake.queueFailure('putItem', new Error('DynamoDB error'));

      // Act & Assert
      await expect(
        withRepo((repo) =>
          repo.create({
            id: 'new-task-id',
            specGroupId: 'spec-group-id',
            action: AgentAction.IMPLEMENT,
            context: {
              specGroupId: 'spec-group-id',
              triggeredBy: 'test-user',
              triggeredAt: '2024-01-01T00:00:00.000Z',
            },
            webhookUrl: 'http://localhost:3001/webhook',
          }),
        ),
      ).rejects.toThrow('Failed to create agent task');
    });
  });

  describe('updateStatus', () => {
    it('updates status to DISPATCHED with timestamp', async () => {
      // Arrange
      const updatedItem = createMockDynamoDbItem({
        id: 'existing-id',
        status: AgentTaskStatus.DISPATCHED,
        dispatchedAt: '2024-01-01T12:00:00.000Z',
      });
      dynamoDbFake.queueSuccess(
        'updateItem',
        wrapUpdateItemOutput(updatedItem),
      );

      // Act
      const result = await withRepo((repo) =>
        repo.updateStatus({
          taskId: 'existing-id',
          status: AgentTaskStatus.DISPATCHED,
        }),
      );

      // Assert
      expect(result.status).toBe(AgentTaskStatus.DISPATCHED);

      // Verify update call includes dispatchedAt
      const updateCall = dynamoDbFake.calls.updateItem[0];
      expect(updateCall?.UpdateExpression).toContain('#dispatchedAt');
    });

    it('updates status to FAILED with error message', async () => {
      // Arrange
      const updatedItem = createMockDynamoDbItem({
        id: 'existing-id',
        status: AgentTaskStatus.FAILED,
        failedAt: '2024-01-01T12:00:00.000Z',
        errorMessage: 'Connection refused',
      });
      dynamoDbFake.queueSuccess(
        'updateItem',
        wrapUpdateItemOutput(updatedItem),
      );

      // Act
      const result = await withRepo((repo) =>
        repo.updateStatus({
          taskId: 'existing-id',
          status: AgentTaskStatus.FAILED,
          errorMessage: 'Connection refused',
        }),
      );

      // Assert
      expect(result.status).toBe(AgentTaskStatus.FAILED);

      // Verify update call includes errorMessage and failedAt
      const updateCall = dynamoDbFake.calls.updateItem[0];
      expect(updateCall?.UpdateExpression).toContain('#errorMessage');
      expect(updateCall?.UpdateExpression).toContain('#failedAt');
    });

    it('throws AgentTaskNotFoundError when task does not exist', async () => {
      // Arrange
      const error = new Error('ConditionalCheckFailedException');
      error.name = 'ConditionalCheckFailedException';
      dynamoDbFake.queueFailure('updateItem', error);

      // Act & Assert
      await expect(
        withRepo((repo) =>
          repo.updateStatus({
            taskId: 'non-existent-id',
            status: AgentTaskStatus.DISPATCHED,
          }),
        ),
      ).rejects.toThrow('Agent task with id non-existent-id not found');
    });
  });
});

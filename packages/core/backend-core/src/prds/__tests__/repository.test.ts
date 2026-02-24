/**
 * PRD Repository Tests
 *
 * Tests for PRD DynamoDB operations and Google Docs sync functionality.
 * Covers AC2.3 (sync fetches from Google Docs), AC2.4 (content updates),
 * AC2.5 (version increments on change), AC2.6 (error handling).
 */

import type {
  AttributeValue,
  GetItemCommandOutput,
  PutItemCommandOutput,
  UpdateItemCommandOutput,
} from '@aws-sdk/client-dynamodb';
import { Effect, Layer, Option } from 'effect';
import { createHash } from 'crypto';
import { describe, expect, it, beforeEach } from 'vitest';

import {
  createDynamoDbServiceFake,
  DynamoDbService,
  type DynamoDbServiceFake,
} from '@/testing/fakes/dynamodb.js';
import {
  createGoogleDocsServiceFake,
  GoogleDocsService,
  type GoogleDocsServiceFake,
} from '@/testing/fakes/google-docs.js';
import { GoogleDocsApiError } from '../errors.js';
import {
  createPrdRepository,
  PrdRepository,
  type PrdRepositorySchema,
} from '../repository.js';
import { PrdSyncStatus, type Prd } from '../types.js';

/**
 * Helper to compute content hash.
 */
const computeContentHash = (content: string): string => {
  return createHash('sha256').update(content).digest('hex');
};

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
 * Helper to create a mock PRD DynamoDB item.
 */
const createMockDynamoDbItem = (
  overrides: Partial<Prd> = {},
): Record<string, AttributeValue> => {
  const prd: Prd = {
    id: 'test-prd-id',
    googleDocId: 'test-google-doc-id',
    title: 'Test PRD',
    content: 'Test content',
    contentHash: computeContentHash('Test content'),
    version: 1,
    lastSyncedAt: '2024-01-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    createdBy: 'test-user',
    syncStatus: PrdSyncStatus.SYNCED,
    ...overrides,
  };

  const item: Record<string, AttributeValue> = {
    id: { S: prd.id },
    googleDocId: { S: prd.googleDocId },
    title: { S: prd.title },
    content: { S: prd.content },
    contentHash: { S: prd.contentHash },
    version: { N: prd.version.toString() },
    lastSyncedAt: { S: prd.lastSyncedAt },
    createdAt: { S: prd.createdAt },
    updatedAt: { S: prd.updatedAt },
    createdBy: { S: prd.createdBy },
    syncStatus: { S: prd.syncStatus },
  };

  if (prd.lastSyncError) {
    item.lastSyncError = { S: prd.lastSyncError };
  }

  return item;
};

describe('PrdRepository', () => {
  let dynamoDbFake: DynamoDbServiceFake;
  let googleDocsFake: GoogleDocsServiceFake;
  let repoLayer: Layer.Layer<
    PrdRepository | DynamoDbService | GoogleDocsService,
    never,
    never
  >;

  beforeEach(() => {
    dynamoDbFake = createDynamoDbServiceFake();
    googleDocsFake = createGoogleDocsServiceFake();
    const repository = createPrdRepository();
    const repoService = Layer.succeed(PrdRepository, repository);
    repoLayer = Layer.merge(
      Layer.merge(repoService, dynamoDbFake.layer),
      googleDocsFake.layer,
    );
  });

  const withRepo = <R, E>(
    use: (
      repo: PrdRepositorySchema,
    ) => Effect.Effect<R, E, DynamoDbService | GoogleDocsService>,
  ): Promise<R> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* PrdRepository;
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
    it('returns Some when PRD exists', async () => {
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

    it('returns None when PRD does not exist', async () => {
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
      await expect(withRepo((repo) => repo.getById('some-id'))).rejects.toThrow(
        'Failed to get PRD',
      );
    });
  });

  describe('create', () => {
    it('creates a new PRD with NEVER_SYNCED status', async () => {
      // Arrange
      dynamoDbFake.queueSuccess('putItem', wrapPutItemOutput());

      // Act
      const result = await withRepo((repo) =>
        repo.create({
          id: 'new-id',
          googleDocId: 'new-google-doc-id',
          title: 'New PRD',
          createdBy: 'creator-user',
        }),
      );

      // Assert
      expect(result.id).toBe('new-id');
      expect(result.googleDocId).toBe('new-google-doc-id');
      expect(result.title).toBe('New PRD');
      expect(result.version).toBe(0);
      expect(result.content).toBe('');
      expect(result.syncStatus).toBe(PrdSyncStatus.NEVER_SYNCED);
    });

    it('throws PrdConflictError when PRD already exists', async () => {
      // Arrange
      const error = new Error('ConditionalCheckFailedException');
      error.name = 'ConditionalCheckFailedException';
      dynamoDbFake.queueFailure('putItem', error);

      // Act & Assert
      await expect(
        withRepo((repo) =>
          repo.create({
            id: 'existing-id',
            googleDocId: 'google-doc-id',
            title: 'PRD',
            createdBy: 'user',
          }),
        ),
      ).rejects.toThrow('PRD with id existing-id already exists');
    });
  });

  describe('sync (AC2.3, AC2.4, AC2.5)', () => {
    it('throws PrdNotFoundError when PRD does not exist', async () => {
      // Arrange
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(undefined));

      // Act & Assert
      await expect(
        withRepo((repo) => repo.sync('non-existent-id')),
      ).rejects.toThrow('PRD with id non-existent-id not found');
    });

    it('fetches content from Google Docs API (AC2.3)', async () => {
      // Arrange
      const item = createMockDynamoDbItem({
        id: 'prd-1',
        googleDocId: 'doc-123',
      });
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));
      dynamoDbFake.queueSuccess('updateItem', wrapUpdateItemOutput(item)); // For syncing status
      googleDocsFake.queueSuccess('doc-123', {
        title: 'Updated Title',
        content: 'New content from Google Docs',
      });
      dynamoDbFake.queueSuccess(
        'updateItem',
        wrapUpdateItemOutput({
          ...item,
          title: { S: 'Updated Title' },
          content: { S: 'New content from Google Docs' },
          version: { N: '2' },
          syncStatus: { S: PrdSyncStatus.SYNCED },
        }),
      );

      // Act
      const result = await withRepo((repo) => repo.sync('prd-1'));

      // Assert
      expect(googleDocsFake.calls).toContain('doc-123');
      expect(result.prd.title).toBe('Updated Title');
    });

    it('updates PRD content after successful sync (AC2.4)', async () => {
      // Arrange
      const oldContent = 'Old content';
      const newContent = 'New content from Google Docs';
      const item = createMockDynamoDbItem({
        id: 'prd-1',
        googleDocId: 'doc-123',
        content: oldContent,
        contentHash: computeContentHash(oldContent),
        version: 1,
      });
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));
      dynamoDbFake.queueSuccess('updateItem', wrapUpdateItemOutput(item)); // For syncing status
      googleDocsFake.queueSuccess('doc-123', {
        title: 'Same Title',
        content: newContent,
      });

      const updatedItem = createMockDynamoDbItem({
        id: 'prd-1',
        googleDocId: 'doc-123',
        content: newContent,
        contentHash: computeContentHash(newContent),
        version: 2,
        syncStatus: PrdSyncStatus.SYNCED,
      });
      dynamoDbFake.queueSuccess(
        'updateItem',
        wrapUpdateItemOutput(updatedItem),
      );

      // Act
      const result = await withRepo((repo) => repo.sync('prd-1'));

      // Assert
      expect(result.prd.content).toBe(newContent);
      expect(result.contentChanged).toBe(true);
    });

    it('increments version only on content change (AC2.5)', async () => {
      // Arrange
      const content = 'Same content';
      const item = createMockDynamoDbItem({
        id: 'prd-1',
        googleDocId: 'doc-123',
        content,
        contentHash: computeContentHash(content),
        version: 5,
      });
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));
      dynamoDbFake.queueSuccess('updateItem', wrapUpdateItemOutput(item)); // For syncing status
      googleDocsFake.queueSuccess('doc-123', {
        title: 'Same Title',
        content, // Same content
      });

      const updatedItem = createMockDynamoDbItem({
        id: 'prd-1',
        googleDocId: 'doc-123',
        content,
        version: 5, // Version should NOT change
        syncStatus: PrdSyncStatus.SYNCED,
      });
      dynamoDbFake.queueSuccess(
        'updateItem',
        wrapUpdateItemOutput(updatedItem),
      );

      // Act
      const result = await withRepo((repo) => repo.sync('prd-1'));

      // Assert
      expect(result.contentChanged).toBe(false);
      expect(result.previousVersion).toBe(5);
      expect(result.prd.version).toBe(5); // Version unchanged
    });

    it('increments version when content changes (AC2.5)', async () => {
      // Arrange
      const oldContent = 'Old content';
      const newContent = 'New different content';
      const item = createMockDynamoDbItem({
        id: 'prd-1',
        googleDocId: 'doc-123',
        content: oldContent,
        contentHash: computeContentHash(oldContent),
        version: 3,
      });
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));
      dynamoDbFake.queueSuccess('updateItem', wrapUpdateItemOutput(item)); // For syncing status
      googleDocsFake.queueSuccess('doc-123', {
        title: 'Updated Title',
        content: newContent,
      });

      const updatedItem = createMockDynamoDbItem({
        id: 'prd-1',
        googleDocId: 'doc-123',
        content: newContent,
        contentHash: computeContentHash(newContent),
        version: 4, // Version incremented
        syncStatus: PrdSyncStatus.SYNCED,
      });
      dynamoDbFake.queueSuccess(
        'updateItem',
        wrapUpdateItemOutput(updatedItem),
      );

      // Act
      const result = await withRepo((repo) => repo.sync('prd-1'));

      // Assert
      expect(result.contentChanged).toBe(true);
      expect(result.previousVersion).toBe(3);
      expect(result.prd.version).toBe(4);
    });

    it('propagates Google Docs API errors (AC2.6)', async () => {
      // Arrange
      const item = createMockDynamoDbItem({
        id: 'prd-1',
        googleDocId: 'doc-123',
      });
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));
      dynamoDbFake.queueSuccess('updateItem', wrapUpdateItemOutput(item)); // For syncing status
      googleDocsFake.queueFailure(
        'doc-123',
        new GoogleDocsApiError({
          message: 'Document not found',
          cause: undefined,
          statusCode: 404,
          retryable: false,
        }),
      );

      // Act & Assert
      await expect(withRepo((repo) => repo.sync('prd-1'))).rejects.toThrow(
        'Document not found',
      );
    });

    it('marks retryable errors appropriately (AC2.6)', async () => {
      // Arrange
      const item = createMockDynamoDbItem({
        id: 'prd-1',
        googleDocId: 'doc-123',
      });
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));
      dynamoDbFake.queueSuccess('updateItem', wrapUpdateItemOutput(item)); // For syncing status

      const retryableError = new GoogleDocsApiError({
        message: 'Service unavailable',
        cause: undefined,
        statusCode: 503,
        retryable: true,
      });
      googleDocsFake.queueFailure('doc-123', retryableError);

      // Act & Assert
      try {
        await withRepo((repo) => repo.sync('prd-1'));
        expect.fail('Should have thrown');
      } catch (error) {
        // Effect wraps errors, so we check the message
        expect((error as Error).message).toContain('Service unavailable');
      }
    });
  });

  describe('updateSyncStatus', () => {
    it('updates sync status successfully', async () => {
      // Arrange
      const updatedItem = createMockDynamoDbItem({
        id: 'prd-1',
        syncStatus: PrdSyncStatus.ERROR,
        lastSyncError: 'API quota exceeded',
      });
      dynamoDbFake.queueSuccess(
        'updateItem',
        wrapUpdateItemOutput(updatedItem),
      );

      // Act
      const result = await withRepo((repo) =>
        repo.updateSyncStatus(
          'prd-1',
          PrdSyncStatus.ERROR,
          'API quota exceeded',
        ),
      );

      // Assert
      expect(result.syncStatus).toBe(PrdSyncStatus.ERROR);
      expect(result.lastSyncError).toBe('API quota exceeded');
    });

    it('throws PrdNotFoundError when PRD does not exist', async () => {
      // Arrange
      const error = new Error('ConditionalCheckFailedException');
      error.name = 'ConditionalCheckFailedException';
      dynamoDbFake.queueFailure('updateItem', error);

      // Act & Assert
      await expect(
        withRepo((repo) =>
          repo.updateSyncStatus('non-existent-id', PrdSyncStatus.ERROR),
        ),
      ).rejects.toThrow('PRD with id non-existent-id not found');
    });
  });

  describe('syncStatus field allowlist validation (AS-003 AC3.6)', () => {
    it('should accept valid syncStatus SYNCED (AC3.6)', async () => {
      // Arrange
      const item = createMockDynamoDbItem({
        syncStatus: PrdSyncStatus.SYNCED,
      });
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));

      // Act
      const result = await withRepo((repo) => repo.getById('test-prd-id'));

      // Assert
      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.syncStatus).toBe('SYNCED');
      }
    });

    it('should accept valid syncStatus ERROR (AC3.6)', async () => {
      // Arrange
      const item = createMockDynamoDbItem({
        syncStatus: PrdSyncStatus.ERROR,
        lastSyncError: 'Some error',
      });
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));

      // Act
      const result = await withRepo((repo) => repo.getById('test-prd-id'));

      // Assert
      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.syncStatus).toBe('ERROR');
      }
    });

    it('should accept valid syncStatus NEVER_SYNCED (AC3.6)', async () => {
      // Arrange
      const item = createMockDynamoDbItem({
        syncStatus: PrdSyncStatus.NEVER_SYNCED,
      });
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));

      // Act
      const result = await withRepo((repo) => repo.getById('test-prd-id'));

      // Assert
      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.syncStatus).toBe('NEVER_SYNCED');
      }
    });

    it('should accept valid syncStatus SYNCING (AC3.6)', async () => {
      // Arrange
      const item = createMockDynamoDbItem({
        syncStatus: PrdSyncStatus.SYNCING,
      });
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));

      // Act
      const result = await withRepo((repo) => repo.getById('test-prd-id'));

      // Assert
      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.syncStatus).toBe('SYNCING');
      }
    });

    it('should return None for invalid syncStatus value (AC3.6, AC3.10)', async () => {
      // Arrange - construct raw item with invalid syncStatus
      const item: Record<string, AttributeValue> = {
        id: { S: 'test-prd-id' },
        googleDocId: { S: 'test-google-doc-id' },
        title: { S: 'Test PRD' },
        content: { S: 'Test content' },
        contentHash: { S: computeContentHash('Test content') },
        version: { N: '1' },
        lastSyncedAt: { S: '2024-01-01T00:00:00.000Z' },
        createdAt: { S: '2024-01-01T00:00:00.000Z' },
        updatedAt: { S: '2024-01-01T00:00:00.000Z' },
        createdBy: { S: 'test-user' },
        syncStatus: { S: 'INVALID_SYNC_STATUS' },
      };
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));

      // Act
      const result = await withRepo((repo) => repo.getById('test-prd-id'));

      // Assert - invalid syncStatus causes record rejection (None)
      expect(Option.isNone(result)).toBe(true);
    });

    it('should return None for missing syncStatus field (AC3.6)', async () => {
      // Arrange - construct raw item without syncStatus
      const item: Record<string, AttributeValue> = {
        id: { S: 'test-prd-id' },
        googleDocId: { S: 'test-google-doc-id' },
        title: { S: 'Test PRD' },
        content: { S: 'Test content' },
        contentHash: { S: computeContentHash('Test content') },
        version: { N: '1' },
        lastSyncedAt: { S: '2024-01-01T00:00:00.000Z' },
        createdAt: { S: '2024-01-01T00:00:00.000Z' },
        updatedAt: { S: '2024-01-01T00:00:00.000Z' },
        createdBy: { S: 'test-user' },
        // syncStatus intentionally omitted
      };
      dynamoDbFake.queueSuccess('getItem', wrapGetItemOutput(item));

      // Act
      const result = await withRepo((repo) => repo.getById('test-prd-id'));

      // Assert - missing syncStatus causes record rejection (None)
      expect(Option.isNone(result)).toBe(true);
    });
  });
});

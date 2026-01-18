/**
 * PRD Repository
 *
 * Provides DynamoDB operations for PRDs with Google Docs sync functionality.
 * Implements version tracking via content hashing (AC2.5).
 */

import type {
  AttributeValue,
  GetItemCommandInput,
  PutItemCommandInput,
  QueryCommandInput,
  UpdateItemCommandInput,
} from '@aws-sdk/client-dynamodb';
import { Context, Effect, Option } from 'effect';
import { createHash } from 'crypto';

import { DynamoDbService } from '@/services/dynamodb.js';
import { GoogleDocsService } from '@/services/google-docs.js';
import { InternalServerError } from '@/types/errors/http.js';

import { GoogleDocsApiError, PrdConflictError, PrdNotFoundError } from './errors.js';
import {
  PrdSyncStatus,
  type CreatePrdInput,
  type Prd,
  type PrdSyncStatusType,
  type SyncPrdResult,
} from './types.js';

/**
 * Schema for the PrdRepository service.
 */
export type PrdRepositorySchema = {
  /**
   * Get a PRD by ID.
   */
  readonly getById: (
    id: string,
  ) => Effect.Effect<Option.Option<Prd>, InternalServerError, DynamoDbService>;

  /**
   * Get all PRDs.
   */
  readonly getAll: () => Effect.Effect<
    ReadonlyArray<Prd>,
    InternalServerError,
    DynamoDbService
  >;

  /**
   * Create a new PRD.
   */
  readonly create: (
    input: CreatePrdInput,
  ) => Effect.Effect<Prd, InternalServerError | PrdConflictError, DynamoDbService>;

  /**
   * Sync a PRD from Google Docs (AC2.3, AC2.4, AC2.5).
   * Fetches content from Google Docs API and updates local record.
   * Version number increments only on content change.
   */
  readonly sync: (
    prdId: string,
  ) => Effect.Effect<
    SyncPrdResult,
    PrdNotFoundError | GoogleDocsApiError | InternalServerError,
    DynamoDbService | GoogleDocsService
  >;

  /**
   * Update PRD sync status (for error handling).
   */
  readonly updateSyncStatus: (
    id: string,
    status: PrdSyncStatusType,
    error?: string,
  ) => Effect.Effect<
    Prd,
    PrdNotFoundError | InternalServerError,
    DynamoDbService
  >;
};

export class PrdRepository extends Context.Tag('PrdRepository')<
  PrdRepository,
  PrdRepositorySchema
>() {}

/**
 * Table name for PRDs.
 */
const TABLE_NAME = process.env.PRDS_TABLE_NAME ?? 'Prds';

/**
 * Compute a hash of the content for version comparison.
 */
const computeContentHash = (content: string): string => {
  return createHash('sha256').update(content).digest('hex');
};

/**
 * Convert a DynamoDB item to a Prd.
 */
const itemToPrd = (item: Record<string, AttributeValue>): Prd | undefined => {
  const id = item.id?.S;
  const googleDocId = item.googleDocId?.S;
  const title = item.title?.S;
  const content = item.content?.S;
  const contentHash = item.contentHash?.S;
  const version = item.version?.N;
  const lastSyncedAt = item.lastSyncedAt?.S;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;
  const createdBy = item.createdBy?.S;
  const syncStatus = item.syncStatus?.S as PrdSyncStatusType | undefined;

  if (
    !id ||
    !googleDocId ||
    !title ||
    content === undefined ||
    !contentHash ||
    !version ||
    !createdAt ||
    !updatedAt ||
    !createdBy ||
    !syncStatus
  ) {
    return undefined;
  }

  return {
    id,
    googleDocId,
    title,
    content,
    contentHash,
    version: parseInt(version, 10),
    lastSyncedAt: lastSyncedAt ?? createdAt,
    createdAt,
    updatedAt,
    createdBy,
    syncStatus,
    lastSyncError: item.lastSyncError?.S,
  };
};

/**
 * Convert a Prd to a DynamoDB item.
 */
const prdToItem = (prd: Prd): Record<string, AttributeValue> => {
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

/**
 * Create the live implementation of the PrdRepository.
 */
export const createPrdRepository = (): PrdRepositorySchema => ({
  getById: (id: string) =>
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDbService;

      const input: GetItemCommandInput = {
        TableName: TABLE_NAME,
        Key: {
          id: { S: id },
        },
      };

      const result = yield* dynamodb.getItem(input).pipe(
        Effect.mapError(
          (error) =>
            new InternalServerError({
              message: `Failed to get PRD: ${error.message}`,
              cause: error,
            }),
        ),
      );

      if (!result.Item) {
        return Option.none();
      }

      const prd = itemToPrd(result.Item);
      if (!prd) {
        return Option.none();
      }

      return Option.some(prd);
    }),

  getAll: () =>
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDbService;

      // Use scan for simplicity - in production, consider pagination
      const input: QueryCommandInput = {
        TableName: TABLE_NAME,
      };

      // For scan, we need to use a different approach
      // Using query with a GSI would be better, but for simplicity we'll scan
      const scanInput = {
        TableName: TABLE_NAME,
      };

      const result = yield* dynamodb.query(input as QueryCommandInput).pipe(
        Effect.mapError(
          (error) =>
            new InternalServerError({
              message: `Failed to list PRDs: ${error.message}`,
              cause: error,
            }),
        ),
      );

      const prds: Prd[] = [];
      for (const item of result.Items ?? []) {
        const prd = itemToPrd(item);
        if (prd) {
          prds.push(prd);
        }
      }

      return prds;
    }),

  create: (input: CreatePrdInput) =>
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDbService;
      const now = new Date().toISOString();

      const prd: Prd = {
        id: input.id,
        googleDocId: input.googleDocId,
        title: input.title,
        content: '',
        contentHash: computeContentHash(''),
        version: 0,
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
        createdBy: input.createdBy,
        syncStatus: PrdSyncStatus.NEVER_SYNCED,
      };

      const putInput: PutItemCommandInput = {
        TableName: TABLE_NAME,
        Item: prdToItem(prd),
        ConditionExpression: 'attribute_not_exists(id)',
      };

      yield* dynamodb.putItem(putInput).pipe(
        Effect.mapError((error) => {
          if (error.name === 'ConditionalCheckFailedException') {
            return new PrdConflictError({
              message: `PRD with id ${input.id} already exists`,
              cause: error,
            });
          }
          return new InternalServerError({
            message: `Failed to create PRD: ${error.message}`,
            cause: error,
          });
        }),
      );

      return prd;
    }),

  sync: (prdId: string) =>
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDbService;
      const googleDocs = yield* GoogleDocsService;

      // 1. Get the current PRD
      const getInput: GetItemCommandInput = {
        TableName: TABLE_NAME,
        Key: {
          id: { S: prdId },
        },
      };

      const getResult = yield* dynamodb.getItem(getInput).pipe(
        Effect.mapError(
          (error) =>
            new InternalServerError({
              message: `Failed to get PRD for sync: ${error.message}`,
              cause: error,
            }),
        ),
      );

      if (!getResult.Item) {
        return yield* new PrdNotFoundError({
          message: `PRD with id ${prdId} not found`,
          cause: undefined,
        });
      }

      const currentPrd = itemToPrd(getResult.Item);
      if (!currentPrd) {
        return yield* new InternalServerError({
          message: 'Failed to parse PRD from DynamoDB',
          cause: undefined,
        });
      }

      // 2. Mark as syncing
      yield* updateSyncStatusInternal(dynamodb, prdId, PrdSyncStatus.SYNCING);

      // 3. Fetch content from Google Docs (AC2.3)
      const docContent = yield* googleDocs.getDocContent(currentPrd.googleDocId);

      // 4. Compute new content hash for version comparison (AC2.5)
      const newContentHash = computeContentHash(docContent.content);
      const contentChanged = newContentHash !== currentPrd.contentHash;
      const previousVersion = currentPrd.version;

      // 5. Update the PRD with new content (AC2.4)
      const now = new Date().toISOString();
      const newVersion = contentChanged ? currentPrd.version + 1 : currentPrd.version;

      const updateInput: UpdateItemCommandInput = {
        TableName: TABLE_NAME,
        Key: {
          id: { S: prdId },
        },
        UpdateExpression:
          'SET #title = :title, #content = :content, #contentHash = :contentHash, ' +
          '#version = :version, #lastSyncedAt = :lastSyncedAt, #updatedAt = :updatedAt, ' +
          '#syncStatus = :syncStatus REMOVE #lastSyncError',
        ExpressionAttributeNames: {
          '#title': 'title',
          '#content': 'content',
          '#contentHash': 'contentHash',
          '#version': 'version',
          '#lastSyncedAt': 'lastSyncedAt',
          '#updatedAt': 'updatedAt',
          '#syncStatus': 'syncStatus',
          '#lastSyncError': 'lastSyncError',
        },
        ExpressionAttributeValues: {
          ':title': { S: docContent.title },
          ':content': { S: docContent.content },
          ':contentHash': { S: newContentHash },
          ':version': { N: newVersion.toString() },
          ':lastSyncedAt': { S: now },
          ':updatedAt': { S: now },
          ':syncStatus': { S: PrdSyncStatus.SYNCED },
        },
        ReturnValues: 'ALL_NEW',
      };

      const updateResult = yield* dynamodb.updateItem(updateInput).pipe(
        Effect.mapError(
          (error) =>
            new InternalServerError({
              message: `Failed to update PRD after sync: ${error.message}`,
              cause: error,
            }),
        ),
      );

      const updatedPrd = updateResult.Attributes
        ? itemToPrd(updateResult.Attributes)
        : undefined;

      if (!updatedPrd) {
        return yield* new InternalServerError({
          message: 'Failed to parse updated PRD from DynamoDB',
          cause: undefined,
        });
      }

      return {
        prd: updatedPrd,
        contentChanged,
        previousVersion,
      };
    }),

  updateSyncStatus: (id: string, status: PrdSyncStatusType, error?: string) =>
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDbService;
      return yield* updateSyncStatusInternal(dynamodb, id, status, error);
    }),
});

/**
 * Internal helper to update sync status.
 */
const updateSyncStatusInternal = (
  dynamodb: {
    readonly updateItem: (
      input: UpdateItemCommandInput,
    ) => Effect.Effect<{ Attributes?: Record<string, AttributeValue> }, Error>;
  },
  id: string,
  status: PrdSyncStatusType,
  error?: string,
): Effect.Effect<Prd, PrdNotFoundError | InternalServerError> =>
  Effect.gen(function* () {
    const now = new Date().toISOString();

    let updateExpression =
      'SET #syncStatus = :syncStatus, #updatedAt = :updatedAt';
    const expressionAttributeNames: Record<string, string> = {
      '#syncStatus': 'syncStatus',
      '#updatedAt': 'updatedAt',
    };
    const expressionAttributeValues: Record<string, AttributeValue> = {
      ':syncStatus': { S: status },
      ':updatedAt': { S: now },
    };

    if (error) {
      updateExpression += ', #lastSyncError = :lastSyncError';
      expressionAttributeNames['#lastSyncError'] = 'lastSyncError';
      expressionAttributeValues[':lastSyncError'] = { S: error };
    }

    const updateInput: UpdateItemCommandInput = {
      TableName: TABLE_NAME,
      Key: {
        id: { S: id },
      },
      UpdateExpression: updateExpression,
      ConditionExpression: 'attribute_exists(id)',
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    };

    const updateResult = yield* dynamodb.updateItem(updateInput).pipe(
      Effect.mapError((err) => {
        if (err.name === 'ConditionalCheckFailedException') {
          return new PrdNotFoundError({
            message: `PRD with id ${id} not found`,
            cause: err,
          });
        }
        return new InternalServerError({
          message: `Failed to update PRD sync status: ${err.message}`,
          cause: err,
        });
      }),
    );

    const updatedPrd = updateResult.Attributes
      ? itemToPrd(updateResult.Attributes)
      : undefined;

    if (!updatedPrd) {
      return yield* new InternalServerError({
        message: 'Failed to parse updated PRD from DynamoDB',
        cause: undefined,
      });
    }

    return updatedPrd;
  });

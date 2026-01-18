/**
 * Spec Group Repository
 *
 * Provides DynamoDB operations for spec groups with atomic state transitions.
 */

import type {
  AttributeValue,
  GetItemCommandInput,
  PutItemCommandInput,
  UpdateItemCommandInput,
} from '@aws-sdk/client-dynamodb';
import { Context, Effect, Option } from 'effect';

import { DynamoDbService } from '@/services/dynamodb.js';
import { InternalServerError } from '@/types/errors/http.js';

import {
  InvalidStateTransitionError,
  SpecGroupConflictError,
  SpecGroupNotFoundError,
} from './errors.js';
import { validateTransition } from './stateMachine.js';
import {
  SpecGroupState,
  type CreateSpecGroupInput,
  type DecisionLogEntry,
  type SpecGroup,
  type SpecGroupStateType,
  type TransitionStateInput,
} from './types.js';

/**
 * Schema for the SpecGroupRepository service.
 */
export type SpecGroupRepositorySchema = {
  readonly getById: (
    id: string,
  ) => Effect.Effect<
    Option.Option<SpecGroup>,
    InternalServerError,
    DynamoDbService
  >;

  readonly create: (
    input: CreateSpecGroupInput,
  ) => Effect.Effect<SpecGroup, InternalServerError, DynamoDbService>;

  readonly transitionState: (
    input: TransitionStateInput,
  ) => Effect.Effect<
    SpecGroup,
    | SpecGroupNotFoundError
    | InvalidStateTransitionError
    | SpecGroupConflictError
    | InternalServerError,
    DynamoDbService
  >;

  readonly updateFlags: (
    id: string,
    flags: Partial<{
      readonly sectionsCompleted: boolean;
      readonly allGatesPassed: boolean;
      readonly prMerged: boolean;
    }>,
  ) => Effect.Effect<
    SpecGroup,
    SpecGroupNotFoundError | InternalServerError,
    DynamoDbService
  >;
};

export class SpecGroupRepository extends Context.Tag('SpecGroupRepository')<
  SpecGroupRepository,
  SpecGroupRepositorySchema
>() {}

/**
 * Table name for spec groups.
 */
const TABLE_NAME = process.env.SPEC_GROUPS_TABLE_NAME ?? 'SpecGroups';

/**
 * Convert a DynamoDB item to a SpecGroup.
 */
const itemToSpecGroup = (
  item: Record<string, AttributeValue>,
): SpecGroup | undefined => {
  const id = item.id?.S;
  const name = item.name?.S;
  const state = item.state?.S as SpecGroupStateType | undefined;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;
  const createdBy = item.createdBy?.S;

  if (!id || !name || !state || !createdAt || !updatedAt || !createdBy) {
    return undefined;
  }

  const decisionLogRaw = item.decisionLog?.L ?? [];
  const decisionLog: DecisionLogEntry[] = decisionLogRaw
    .map((entry): DecisionLogEntry | undefined => {
      const m = entry.M;
      if (!m) return undefined;
      const baseEntry = {
        timestamp: m.timestamp?.S ?? '',
        actor: m.actor?.S ?? '',
        action: 'STATE_TRANSITION' as const,
        fromState: m.fromState?.S as SpecGroupStateType,
        toState: m.toState?.S as SpecGroupStateType,
      };
      if (m.reason?.S) {
        return { ...baseEntry, reason: m.reason.S };
      }
      return baseEntry;
    })
    .filter((entry): entry is DecisionLogEntry => entry !== undefined);

  return {
    id,
    name,
    description: item.description?.S,
    state,
    decisionLog,
    createdAt,
    updatedAt,
    createdBy,
    sectionsCompleted: item.sectionsCompleted?.BOOL,
    allGatesPassed: item.allGatesPassed?.BOOL,
    prMerged: item.prMerged?.BOOL,
  };
};

/**
 * Convert a SpecGroup to a DynamoDB item.
 */
const specGroupToItem = (
  specGroup: SpecGroup,
): Record<string, AttributeValue> => {
  const item: Record<string, AttributeValue> = {
    id: { S: specGroup.id },
    name: { S: specGroup.name },
    state: { S: specGroup.state },
    createdAt: { S: specGroup.createdAt },
    updatedAt: { S: specGroup.updatedAt },
    createdBy: { S: specGroup.createdBy },
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
  };

  if (specGroup.description) {
    item.description = { S: specGroup.description };
  }
  if (specGroup.sectionsCompleted !== undefined) {
    item.sectionsCompleted = { BOOL: specGroup.sectionsCompleted };
  }
  if (specGroup.allGatesPassed !== undefined) {
    item.allGatesPassed = { BOOL: specGroup.allGatesPassed };
  }
  if (specGroup.prMerged !== undefined) {
    item.prMerged = { BOOL: specGroup.prMerged };
  }

  return item;
};

/**
 * Create a decision log entry for a state transition.
 */
const createDecisionLogEntry = (
  fromState: SpecGroupStateType,
  toState: SpecGroupStateType,
  actor: string,
  reason?: string,
): DecisionLogEntry => ({
  timestamp: new Date().toISOString(),
  actor,
  action: 'STATE_TRANSITION',
  fromState,
  toState,
  reason,
});

/**
 * Create the live implementation of the SpecGroupRepository.
 */
export const createSpecGroupRepository = (): SpecGroupRepositorySchema => ({
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
              message: `Failed to get spec group: ${error.message}`,
              cause: error,
            }),
        ),
      );

      if (!result.Item) {
        return Option.none();
      }

      const specGroup = itemToSpecGroup(result.Item);
      if (!specGroup) {
        return Option.none();
      }

      return Option.some(specGroup);
    }),

  create: (input: CreateSpecGroupInput) =>
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDbService;
      const now = new Date().toISOString();

      const specGroup: SpecGroup = {
        id: input.id,
        name: input.name,
        description: input.description,
        state: SpecGroupState.DRAFT,
        decisionLog: [],
        createdAt: now,
        updatedAt: now,
        createdBy: input.createdBy,
        sectionsCompleted: false,
        allGatesPassed: false,
        prMerged: false,
      };

      const putInput: PutItemCommandInput = {
        TableName: TABLE_NAME,
        Item: specGroupToItem(specGroup),
        ConditionExpression: 'attribute_not_exists(id)',
      };

      yield* dynamodb.putItem(putInput).pipe(
        Effect.mapError(
          (error) =>
            new InternalServerError({
              message: `Failed to create spec group: ${error.message}`,
              cause: error,
            }),
        ),
      );

      return specGroup;
    }),

  transitionState: (input: TransitionStateInput) =>
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDbService;

      // First, get the current spec group
      const getInput: GetItemCommandInput = {
        TableName: TABLE_NAME,
        Key: {
          id: { S: input.specGroupId },
        },
      };

      const getResult = yield* dynamodb.getItem(getInput).pipe(
        Effect.mapError(
          (error) =>
            new InternalServerError({
              message: `Failed to get spec group for transition: ${error.message}`,
              cause: error,
            }),
        ),
      );

      if (!getResult.Item) {
        return yield* new SpecGroupNotFoundError({
          message: `Spec group with id ${input.specGroupId} not found`,
          cause: undefined,
        });
      }

      const currentSpecGroup = itemToSpecGroup(getResult.Item);
      if (!currentSpecGroup) {
        return yield* new InternalServerError({
          message: 'Failed to parse spec group from DynamoDB',
          cause: undefined,
        });
      }

      // Validate the transition
      const validation = validateTransition(currentSpecGroup, input.toState);
      if (!validation.valid) {
        return yield* new InvalidStateTransitionError({
          message: validation.reason,
          cause: undefined,
        });
      }

      // Create the decision log entry
      const logEntry = createDecisionLogEntry(
        currentSpecGroup.state,
        input.toState,
        input.actor,
        input.reason,
      );

      const now = new Date().toISOString();

      // Perform atomic update with condition on current state
      const updateInput: UpdateItemCommandInput = {
        TableName: TABLE_NAME,
        Key: {
          id: { S: input.specGroupId },
        },
        UpdateExpression:
          'SET #state = :newState, #updatedAt = :updatedAt, #decisionLog = list_append(#decisionLog, :logEntry)',
        ConditionExpression: '#state = :currentState',
        ExpressionAttributeNames: {
          '#state': 'state',
          '#updatedAt': 'updatedAt',
          '#decisionLog': 'decisionLog',
        },
        ExpressionAttributeValues: {
          ':newState': { S: input.toState },
          ':currentState': { S: currentSpecGroup.state },
          ':updatedAt': { S: now },
          ':logEntry': {
            L: [
              {
                M: {
                  timestamp: { S: logEntry.timestamp },
                  actor: { S: logEntry.actor },
                  action: { S: logEntry.action },
                  fromState: { S: logEntry.fromState },
                  toState: { S: logEntry.toState },
                  ...(logEntry.reason
                    ? { reason: { S: logEntry.reason } }
                    : {}),
                },
              },
            ],
          },
        },
        ReturnValues: 'ALL_NEW',
      };

      const updateResult = yield* dynamodb.updateItem(updateInput).pipe(
        Effect.mapError((error) => {
          // Check if it's a conditional check failure (race condition)
          if (error.name === 'ConditionalCheckFailedException') {
            return new SpecGroupConflictError({
              message:
                'State transition failed due to concurrent modification. Please retry.',
              cause: error,
            });
          }
          return new InternalServerError({
            message: `Failed to transition spec group state: ${error.message}`,
            cause: error,
          });
        }),
      );

      const updatedSpecGroup = updateResult.Attributes
        ? itemToSpecGroup(updateResult.Attributes)
        : undefined;

      if (!updatedSpecGroup) {
        return yield* new InternalServerError({
          message: 'Failed to parse updated spec group from DynamoDB',
          cause: undefined,
        });
      }

      return updatedSpecGroup;
    }),

  updateFlags: (
    id: string,
    flags: Partial<{
      readonly sectionsCompleted: boolean;
      readonly allGatesPassed: boolean;
      readonly prMerged: boolean;
    }>,
  ) =>
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDbService;

      // Build the update expression dynamically
      const updateParts: string[] = ['#updatedAt = :updatedAt'];
      const expressionAttributeNames: Record<string, string> = {
        '#updatedAt': 'updatedAt',
      };
      const expressionAttributeValues: Record<string, AttributeValue> = {
        ':updatedAt': { S: new Date().toISOString() },
      };

      if (flags.sectionsCompleted !== undefined) {
        updateParts.push('#sectionsCompleted = :sectionsCompleted');
        expressionAttributeNames['#sectionsCompleted'] = 'sectionsCompleted';
        expressionAttributeValues[':sectionsCompleted'] = {
          BOOL: flags.sectionsCompleted,
        };
      }

      if (flags.allGatesPassed !== undefined) {
        updateParts.push('#allGatesPassed = :allGatesPassed');
        expressionAttributeNames['#allGatesPassed'] = 'allGatesPassed';
        expressionAttributeValues[':allGatesPassed'] = {
          BOOL: flags.allGatesPassed,
        };
      }

      if (flags.prMerged !== undefined) {
        updateParts.push('#prMerged = :prMerged');
        expressionAttributeNames['#prMerged'] = 'prMerged';
        expressionAttributeValues[':prMerged'] = { BOOL: flags.prMerged };
      }

      const updateInput: UpdateItemCommandInput = {
        TableName: TABLE_NAME,
        Key: {
          id: { S: id },
        },
        UpdateExpression: `SET ${updateParts.join(', ')}`,
        ConditionExpression: 'attribute_exists(id)',
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW',
      };

      const updateResult = yield* dynamodb.updateItem(updateInput).pipe(
        Effect.mapError((error) => {
          if (error.name === 'ConditionalCheckFailedException') {
            return new SpecGroupNotFoundError({
              message: `Spec group with id ${id} not found`,
              cause: error,
            });
          }
          return new InternalServerError({
            message: `Failed to update spec group flags: ${error.message}`,
            cause: error,
          });
        }),
      );

      const updatedSpecGroup = updateResult.Attributes
        ? itemToSpecGroup(updateResult.Attributes)
        : undefined;

      if (!updatedSpecGroup) {
        return yield* new InternalServerError({
          message: 'Failed to parse updated spec group from DynamoDB',
          cause: undefined,
        });
      }

      return updatedSpecGroup;
    }),
});

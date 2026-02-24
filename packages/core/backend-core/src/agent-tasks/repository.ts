/**
 * Agent Task Repository
 *
 * Provides DynamoDB operations for agent tasks with TTL support.
 * Extended for real-time status updates (AS-007).
 */

import type {
  AttributeValue,
  GetItemCommandInput,
  PutItemCommandInput,
  QueryCommandInput,
  UpdateItemCommandInput,
} from '@aws-sdk/client-dynamodb';
import { Context, Effect, Option } from 'effect';

import { DynamoDbService } from '@/services/dynamodb.js';
import { InternalServerError } from '@/types/errors/http.js';

import { AgentTaskNotFoundError } from './errors.js';
import {
  AGENT_TASK_TTL_SECONDS,
  AgentAction,
  AgentTaskStatus,
  LogLevel,
  TaskPhase,
  type AgentActionType,
  type AgentTask,
  type AgentTaskLogEntry,
  type AgentTaskRealtimeStatus,
  type AgentTaskStatusType,
  type AgentTaskStatusUpdateInput,
  type CreateAgentTaskInput,
  type LogLevelType,
  type TaskPhaseType,
  type UpdateAgentTaskStatusInput,
} from './types.js';

/**
 * Allowlist of valid agent task statuses (AC3.5).
 * Derived from the AgentTaskStatus const object.
 */
const VALID_AGENT_TASK_STATUSES: readonly AgentTaskStatusType[] = Object.values(
  AgentTaskStatus,
) as AgentTaskStatusType[];

/**
 * Allowlist of valid agent task actions (AC3.7).
 * Derived from the AgentAction const object.
 */
const VALID_AGENT_TASK_ACTIONS: readonly AgentActionType[] = Object.values(
  AgentAction,
) as AgentActionType[];

/**
 * Allowlist of valid task phases (AC3.8).
 * Derived from the TaskPhase const object.
 */
const VALID_TASK_PHASES: readonly TaskPhaseType[] = Object.values(
  TaskPhase,
) as TaskPhaseType[];

/**
 * Allowlist of valid log levels (AC3.9).
 * Derived from the LogLevel const object.
 */
const VALID_LOG_LEVELS: readonly LogLevelType[] = Object.values(
  LogLevel,
) as LogLevelType[];

/**
 * Extended agent task with real-time status fields (AS-007).
 */
export type AgentTaskWithRealtimeStatus = AgentTask & {
  readonly phase?: TaskPhaseType;
  readonly progress?: number;
  readonly phaseMessage?: string;
  readonly logs?: readonly AgentTaskLogEntry[];
};

/**
 * Input for updating real-time task status (AS-007).
 */
export type UpdateRealtimeStatusInput = {
  readonly taskId: string;
  readonly phase: TaskPhaseType;
  readonly progress?: number;
  readonly message?: string;
  readonly logEntry?: AgentTaskLogEntry;
};

/**
 * Schema for the AgentTaskRepository service.
 */
export type AgentTaskRepositorySchema = {
  readonly getById: (
    id: string,
  ) => Effect.Effect<
    Option.Option<AgentTask>,
    InternalServerError,
    DynamoDbService
  >;

  readonly create: (
    input: CreateAgentTaskInput,
  ) => Effect.Effect<AgentTask, InternalServerError, DynamoDbService>;

  readonly updateStatus: (
    input: UpdateAgentTaskStatusInput,
  ) => Effect.Effect<
    AgentTask,
    AgentTaskNotFoundError | InternalServerError,
    DynamoDbService
  >;

  /**
   * Update real-time task status and optionally add a log entry (AS-007).
   * AC7.3: Progress indicator shows task phase
   * AC7.4: Task logs accessible via expandable section
   */
  readonly updateRealtimeStatus: (
    input: UpdateRealtimeStatusInput,
  ) => Effect.Effect<
    AgentTaskRealtimeStatus,
    AgentTaskNotFoundError | InternalServerError,
    DynamoDbService
  >;

  /**
   * Add a log entry to a task (AS-007 AC7.4).
   */
  readonly addLogEntry: (
    taskId: string,
    logEntry: AgentTaskLogEntry,
  ) => Effect.Effect<
    void,
    AgentTaskNotFoundError | InternalServerError,
    DynamoDbService
  >;

  /**
   * Get logs for a task (AS-007 AC7.4).
   */
  readonly getLogs: (
    taskId: string,
  ) => Effect.Effect<
    readonly AgentTaskLogEntry[],
    AgentTaskNotFoundError | InternalServerError,
    DynamoDbService
  >;

  /**
   * Get real-time status for a task (AS-007 AC7.7 - polling fallback).
   */
  readonly getRealtimeStatus: (
    taskId: string,
  ) => Effect.Effect<
    Option.Option<AgentTaskRealtimeStatus>,
    InternalServerError,
    DynamoDbService
  >;
};

export class AgentTaskRepository extends Context.Tag('AgentTaskRepository')<
  AgentTaskRepository,
  AgentTaskRepositorySchema
>() {}

/**
 * Table name for agent tasks.
 */
const TABLE_NAME = process.env.AGENT_TASKS_TABLE_NAME ?? 'AgentTasks';

/**
 * Convert a DynamoDB item to an AgentTask.
 */
const itemToAgentTask = (
  item: Record<string, AttributeValue>,
): AgentTask | undefined => {
  const id = item.id?.S;
  const specGroupId = item.specGroupId?.S;
  const action = item.action?.S;
  const rawStatus = item.status?.S;
  const status: AgentTaskStatusType | undefined =
    rawStatus &&
    VALID_AGENT_TASK_STATUSES.includes(rawStatus as AgentTaskStatusType)
      ? (rawStatus as AgentTaskStatusType)
      : undefined;
  const webhookUrl = item.webhookUrl?.S;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;
  const ttl = item.ttl?.N;

  if (
    !id ||
    !specGroupId ||
    !action ||
    !status ||
    !webhookUrl ||
    !createdAt ||
    !updatedAt ||
    !ttl
  ) {
    return undefined;
  }

  const contextMap = item.context?.M;
  if (!contextMap) {
    return undefined;
  }

  const context = {
    specGroupId: contextMap.specGroupId?.S ?? '',
    specGroupName: contextMap.specGroupName?.S,
    triggeredBy: contextMap.triggeredBy?.S ?? '',
    triggeredAt: contextMap.triggeredAt?.S ?? '',
  };

  const task: AgentTask = {
    id,
    specGroupId,
    action: VALID_AGENT_TASK_ACTIONS.includes(action as AgentActionType)
      ? (action as AgentActionType)
      : (AgentAction.IMPLEMENT as AgentActionType),
    status,
    context,
    webhookUrl,
    createdAt,
    updatedAt,
    ttl: parseInt(ttl, 10),
    dispatchedAt: item.dispatchedAt?.S,
    acknowledgedAt: item.acknowledgedAt?.S,
    failedAt: item.failedAt?.S,
    errorMessage: item.errorMessage?.S,
    responseStatus: item.responseStatus?.N
      ? parseInt(item.responseStatus.N, 10)
      : undefined,
  };

  return task;
};

/**
 * Convert an AgentTask to a DynamoDB item.
 */
const agentTaskToItem = (task: AgentTask): Record<string, AttributeValue> => {
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

/**
 * Calculate TTL timestamp (30 days from now).
 */
const calculateTtl = (): number => {
  return Math.floor(Date.now() / 1000) + AGENT_TASK_TTL_SECONDS;
};

/**
 * Create the live implementation of the AgentTaskRepository.
 */
export const createAgentTaskRepository = (): AgentTaskRepositorySchema => ({
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
              message: `Failed to get agent task: ${error.message}`,
              cause: error,
            }),
        ),
      );

      if (!result.Item) {
        return Option.none();
      }

      const agentTask = itemToAgentTask(result.Item);
      if (!agentTask) {
        return Option.none();
      }

      return Option.some(agentTask);
    }),

  create: (input: CreateAgentTaskInput) =>
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDbService;
      const now = new Date().toISOString();

      const agentTask: AgentTask = {
        id: input.id,
        specGroupId: input.specGroupId,
        action: input.action,
        status: AgentTaskStatus.PENDING,
        context: input.context,
        webhookUrl: input.webhookUrl,
        createdAt: now,
        updatedAt: now,
        ttl: calculateTtl(),
      };

      const putInput: PutItemCommandInput = {
        TableName: TABLE_NAME,
        Item: agentTaskToItem(agentTask),
        ConditionExpression: 'attribute_not_exists(id)',
      };

      yield* dynamodb.putItem(putInput).pipe(
        Effect.mapError(
          (error) =>
            new InternalServerError({
              message: `Failed to create agent task: ${error.message}`,
              cause: error,
            }),
        ),
      );

      return agentTask;
    }),

  updateStatus: (input: UpdateAgentTaskStatusInput) =>
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDbService;
      const now = new Date().toISOString();

      // Build the update expression dynamically
      const updateParts: string[] = [
        '#updatedAt = :updatedAt',
        '#status = :status',
      ];
      const expressionAttributeNames: Record<string, string> = {
        '#updatedAt': 'updatedAt',
        '#status': 'status',
      };
      const expressionAttributeValues: Record<string, AttributeValue> = {
        ':updatedAt': { S: now },
        ':status': { S: input.status },
      };

      // Add timestamp based on status
      if (input.status === AgentTaskStatus.DISPATCHED) {
        updateParts.push('#dispatchedAt = :dispatchedAt');
        expressionAttributeNames['#dispatchedAt'] = 'dispatchedAt';
        expressionAttributeValues[':dispatchedAt'] = { S: now };
      } else if (input.status === AgentTaskStatus.ACKNOWLEDGED) {
        updateParts.push('#acknowledgedAt = :acknowledgedAt');
        expressionAttributeNames['#acknowledgedAt'] = 'acknowledgedAt';
        expressionAttributeValues[':acknowledgedAt'] = { S: now };
      } else if (
        input.status === AgentTaskStatus.FAILED ||
        input.status === AgentTaskStatus.TIMEOUT
      ) {
        updateParts.push('#failedAt = :failedAt');
        expressionAttributeNames['#failedAt'] = 'failedAt';
        expressionAttributeValues[':failedAt'] = { S: now };
      }

      if (input.errorMessage) {
        updateParts.push('#errorMessage = :errorMessage');
        expressionAttributeNames['#errorMessage'] = 'errorMessage';
        expressionAttributeValues[':errorMessage'] = { S: input.errorMessage };
      }

      if (input.responseStatus !== undefined) {
        updateParts.push('#responseStatus = :responseStatus');
        expressionAttributeNames['#responseStatus'] = 'responseStatus';
        expressionAttributeValues[':responseStatus'] = {
          N: input.responseStatus.toString(),
        };
      }

      const updateInput: UpdateItemCommandInput = {
        TableName: TABLE_NAME,
        Key: {
          id: { S: input.taskId },
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
            return new AgentTaskNotFoundError({
              message: `Agent task with id ${input.taskId} not found`,
              cause: error,
            });
          }
          return new InternalServerError({
            message: `Failed to update agent task status: ${error.message}`,
            cause: error,
          });
        }),
      );

      const updatedTask = updateResult.Attributes
        ? itemToAgentTask(updateResult.Attributes)
        : undefined;

      if (!updatedTask) {
        return yield* new InternalServerError({
          message: 'Failed to parse updated agent task from DynamoDB',
          cause: undefined,
        });
      }

      return updatedTask;
    }),

  /**
   * Update real-time task status (AS-007).
   */
  updateRealtimeStatus: (input: UpdateRealtimeStatusInput) =>
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDbService;
      const now = new Date().toISOString();

      const updateParts: string[] = [
        '#updatedAt = :updatedAt',
        '#phase = :phase',
      ];
      const expressionAttributeNames: Record<string, string> = {
        '#updatedAt': 'updatedAt',
        '#phase': 'phase',
      };
      const expressionAttributeValues: Record<string, AttributeValue> = {
        ':updatedAt': { S: now },
        ':phase': { S: input.phase },
      };

      if (input.progress !== undefined) {
        updateParts.push('#progress = :progress');
        expressionAttributeNames['#progress'] = 'progress';
        expressionAttributeValues[':progress'] = {
          N: input.progress.toString(),
        };
      }

      if (input.message) {
        updateParts.push('#phaseMessage = :phaseMessage');
        expressionAttributeNames['#phaseMessage'] = 'phaseMessage';
        expressionAttributeValues[':phaseMessage'] = { S: input.message };
      }

      // Handle completed/failed phases
      if (input.phase === 'completed' || input.phase === 'failed') {
        updateParts.push('#completedAt = :completedAt');
        expressionAttributeNames['#completedAt'] = 'completedAt';
        expressionAttributeValues[':completedAt'] = { S: now };
      }

      const updateInput: UpdateItemCommandInput = {
        TableName: TABLE_NAME,
        Key: {
          id: { S: input.taskId },
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
            return new AgentTaskNotFoundError({
              message: `Agent task with id ${input.taskId} not found`,
              cause: error,
            });
          }
          return new InternalServerError({
            message: `Failed to update real-time status: ${error.message}`,
            cause: error,
          });
        }),
      );

      // Also add log entry if provided
      if (input.logEntry) {
        yield* addLogEntryInternal(dynamodb, input.taskId, input.logEntry);
      }

      const attrs = updateResult.Attributes;
      if (!attrs) {
        return yield* new InternalServerError({
          message: 'Failed to get updated attributes from DynamoDB',
          cause: undefined,
        });
      }

      const realtimeStatus: AgentTaskRealtimeStatus = {
        taskId: input.taskId,
        phase: VALID_TASK_PHASES.includes(
          (attrs.phase?.S ?? input.phase) as TaskPhaseType,
        )
          ? ((attrs.phase?.S ?? input.phase) as TaskPhaseType)
          : input.phase,
        progress: attrs.progress?.N
          ? parseInt(attrs.progress.N, 10)
          : undefined,
        message: attrs.phaseMessage?.S,
        updatedAt: attrs.updatedAt?.S ?? now,
      };

      return realtimeStatus;
    }),

  /**
   * Add a log entry to a task (AS-007 AC7.4).
   */
  addLogEntry: (taskId: string, logEntry: AgentTaskLogEntry) =>
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDbService;
      yield* addLogEntryInternal(dynamodb, taskId, logEntry);
    }),

  /**
   * Get logs for a task (AS-007 AC7.4).
   */
  getLogs: (taskId: string) =>
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDbService;

      const queryInput: QueryCommandInput = {
        TableName: LOGS_TABLE_NAME,
        KeyConditionExpression: '#taskId = :taskId',
        ExpressionAttributeNames: {
          '#taskId': 'taskId',
        },
        ExpressionAttributeValues: {
          ':taskId': { S: taskId },
        },
        ScanIndexForward: true, // chronological order
      };

      const result = yield* dynamodb.query(queryInput).pipe(
        Effect.mapError(
          (error) =>
            new InternalServerError({
              message: `Failed to get logs: ${error.message}`,
              cause: error,
            }),
        ),
      );

      const logs: AgentTaskLogEntry[] = (result.Items ?? [])
        .map((item) => ({
          timestamp: item.timestamp?.S ?? '',
          level: VALID_LOG_LEVELS.includes(
            (item.level?.S ?? 'info') as LogLevelType,
          )
            ? ((item.level?.S ?? 'info') as LogLevelType)
            : ('info' as LogLevelType),
          message: item.message?.S ?? '',
          metadata: item.metadata?.S ? JSON.parse(item.metadata.S) : undefined,
        }))
        .filter((log) => log.timestamp && log.message);

      return logs;
    }),

  /**
   * Get real-time status for polling fallback (AS-007 AC7.7).
   */
  getRealtimeStatus: (taskId: string) =>
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDbService;

      const input: GetItemCommandInput = {
        TableName: TABLE_NAME,
        Key: {
          id: { S: taskId },
        },
        ProjectionExpression: 'id, phase, progress, phaseMessage, updatedAt',
      };

      const result = yield* dynamodb.getItem(input).pipe(
        Effect.mapError(
          (error) =>
            new InternalServerError({
              message: `Failed to get real-time status: ${error.message}`,
              cause: error,
            }),
        ),
      );

      if (!result.Item) {
        return Option.none();
      }

      const item = result.Item;
      const phase = item.phase?.S;

      if (!phase || !VALID_TASK_PHASES.includes(phase as TaskPhaseType)) {
        return Option.none();
      }

      const status: AgentTaskRealtimeStatus = {
        taskId,
        phase: phase as TaskPhaseType, // Safe: validated by VALID_TASK_PHASES check above
        progress: item.progress?.N ? parseInt(item.progress.N, 10) : undefined,
        message: item.phaseMessage?.S,
        updatedAt: item.updatedAt?.S ?? new Date().toISOString(),
      };

      return Option.some(status);
    }),
});

/**
 * Table name for agent task logs.
 */
const LOGS_TABLE_NAME =
  process.env.AGENT_TASK_LOGS_TABLE_NAME ?? 'AgentTaskLogs';

/**
 * Internal helper to add a log entry.
 */
const addLogEntryInternal = (
  dynamodb: DynamoDbService['Type'],
  taskId: string,
  logEntry: AgentTaskLogEntry,
): Effect.Effect<void, InternalServerError, never> =>
  Effect.gen(function* () {
    const ttl = calculateTtl();

    const putInput: PutItemCommandInput = {
      TableName: LOGS_TABLE_NAME,
      Item: {
        taskId: { S: taskId },
        timestamp: { S: logEntry.timestamp },
        level: { S: logEntry.level },
        message: { S: logEntry.message },
        ttl: { N: ttl.toString() },
        ...(logEntry.metadata
          ? { metadata: { S: JSON.stringify(logEntry.metadata) } }
          : {}),
      },
    };

    yield* dynamodb.putItem(putInput).pipe(
      Effect.mapError(
        (error) =>
          new InternalServerError({
            message: `Failed to add log entry: ${error.message}`,
            cause: error,
          }),
      ),
    );
  });

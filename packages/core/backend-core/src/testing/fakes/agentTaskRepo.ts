/**
 * Agent Task Repository Fake
 *
 * Provides a fake implementation of AgentTaskRepository for testing.
 * Extended for real-time status updates (AS-007).
 */

import { Effect, Layer, Option } from 'effect';

import { AgentTaskNotFoundError } from '@/agent-tasks/errors.js';
import {
  AgentTaskRepository,
  type AgentTaskRepositorySchema,
  type UpdateRealtimeStatusInput,
} from '@/agent-tasks/repository.js';
import {
  AGENT_TASK_TTL_SECONDS,
  AgentTaskStatus,
  type AgentTask,
  type AgentTaskLogEntry,
  type AgentTaskRealtimeStatus,
  type CreateAgentTaskInput,
  type UpdateAgentTaskStatusInput,
} from '@/agent-tasks/types.js';
import { InternalServerError } from '@/types/errors/http.js';

type SuccessEntry<T> = { type: 'success'; value: T };
type ErrorEntry<E> = { type: 'error'; error: E };
type ResponseEntry<T, E> = SuccessEntry<T> | ErrorEntry<E>;

type ResponseQueues = {
  readonly getById: Array<
    ResponseEntry<Option.Option<AgentTask>, InternalServerError>
  >;
  readonly create: Array<ResponseEntry<AgentTask, InternalServerError>>;
  readonly updateStatus: Array<
    ResponseEntry<AgentTask, AgentTaskNotFoundError | InternalServerError>
  >;
  readonly updateRealtimeStatus: Array<
    ResponseEntry<AgentTaskRealtimeStatus, AgentTaskNotFoundError | InternalServerError>
  >;
  readonly addLogEntry: Array<
    ResponseEntry<void, AgentTaskNotFoundError | InternalServerError>
  >;
  readonly getLogs: Array<
    ResponseEntry<readonly AgentTaskLogEntry[], AgentTaskNotFoundError | InternalServerError>
  >;
  readonly getRealtimeStatus: Array<
    ResponseEntry<Option.Option<AgentTaskRealtimeStatus>, InternalServerError>
  >;
};

type CallHistory = {
  readonly getById: Array<string>;
  readonly create: Array<CreateAgentTaskInput>;
  readonly updateStatus: Array<UpdateAgentTaskStatusInput>;
  readonly updateRealtimeStatus: Array<UpdateRealtimeStatusInput>;
  readonly addLogEntry: Array<{ taskId: string; logEntry: AgentTaskLogEntry }>;
  readonly getLogs: Array<string>;
  readonly getRealtimeStatus: Array<string>;
};

export type AgentTaskRepoFake = {
  readonly service: AgentTaskRepositorySchema;
  readonly layer: Layer.Layer<AgentTaskRepository, never, never>;
  readonly queueGetByIdSome: (task: AgentTask) => void;
  readonly queueGetByIdNone: () => void;
  readonly queueGetByIdError: (error: InternalServerError) => void;
  readonly queueCreateSuccess: (task: AgentTask) => void;
  readonly queueCreateError: (error: InternalServerError) => void;
  readonly queueUpdateStatusSuccess: (task: AgentTask) => void;
  readonly queueUpdateStatusError: (
    error: AgentTaskNotFoundError | InternalServerError,
  ) => void;
  readonly queueUpdateRealtimeStatusSuccess: (status: AgentTaskRealtimeStatus) => void;
  readonly queueUpdateRealtimeStatusError: (
    error: AgentTaskNotFoundError | InternalServerError,
  ) => void;
  readonly queueAddLogEntrySuccess: () => void;
  readonly queueAddLogEntryError: (
    error: AgentTaskNotFoundError | InternalServerError,
  ) => void;
  readonly queueGetLogsSuccess: (logs: readonly AgentTaskLogEntry[]) => void;
  readonly queueGetLogsError: (
    error: AgentTaskNotFoundError | InternalServerError,
  ) => void;
  readonly queueGetRealtimeStatusSome: (status: AgentTaskRealtimeStatus) => void;
  readonly queueGetRealtimeStatusNone: () => void;
  readonly queueGetRealtimeStatusError: (error: InternalServerError) => void;
  readonly calls: CallHistory;
  readonly reset: () => void;
};

const dequeue = <T, E>(
  queue: Array<ResponseEntry<T, E>>,
  operation: string,
): Effect.Effect<T, E | InternalServerError> => {
  const next = queue.shift();
  if (!next) {
    return Effect.fail(
      new InternalServerError({
        message: `No response queued for AgentTaskRepository.${operation}`,
        cause: undefined,
      }),
    );
  }

  if (next.type === 'success') {
    return Effect.succeed(next.value);
  }

  return Effect.fail(next.error);
};

export const createAgentTaskRepoFake = (): AgentTaskRepoFake => {
  const responseQueues: ResponseQueues = {
    getById: [],
    create: [],
    updateStatus: [],
    updateRealtimeStatus: [],
    addLogEntry: [],
    getLogs: [],
    getRealtimeStatus: [],
  };

  const callHistory: CallHistory = {
    getById: [],
    create: [],
    updateStatus: [],
    updateRealtimeStatus: [],
    addLogEntry: [],
    getLogs: [],
    getRealtimeStatus: [],
  };

  const service: AgentTaskRepositorySchema = {
    getById: (id: string) =>
      Effect.sync(() => {
        callHistory.getById.push(id);
      }).pipe(Effect.flatMap(() => dequeue(responseQueues.getById, 'getById'))),

    create: (input: CreateAgentTaskInput) =>
      Effect.sync(() => {
        callHistory.create.push(input);
      }).pipe(Effect.flatMap(() => dequeue(responseQueues.create, 'create'))),

    updateStatus: (input: UpdateAgentTaskStatusInput) =>
      Effect.sync(() => {
        callHistory.updateStatus.push(input);
      }).pipe(
        Effect.flatMap(() =>
          dequeue(responseQueues.updateStatus, 'updateStatus'),
        ),
      ),

    updateRealtimeStatus: (input: UpdateRealtimeStatusInput) =>
      Effect.sync(() => {
        callHistory.updateRealtimeStatus.push(input);
      }).pipe(
        Effect.flatMap(() =>
          dequeue(responseQueues.updateRealtimeStatus, 'updateRealtimeStatus'),
        ),
      ),

    addLogEntry: (taskId: string, logEntry: AgentTaskLogEntry) =>
      Effect.sync(() => {
        callHistory.addLogEntry.push({ taskId, logEntry });
      }).pipe(
        Effect.flatMap(() =>
          dequeue(responseQueues.addLogEntry, 'addLogEntry'),
        ),
      ),

    getLogs: (taskId: string) =>
      Effect.sync(() => {
        callHistory.getLogs.push(taskId);
      }).pipe(
        Effect.flatMap(() => dequeue(responseQueues.getLogs, 'getLogs')),
      ),

    getRealtimeStatus: (taskId: string) =>
      Effect.sync(() => {
        callHistory.getRealtimeStatus.push(taskId);
      }).pipe(
        Effect.flatMap(() =>
          dequeue(responseQueues.getRealtimeStatus, 'getRealtimeStatus'),
        ),
      ),
  };

  return {
    service,
    layer: Layer.succeed(AgentTaskRepository, service),
    queueGetByIdSome: (task: AgentTask): void => {
      responseQueues.getById.push({
        type: 'success',
        value: Option.some(task),
      });
    },
    queueGetByIdNone: (): void => {
      responseQueues.getById.push({
        type: 'success',
        value: Option.none(),
      });
    },
    queueGetByIdError: (error: InternalServerError): void => {
      responseQueues.getById.push({ type: 'error', error });
    },
    queueCreateSuccess: (task: AgentTask): void => {
      responseQueues.create.push({ type: 'success', value: task });
    },
    queueCreateError: (error: InternalServerError): void => {
      responseQueues.create.push({ type: 'error', error });
    },
    queueUpdateStatusSuccess: (task: AgentTask): void => {
      responseQueues.updateStatus.push({ type: 'success', value: task });
    },
    queueUpdateStatusError: (
      error: AgentTaskNotFoundError | InternalServerError,
    ): void => {
      responseQueues.updateStatus.push({ type: 'error', error });
    },
    queueUpdateRealtimeStatusSuccess: (status: AgentTaskRealtimeStatus): void => {
      responseQueues.updateRealtimeStatus.push({ type: 'success', value: status });
    },
    queueUpdateRealtimeStatusError: (
      error: AgentTaskNotFoundError | InternalServerError,
    ): void => {
      responseQueues.updateRealtimeStatus.push({ type: 'error', error });
    },
    queueAddLogEntrySuccess: (): void => {
      responseQueues.addLogEntry.push({ type: 'success', value: undefined });
    },
    queueAddLogEntryError: (
      error: AgentTaskNotFoundError | InternalServerError,
    ): void => {
      responseQueues.addLogEntry.push({ type: 'error', error });
    },
    queueGetLogsSuccess: (logs: readonly AgentTaskLogEntry[]): void => {
      responseQueues.getLogs.push({ type: 'success', value: logs });
    },
    queueGetLogsError: (
      error: AgentTaskNotFoundError | InternalServerError,
    ): void => {
      responseQueues.getLogs.push({ type: 'error', error });
    },
    queueGetRealtimeStatusSome: (status: AgentTaskRealtimeStatus): void => {
      responseQueues.getRealtimeStatus.push({ type: 'success', value: Option.some(status) });
    },
    queueGetRealtimeStatusNone: (): void => {
      responseQueues.getRealtimeStatus.push({ type: 'success', value: Option.none() });
    },
    queueGetRealtimeStatusError: (error: InternalServerError): void => {
      responseQueues.getRealtimeStatus.push({ type: 'error', error });
    },
    calls: callHistory,
    reset: (): void => {
      responseQueues.getById.length = 0;
      responseQueues.create.length = 0;
      responseQueues.updateStatus.length = 0;
      responseQueues.updateRealtimeStatus.length = 0;
      responseQueues.addLogEntry.length = 0;
      responseQueues.getLogs.length = 0;
      responseQueues.getRealtimeStatus.length = 0;
      callHistory.getById.length = 0;
      callHistory.create.length = 0;
      callHistory.updateStatus.length = 0;
      callHistory.updateRealtimeStatus.length = 0;
      callHistory.addLogEntry.length = 0;
      callHistory.getLogs.length = 0;
      callHistory.getRealtimeStatus.length = 0;
    },
  };
};

/**
 * Helper to create a mock agent task for testing.
 */
export const createMockAgentTask = (
  overrides: Partial<AgentTask> = {},
): AgentTask => ({
  id: 'test-task-id',
  specGroupId: 'test-spec-group-id',
  action: 'implement',
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
});

/**
 * Helper to create a mock realtime status for testing (AS-007).
 */
export const createMockRealtimeStatus = (
  overrides: Partial<AgentTaskRealtimeStatus> = {},
): AgentTaskRealtimeStatus => ({
  taskId: 'test-task-id',
  phase: 'running',
  progress: 50,
  message: 'Processing...',
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

/**
 * Helper to create a mock log entry for testing (AS-007).
 */
export const createMockLogEntry = (
  overrides: Partial<AgentTaskLogEntry> = {},
): AgentTaskLogEntry => ({
  timestamp: '2024-01-01T00:00:00.000Z',
  level: 'info',
  message: 'Test log message',
  ...overrides,
});

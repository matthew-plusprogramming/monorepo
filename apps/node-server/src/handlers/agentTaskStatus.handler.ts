/**
 * Agent Task Status Handler
 *
 * Handles API endpoints for agent task real-time status updates (AS-007).
 * POST /api/agent-tasks/:id/status - Update task status (for agent callbacks)
 * GET /api/agent-tasks/:id/status - Get current status (polling fallback)
 * GET /api/agent-tasks/:id/logs - Get task logs
 */

import {
  AgentTaskNotFoundError,
  AgentTaskRepository,
  AgentTaskStatusUpdateInputSchema,
  type AgentTaskLogEntry,
  type AgentTaskRealtimeStatus,
} from '@packages/backend-core/agent-tasks';
import {
  generateRequestHandler,
  HTTP_RESPONSE,
  InternalServerError,
  type handlerInput,
} from '@packages/backend-core';
import { Effect, Option } from 'effect';
import { ZodError } from 'zod';
import z from 'zod';

import { parseInput } from '@/helpers/zodParser';
import { AppLayer } from '@/layers/app.layer';
import { broadcastTaskStatus } from '@/services/websocket.service';

/**
 * Response type for status update endpoint.
 */
type StatusUpdateResponse = {
  readonly success: boolean;
  readonly status: AgentTaskRealtimeStatus;
};

/**
 * Response type for get status endpoint.
 */
type GetStatusResponse = {
  readonly status: AgentTaskRealtimeStatus | null;
};

/**
 * Response type for get logs endpoint.
 */
type GetLogsResponse = {
  readonly taskId: string;
  readonly logs: readonly AgentTaskLogEntry[];
};

/**
 * Handler for POST /api/agent-tasks/:id/status
 * Updates task status and broadcasts to WebSocket clients (AC7.2, AC7.3).
 */
const updateStatusHandler = (input: handlerInput) =>
  Effect.gen(function* () {
    const req = yield* input;
    const taskId = req.params.id as string;

    const parsedInput = yield* parseInput(
      AgentTaskStatusUpdateInputSchema,
      req.body,
    );

    const repo = yield* AgentTaskRepository;

    // Update status in DynamoDB
    const status = yield* repo.updateRealtimeStatus({
      taskId,
      phase: parsedInput.phase,
      progress: parsedInput.progress,
      message: parsedInput.message,
      logEntry: parsedInput.logEntry,
    });

    // Broadcast to WebSocket clients (AC7.2)
    yield* broadcastTaskStatus(status);

    return {
      success: true,
      status,
    };
  });

/**
 * Handler for GET /api/agent-tasks/:id/status
 * Gets current task status for polling fallback (AC7.7).
 */
const getStatusHandler = (input: handlerInput) =>
  Effect.gen(function* () {
    const req = yield* input;
    const taskId = req.params.id as string;

    const repo = yield* AgentTaskRepository;
    const maybeStatus = yield* repo.getRealtimeStatus(taskId);

    if (Option.isNone(maybeStatus)) {
      return { status: null };
    }

    return { status: maybeStatus.value };
  });

/**
 * Handler for GET /api/agent-tasks/:id/logs
 * Gets task logs for expandable section (AC7.4).
 */
const getLogsHandler = (input: handlerInput) =>
  Effect.gen(function* () {
    const req = yield* input;
    const taskId = req.params.id as string;

    const repo = yield* AgentTaskRepository;

    // First check if task exists
    const maybeTask = yield* repo.getById(taskId);
    if (Option.isNone(maybeTask)) {
      return yield* new AgentTaskNotFoundError({
        message: `Agent task with id ${taskId} not found`,
        cause: undefined,
      });
    }

    const logs = yield* repo.getLogs(taskId);

    return {
      taskId,
      logs,
    };
  });

/**
 * Exported request handlers.
 */
export const updateAgentTaskStatusRequestHandler = generateRequestHandler<
  StatusUpdateResponse,
  AgentTaskNotFoundError | InternalServerError | ZodError
>({
  effectfulHandler: (input) =>
    updateStatusHandler(input).pipe(Effect.provide(AppLayer)),
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    [HTTP_RESPONSE.BAD_REQUEST]: {
      errorType: ZodError,
      mapper: (e) => ({ error: z.prettifyError(e as ZodError) }),
    },
    [HTTP_RESPONSE.NOT_FOUND]: {
      errorType: AgentTaskNotFoundError,
      mapper: (e) => ({ error: e.message }),
    },
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      // AC1.3: Return generic message, real error logged by generateRequestHandler
      mapper: () => ({ error: 'Internal server error' }),
    },
  },
  successCode: HTTP_RESPONSE.OK,
});

export const getAgentTaskStatusRequestHandler = generateRequestHandler<
  GetStatusResponse,
  InternalServerError
>({
  effectfulHandler: (input) =>
    getStatusHandler(input).pipe(Effect.provide(AppLayer)),
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      // AC1.3: Return generic message, real error logged by generateRequestHandler
      mapper: () => ({ error: 'Internal server error' }),
    },
  },
  successCode: HTTP_RESPONSE.OK,
});

export const getAgentTaskLogsRequestHandler = generateRequestHandler<
  GetLogsResponse,
  AgentTaskNotFoundError | InternalServerError
>({
  effectfulHandler: (input) =>
    getLogsHandler(input).pipe(Effect.provide(AppLayer)),
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    [HTTP_RESPONSE.NOT_FOUND]: {
      errorType: AgentTaskNotFoundError,
      mapper: (e) => ({ error: e.message }),
    },
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      // AC1.3: Return generic message, real error logged by generateRequestHandler
      mapper: () => ({ error: 'Internal server error' }),
    },
  },
  successCode: HTTP_RESPONSE.OK,
});

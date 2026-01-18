/**
 * Agent Dispatch Handler
 *
 * Handles API endpoints for agent task dispatch and status:
 * - POST /api/spec-groups/:id/dispatch - Dispatch agent task (AC6.2, AC6.3, AC6.7)
 * - GET /api/agent-tasks/:id - Get agent task by ID
 */

import {
  AgentAction,
  AgentTaskNotFoundError,
  AgentTaskRepository,
  AgentTaskStatus,
  generateRequestHandler,
  HTTP_RESPONSE,
  InternalServerError,
  SpecGroupNotFoundError,
  SpecGroupRepository,
  WebhookDispatchError,
  WebhookNotConfiguredError,
  WebhookService,
  WebhookTimeoutError,
  type AgentActionType,
  type AgentTask,
  type handlerInput,
} from '@packages/backend-core';
import { Effect, Option } from 'effect';
import { randomUUID } from 'node:crypto';
import z, { ZodError } from 'zod';

import { parseInput } from '@/helpers/zodParser';
import { AppLayer } from '@/layers/app.layer';

/**
 * Schema for dispatch request body.
 */
const DispatchInputSchema = z.object({
  action: z.enum(['implement', 'test']),
});

/**
 * Response type for dispatch endpoint.
 */
type DispatchResponse = {
  readonly task: AgentTask;
  readonly message: string;
};

/**
 * Response type for get agent task endpoint.
 */
type GetAgentTaskResponse = {
  readonly task: AgentTask;
};

/**
 * Handler for POST /api/spec-groups/:id/dispatch
 * AC6.2: Clicking button sends POST webhook to configured endpoint
 * AC6.3: Webhook payload includes spec group ID, action type, and context
 * AC6.7: Dispatch attempt logged to AgentTasks table
 */
const dispatchHandler = (input: handlerInput) =>
  Effect.gen(function* () {
    const req = yield* input;
    const specGroupId = req.params.id as string;

    const parsedInput = yield* parseInput(DispatchInputSchema, req.body);
    const action = parsedInput.action as AgentActionType;

    // Get actor from authenticated user (fallback to 'system' for now)
    const actor =
      (req as unknown as { user?: { id?: string } }).user?.id ?? 'system';

    // Verify spec group exists
    const specGroupRepo = yield* SpecGroupRepository;
    const maybeSpecGroup = yield* specGroupRepo.getById(specGroupId);

    if (Option.isNone(maybeSpecGroup)) {
      return yield* new SpecGroupNotFoundError({
        message: `Spec group with id ${specGroupId} not found`,
        cause: undefined,
      });
    }

    const specGroup = maybeSpecGroup.value;

    // Get webhook service to check URL is configured
    const webhookService = yield* WebhookService;
    const webhookUrl = yield* webhookService.getWebhookUrl();

    // Create agent task record (AC6.7)
    const taskRepo = yield* AgentTaskRepository;
    const taskId = randomUUID();
    const now = new Date().toISOString();

    const context = {
      specGroupId,
      specGroupName: specGroup.name,
      triggeredBy: actor,
      triggeredAt: now,
    };

    const task = yield* taskRepo.create({
      id: taskId,
      specGroupId,
      action,
      context,
      webhookUrl,
    });

    // Dispatch webhook (AC6.2, AC6.3)
    const dispatchResult = yield* webhookService
      .dispatch(specGroupId, action, context)
      .pipe(
        Effect.map((result) => ({
          ...result,
          taskId,
        })),
        Effect.tapError(() =>
          // Update task status on failure
          taskRepo
            .updateStatus({
              taskId,
              status: AgentTaskStatus.FAILED,
              errorMessage: 'Webhook dispatch failed',
            })
            .pipe(
              Effect.catchTag('AgentTaskNotFoundError', () =>
                Effect.void,
              ),
            ),
        ),
      );

    // Update task status to dispatched
    const updatedTask = yield* taskRepo
      .updateStatus({
        taskId,
        status: AgentTaskStatus.DISPATCHED,
        responseStatus: dispatchResult.responseStatus,
      })
      .pipe(
        Effect.catchTag('AgentTaskNotFoundError', () =>
          Effect.fail(
            new InternalServerError({
              message: `Task ${taskId} not found after creation`,
              cause: undefined,
            }),
          ),
        ),
      );

    const actionLabel = action === AgentAction.IMPLEMENT ? 'Implementation' : 'Test';

    return {
      task: updatedTask,
      message: `${actionLabel} task dispatched successfully`,
    };
  });

/**
 * Handler for GET /api/agent-tasks/:id
 */
const getAgentTaskHandler = (input: handlerInput) =>
  Effect.gen(function* () {
    const req = yield* input;
    const taskId = req.params.id as string;

    const taskRepo = yield* AgentTaskRepository;
    const maybeTask = yield* taskRepo.getById(taskId);

    if (Option.isNone(maybeTask)) {
      return yield* new AgentTaskNotFoundError({
        message: `Agent task with id ${taskId} not found`,
        cause: undefined,
      });
    }

    return {
      task: maybeTask.value,
    };
  });

/**
 * Exported request handlers.
 */
export const dispatchAgentTaskRequestHandler = generateRequestHandler<
  DispatchResponse,
  | SpecGroupNotFoundError
  | WebhookDispatchError
  | WebhookTimeoutError
  | WebhookNotConfiguredError
  | InternalServerError
  | ZodError
>({
  effectfulHandler: (input) =>
    dispatchHandler(input).pipe(Effect.provide(AppLayer)),
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    [HTTP_RESPONSE.BAD_REQUEST]: {
      errorType: ZodError,
      mapper: (e) => ({ error: z.prettifyError(e as ZodError) }),
    },
    [HTTP_RESPONSE.NOT_FOUND]: {
      errorType: SpecGroupNotFoundError,
      mapper: (e) => ({ error: e.message }),
    },
    [HTTP_RESPONSE.BAD_GATEWAY]: {
      errorType: WebhookDispatchError,
      mapper: (e) => ({ error: e.message, retryable: true }),
    },
    [HTTP_RESPONSE.SERVICE_UNAVAILABLE]: {
      errorType: WebhookNotConfiguredError,
      mapper: (e) => ({ error: e.message }),
    },
    [504]: {
      // Gateway Timeout for webhook timeout
      errorType: WebhookTimeoutError,
      mapper: (e) => ({ error: e.message, retryable: true }),
    },
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      mapper: (e) => ({ error: e.message }),
    },
  },
  successCode: HTTP_RESPONSE.CREATED,
});

export const getAgentTaskRequestHandler = generateRequestHandler<
  GetAgentTaskResponse,
  AgentTaskNotFoundError | InternalServerError
>({
  effectfulHandler: (input) =>
    getAgentTaskHandler(input).pipe(Effect.provide(AppLayer)),
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    [HTTP_RESPONSE.NOT_FOUND]: {
      errorType: AgentTaskNotFoundError,
      mapper: (e) => ({ error: e.message }),
    },
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      mapper: (e) => ({ error: e.message }),
    },
  },
  successCode: HTTP_RESPONSE.OK,
});

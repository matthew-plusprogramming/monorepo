/**
 * Webhook Service Fake
 *
 * Provides a fake implementation of WebhookService for testing.
 */

import { Effect, Layer } from 'effect';

import {
  WebhookDispatchError,
  WebhookNotConfiguredError,
  WebhookTimeoutError,
} from '@/agent-tasks/errors.js';
import {
  WebhookService,
  type WebhookServiceSchema,
} from '@/agent-tasks/webhookService.js';
import {
  type AgentActionType,
  type AgentDispatchContext,
  type WebhookDispatchResult,
} from '@/agent-tasks/types.js';
import { InternalServerError } from '@/types/errors/http.js';

type SuccessEntry = { type: 'success'; value: WebhookDispatchResult };
type ErrorEntry = {
  type: 'error';
  error:
    | WebhookDispatchError
    | WebhookTimeoutError
    | WebhookNotConfiguredError
    | InternalServerError;
};
type ResponseEntry = SuccessEntry | ErrorEntry;

type DispatchCall = {
  readonly specGroupId: string;
  readonly action: AgentActionType;
  readonly context: AgentDispatchContext;
};

type ResponseQueues = {
  readonly dispatch: Array<ResponseEntry>;
  readonly getWebhookUrl: Array<
    | { type: 'success'; value: string }
    | { type: 'error'; error: WebhookNotConfiguredError }
  >;
};

type CallHistory = {
  readonly dispatch: Array<DispatchCall>;
  readonly getWebhookUrl: Array<void>;
};

export type WebhookServiceFake = {
  readonly service: WebhookServiceSchema;
  readonly layer: Layer.Layer<WebhookService, never, never>;
  readonly queueDispatchSuccess: (result: WebhookDispatchResult) => void;
  readonly queueDispatchError: (
    error:
      | WebhookDispatchError
      | WebhookTimeoutError
      | WebhookNotConfiguredError
      | InternalServerError,
  ) => void;
  readonly queueGetWebhookUrlSuccess: (url: string) => void;
  readonly queueGetWebhookUrlError: (error: WebhookNotConfiguredError) => void;
  readonly calls: CallHistory;
  readonly reset: () => void;
};

const dequeue = <T, E>(
  queue: Array<{ type: 'success'; value: T } | { type: 'error'; error: E }>,
  operation: string,
): Effect.Effect<T, E | InternalServerError> => {
  const next = queue.shift();
  if (!next) {
    return Effect.fail(
      new InternalServerError({
        message: `No response queued for WebhookService.${operation}`,
        cause: undefined,
      }) as E | InternalServerError,
    );
  }

  if (next.type === 'success') {
    return Effect.succeed(next.value);
  }

  return Effect.fail(next.error);
};

export const createWebhookServiceFake = (): WebhookServiceFake => {
  const responseQueues: ResponseQueues = {
    dispatch: [],
    getWebhookUrl: [],
  };

  const callHistory: CallHistory = {
    dispatch: [],
    getWebhookUrl: [],
  };

  const service: WebhookServiceSchema = {
    dispatch: (
      specGroupId: string,
      action: AgentActionType,
      context: AgentDispatchContext,
    ) =>
      Effect.sync(() => {
        callHistory.dispatch.push({ specGroupId, action, context });
      }).pipe(
        Effect.flatMap(() => dequeue(responseQueues.dispatch, 'dispatch')),
      ),

    getWebhookUrl: () =>
      Effect.sync(() => {
        callHistory.getWebhookUrl.push();
      }).pipe(
        Effect.flatMap(() => {
          const next = responseQueues.getWebhookUrl.shift();
          if (!next) {
            return Effect.fail(
              new WebhookNotConfiguredError({
                message: 'No response queued for WebhookService.getWebhookUrl',
                cause: undefined,
              }),
            );
          }
          if (next.type === 'success') {
            return Effect.succeed(next.value);
          }
          return Effect.fail(next.error);
        }),
      ),
  };

  return {
    service,
    layer: Layer.succeed(WebhookService, service),
    queueDispatchSuccess: (result: WebhookDispatchResult): void => {
      responseQueues.dispatch.push({ type: 'success', value: result });
    },
    queueDispatchError: (
      error:
        | WebhookDispatchError
        | WebhookTimeoutError
        | WebhookNotConfiguredError
        | InternalServerError,
    ): void => {
      responseQueues.dispatch.push({ type: 'error', error });
    },
    queueGetWebhookUrlSuccess: (url: string): void => {
      responseQueues.getWebhookUrl.push({ type: 'success', value: url });
    },
    queueGetWebhookUrlError: (error: WebhookNotConfiguredError): void => {
      responseQueues.getWebhookUrl.push({ type: 'error', error });
    },
    calls: callHistory,
    reset: (): void => {
      responseQueues.dispatch.length = 0;
      responseQueues.getWebhookUrl.length = 0;
      callHistory.dispatch.length = 0;
      callHistory.getWebhookUrl.length = 0;
    },
  };
};

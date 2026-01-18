/**
 * Webhook Dispatch Service
 *
 * Handles dispatching webhooks to agent containers with timeout handling.
 */

import { Context, Effect } from 'effect';

import { InternalServerError } from '@/types/errors/http.js';

import {
  WebhookDispatchError,
  WebhookNotConfiguredError,
  WebhookTimeoutError,
} from './errors.js';
import {
  AgentTaskStatus,
  type AgentActionType,
  type AgentDispatchContext,
  type AgentWebhookPayload,
  type WebhookDispatchResult,
} from './types.js';

/**
 * Webhook timeout in milliseconds (10 seconds as per spec).
 */
export const WEBHOOK_TIMEOUT_MS = 10000;

/**
 * Schema for the WebhookService.
 */
export type WebhookServiceSchema = {
  readonly dispatch: (
    specGroupId: string,
    action: AgentActionType,
    context: AgentDispatchContext,
  ) => Effect.Effect<
    WebhookDispatchResult,
    | WebhookDispatchError
    | WebhookTimeoutError
    | WebhookNotConfiguredError
    | InternalServerError,
    never
  >;

  readonly getWebhookUrl: () => Effect.Effect<
    string,
    WebhookNotConfiguredError,
    never
  >;
};

export class WebhookService extends Context.Tag('WebhookService')<
  WebhookService,
  WebhookServiceSchema
>() {}

/**
 * Create a fetch request with timeout.
 */
const fetchWithTimeout = async (
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * Create the live implementation of the WebhookService.
 */
export const createWebhookService = (): WebhookServiceSchema => ({
  getWebhookUrl: () =>
    Effect.gen(function* () {
      const webhookUrl = process.env.AGENT_WEBHOOK_URL;

      if (!webhookUrl) {
        return yield* new WebhookNotConfiguredError({
          message: 'AGENT_WEBHOOK_URL environment variable is not configured',
          cause: undefined,
        });
      }

      return webhookUrl;
    }),

  dispatch: (
    specGroupId: string,
    action: AgentActionType,
    context: AgentDispatchContext,
  ) =>
    Effect.gen(function* () {
      const webhookUrl = process.env.AGENT_WEBHOOK_URL;

      if (!webhookUrl) {
        return yield* new WebhookNotConfiguredError({
          message: 'AGENT_WEBHOOK_URL environment variable is not configured',
          cause: undefined,
        });
      }

      const payload: AgentWebhookPayload = {
        specGroupId,
        action,
        context,
      };

      const result = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetchWithTimeout(
            webhookUrl,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(payload),
            },
            WEBHOOK_TIMEOUT_MS,
          );

          return {
            status: response.status,
            ok: response.ok,
          };
        },
        catch: (error) => {
          // Check if it's an abort error (timeout)
          if (error instanceof Error && error.name === 'AbortError') {
            return new WebhookTimeoutError({
              message: `Webhook dispatch timed out after ${WEBHOOK_TIMEOUT_MS}ms`,
              cause: error,
            });
          }

          return new WebhookDispatchError({
            message: `Failed to dispatch webhook: ${error instanceof Error ? error.message : String(error)}`,
            cause: error,
          });
        },
      });

      // Handle timeout error from the catch block
      if (result instanceof WebhookTimeoutError) {
        return yield* result;
      }

      if (result instanceof WebhookDispatchError) {
        return yield* result;
      }

      // Check if the response indicates success (2xx status)
      if (!result.ok) {
        return yield* new WebhookDispatchError({
          message: `Webhook dispatch failed with status ${result.status}`,
          cause: undefined,
        });
      }

      return {
        success: true,
        taskId: '', // Will be set by the caller
        responseStatus: result.status,
      } satisfies WebhookDispatchResult;
    }),
});

/**
 * Agent Task Errors
 *
 * Custom error types for agent task operations.
 */

import { Data } from 'effect';

import type { GenericErrorPayload } from '@/types/errors/index.js';

/**
 * Error thrown when an agent task is not found.
 */
export class AgentTaskNotFoundError extends Data.TaggedError(
  'AgentTaskNotFoundError',
)<GenericErrorPayload> {}

/**
 * Error thrown when webhook dispatch fails.
 */
export class WebhookDispatchError extends Data.TaggedError(
  'WebhookDispatchError',
)<GenericErrorPayload> {}

/**
 * Error thrown when webhook times out.
 */
export class WebhookTimeoutError extends Data.TaggedError(
  'WebhookTimeoutError',
)<GenericErrorPayload> {}

/**
 * Error thrown when webhook URL is not configured.
 */
export class WebhookNotConfiguredError extends Data.TaggedError(
  'WebhookNotConfiguredError',
)<GenericErrorPayload> {}

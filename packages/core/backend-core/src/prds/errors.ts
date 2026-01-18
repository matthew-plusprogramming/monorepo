/**
 * PRD Errors
 *
 * Custom error types for PRD operations.
 */

import { Data } from 'effect';

import type { GenericErrorPayload } from '@/types/errors/index.js';

/**
 * Error thrown when a PRD is not found.
 */
export class PrdNotFoundError extends Data.TaggedError('PrdNotFoundError')<GenericErrorPayload> {}

/**
 * Error thrown when the Google Docs API fails.
 */
export class GoogleDocsApiError extends Data.TaggedError('GoogleDocsApiError')<
  GenericErrorPayload & {
    readonly statusCode?: number;
    readonly retryable: boolean;
  }
> {}

/**
 * Error thrown when a PRD operation fails due to a conflict.
 */
export class PrdConflictError extends Data.TaggedError('PrdConflictError')<GenericErrorPayload> {}

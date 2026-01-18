/**
 * Spec Group Errors
 *
 * Custom error types for spec group operations.
 */

import { Data } from 'effect';

import type { GenericErrorPayload } from '@/types/errors/index.js';

/**
 * Error thrown when a spec group is not found.
 */
export class SpecGroupNotFoundError extends Data.TaggedError(
  'SpecGroupNotFoundError',
)<GenericErrorPayload> {}

/**
 * Error thrown when a state transition is invalid.
 */
export class InvalidStateTransitionError extends Data.TaggedError(
  'InvalidStateTransitionError',
)<GenericErrorPayload> {}

/**
 * Error thrown when a spec group operation fails due to a conflict.
 */
export class SpecGroupConflictError extends Data.TaggedError(
  'SpecGroupConflictError',
)<GenericErrorPayload> {}

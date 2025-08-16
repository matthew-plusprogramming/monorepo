import { Data } from 'effect';

import type { GenericErrorPayload } from '../errors';

// 400 level errors
export class NotFoundError extends Data.TaggedError(
  'NotFoundError',
)<GenericErrorPayload> {}

export class ConflictError extends Data.TaggedError(
  'ConflictError',
)<GenericErrorPayload> {}

// 500 level errors
export class InternalServerError extends Data.TaggedError(
  'InternalServerError',
)<GenericErrorPayload> {}

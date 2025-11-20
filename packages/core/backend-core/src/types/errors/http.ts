import { Data } from 'effect';

import type { GenericErrorPayload } from '@/types/errors/index.js';

// 400 level errors
export class BadRequestError extends Data.TaggedError(
  'BadRequestError',
)<GenericErrorPayload> {}

export class UnauthorizedError extends Data.TaggedError(
  'UnauthorizedError',
)<GenericErrorPayload> {}

export class ForbiddenError extends Data.TaggedError(
  'ForbiddenError',
)<GenericErrorPayload> {}

export class NotFoundError extends Data.TaggedError(
  'NotFoundError',
)<GenericErrorPayload> {}

export class ConflictError extends Data.TaggedError(
  'ConflictError',
)<GenericErrorPayload> {}

export class ThrottledError extends Data.TaggedError(
  'ThrottledError',
)<GenericErrorPayload> {}

// 500 level errors
export class InternalServerError extends Data.TaggedError(
  'InternalServerError',
)<GenericErrorPayload> {}

export class BadGatewayError extends Data.TaggedError(
  'BadGatewayError',
)<GenericErrorPayload> {}

export class ServiceUnavailableError extends Data.TaggedError(
  'ServiceUnavailableError',
)<GenericErrorPayload> {}

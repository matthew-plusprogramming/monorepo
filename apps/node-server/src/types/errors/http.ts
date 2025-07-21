import { Data } from 'effect';

import type { GenericErrorPayload } from '../errors';

export class InternalServerError extends Data.TaggedError(
  'InternalServerError',
)<GenericErrorPayload> {}

export class NotFoundError extends Data.TaggedError(
  'NotFoundError',
)<GenericErrorPayload> {}

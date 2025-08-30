import { Data } from 'effect';

import type { GenericErrorPayload } from '.';

// Rate limiting

export class RateLimitExceededError extends Data.TaggedError(
  'RateLimitExceededError',
)<GenericErrorPayload> {}

// Deny list

export class DenyListedError extends Data.TaggedError(
  'DenyListedError',
)<GenericErrorPayload> {}

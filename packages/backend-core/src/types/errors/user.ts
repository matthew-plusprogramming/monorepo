import { Data } from 'effect';

import type { GenericErrorPayload } from '../errors';

// Login

export class UserNotFoundError extends Data.TaggedError(
  'UserNotFoundError',
)<GenericErrorPayload> {}

export class UserNotVerifiedError extends Data.TaggedError(
  'UserNotVerifiedError',
)<GenericErrorPayload> {}

export class UserInvalidCredentialsError extends Data.TaggedError(
  'InvalidUserCredentialsError',
)<GenericErrorPayload> {}

// Registration

export class UserAlreadyExistsError extends Data.TaggedError(
  'UserAlreadyExistsError',
)<GenericErrorPayload> {}

// Request

export class UserNotAuthenticatedError extends Data.TaggedError(
  'UserNotAuthenticatedError',
)<GenericErrorPayload> {}

export class UserTokenExpiredError extends Data.TaggedError(
  'UserTokenExpiredError',
)<GenericErrorPayload> {}

export class UserTokenInvalidError extends Data.TaggedError(
  'UserTokenInvalidError',
)<GenericErrorPayload> {}

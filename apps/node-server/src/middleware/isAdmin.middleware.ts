import {
  ForbiddenError,
  type handlerInput,
  HTTP_RESPONSE,
  UserNotAuthenticatedError,
} from '@packages/backend-core';
import { ADMIN_ROLE } from '@packages/backend-core/auth';
import { Effect } from 'effect';
import type { RequestHandler } from 'express';

const isAdminMiddlewareHandler = (
  input: handlerInput,
): Effect.Effect<void, UserNotAuthenticatedError | ForbiddenError> =>
  Effect.gen(function* () {
    const req = yield* input;
    const authenticatedUser = req.user;

    if (!authenticatedUser) {
      return yield* new UserNotAuthenticatedError({
        message: 'User not authenticated',
        cause: undefined,
      });
    }

    if (authenticatedUser.role !== ADMIN_ROLE) {
      return yield* new ForbiddenError({
        message: 'User role is not authorized for admin access',
        cause: undefined,
      });
    }
  });

export const isAdminMiddlewareRequestHandler: RequestHandler = async (
  req,
  res,
  next,
) => {
  await Effect.succeed(req)
    .pipe(isAdminMiddlewareHandler)
    .pipe(
      Effect.catchTag('UserNotAuthenticatedError', () =>
        Effect.fail(res.status(HTTP_RESPONSE.UNAUTHORIZED).send()),
      ),
    )
    .pipe(
      Effect.catchTag('ForbiddenError', () =>
        Effect.fail(res.status(HTTP_RESPONSE.FORBIDDEN).send()),
      ),
    )
    .pipe(
      Effect.tap(() => {
        next();
      }),
    )
    .pipe(Effect.runPromise);
};

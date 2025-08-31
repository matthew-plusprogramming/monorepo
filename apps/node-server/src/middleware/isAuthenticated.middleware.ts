import {
  type handlerInput,
  HTTP_RESPONSE,
  UserNotAuthenticatedError,
  UserTokenInvalidError,
} from '@packages/backend-core';
import { UserTokenSchema } from '@packages/schemas/user';
import { Effect } from 'effect';
import type { RequestHandler } from 'express';
import { verify } from 'jsonwebtoken';
import z from 'zod';

import {
  ApplicationLoggerService,
  LoggerService,
} from '../services/logger.service';

const isAuthenticatedMiddlewareHandler = (
  input: handlerInput,
): Effect.Effect<void, UserNotAuthenticatedError | UserTokenInvalidError> =>
  Effect.gen(function* () {
    const logger = yield* LoggerService;
    const req = yield* input;

    const auth = req.headers.authorization;
    if (!auth) {
      return yield* new UserNotAuthenticatedError({
        message: 'Authorization header not provided',
      });
    } else {
      const token = auth.split(' ')[1];

      if (!token || z.jwt().safeParse(token).success === false) {
        return yield* new UserTokenInvalidError({
          message: 'Authorization token invalid',
        });
      } else {
        const decodedJWT = yield* Effect.try({
          try: () => verify(token, process.env.JWT_SECRET),
          catch: () =>
            new UserNotAuthenticatedError({
              message: 'Error validating token',
            }),
        });

        const userToken = yield* Effect.try({
          try: () => UserTokenSchema.parse(decodedJWT),
          catch: () =>
            new UserTokenInvalidError({
              message: 'Authorization token invalid',
            }),
        });

        req.user = userToken;
        logger.log(
          `User: ${userToken.sub}, Role: ${userToken.role} Authenticated`,
        );
      }
    }
  }).pipe(Effect.provide(ApplicationLoggerService));

// TODO: Refactor to middleware request handler (make in backend-core)
export const isAuthenticatedMiddlewareRequestHandler: RequestHandler = async (
  req,
  res,
  next,
) => {
  await Effect.succeed(req)
    .pipe(isAuthenticatedMiddlewareHandler)
    .pipe(
      Effect.catchTag('UserNotAuthenticatedError', () =>
        Effect.fail(res.status(HTTP_RESPONSE.UNAUTHORIZED).send()),
      ),
    )
    .pipe(
      Effect.catchTag('UserTokenInvalidError', () =>
        Effect.fail(res.status(HTTP_RESPONSE.BAD_REQUEST).send()),
      ),
    )
    .pipe(Effect.tap(() => next()))
    .pipe(Effect.runPromise);
};

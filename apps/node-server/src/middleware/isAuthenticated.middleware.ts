import { Effect, Either, pipe } from 'effect';
import type { RequestHandler } from 'express';
import { type JwtPayload, verify } from 'jsonwebtoken';
import z from 'zod';

import {
  UserNotAuthenticatedError,
  UserTokenInvalidError,
} from '../types/errors/user';
import type { handlerInput } from '../types/handler';
import { HTTP_RESPONSE } from '../types/http';

const isAuthenticatedMiddlewareHandler = (
  input: handlerInput,
): Effect.Effect<
  string | JwtPayload,
  UserNotAuthenticatedError | UserTokenInvalidError
> => {
  return pipe(
    input,
    Effect.flatMap((req) => {
      const authorization = req.headers.authorization;

      return Effect.if(!!authorization, {
        onFalse: () =>
          Effect.fail(
            new UserNotAuthenticatedError({
              message: 'Authorization header not provided',
            }),
          ),
        onTrue: () => {
          const token = authorization!.split(' ')[1];

          return Effect.if(
            !token || z.jwt().safeParse(token).success === false,
            {
              onTrue: () =>
                Effect.fail(
                  new UserTokenInvalidError({
                    message: 'Authorization token invalid',
                  }),
                ),
              onFalse: () =>
                Effect.try({
                  try: () => verify(token!, process.env.JWT_SECRET),
                  // TODO: implement logging
                  catch: () =>
                    new UserNotAuthenticatedError({
                      message: 'Error validating token',
                    }),
                }),
            },
          );
        },
      });
    }),
  );
};

export const isAuthenticatedMiddlewareRequestHandler: RequestHandler = async (
  req,
  res,
  next,
) => {
  const result = Effect.succeed(req)
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
    .pipe(Effect.either)
    .pipe(Effect.runSync);

  if (Either.isRight(result)) {
    next();
  }
};

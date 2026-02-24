import { Effect, Either } from 'effect';
import type { Request, RequestHandler } from 'express';

import type { handlerInput } from '@/types/handler.js';
import { HTTP_RESPONSE } from '@/types/http.js';

export type GenerateRequestHandlerProps<R, E extends Error> = {
  effectfulHandler: (input: handlerInput) => Effect.Effect<R, E, never>;
  shouldObfuscate: (req: Request, error: E) => boolean;
  statusCodesToErrors: Record<
    number,
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      errorType: new (...args: any[]) => E;
      obfuscatedErrorStatus?: number;
      obfuscatedErrorMessage?: string;
      mapper: (error: E) => unknown;
    }
  >;
  successCode: number;
};

export const generateRequestHandler = <R, E extends Error>({
  effectfulHandler,
  shouldObfuscate,
  statusCodesToErrors,
  successCode,
}: GenerateRequestHandlerProps<R, E>): RequestHandler => {
  return async (req, res) => {
    const result = await Effect.succeed(req)
      .pipe(effectfulHandler)
      .pipe(Effect.either)
      .pipe(Effect.runPromise);

    if (Either.isLeft(result)) {
      const error = result.left;
      let errorMatch = false;

      // TODO: figure out a better way to do this
      console.error(error.cause);

      for (const [
        statusCode,
        {
          errorType,
          obfuscatedErrorStatus = 502,
          obfuscatedErrorMessage = 'Bad Gateway',
          mapper,
        },
      ] of Object.entries(statusCodesToErrors)) {
        Effect.try({
          try: () => {
            // Check both instanceof and _tag for Effect's Data.TaggedError
            // For tagged errors, check if the error's _tag matches the errorType's name
            const isMatch =
              error instanceof errorType ||
              ('_tag' in error && error._tag === errorType.name);
            if (isMatch) {
              if (shouldObfuscate(req, error)) {
                res.status(obfuscatedErrorStatus).send(obfuscatedErrorMessage);
              } else {
                res.status(parseInt(statusCode)).send(mapper(error));
              }
              errorMatch = true;
              return;
            }
          },
          catch: () => {},
        }).pipe(Effect.runSync);
      }

      if (!errorMatch) {
        // AC1.1, AC1.2: Log real error server-side, return generic message to client
        console.error('[UnhandledError]', error.message, error.cause);
        res
          .status(HTTP_RESPONSE.INTERNAL_SERVER_ERROR)
          .send('Internal server error');
      }
    } else {
      res.status(successCode).send(result.right);
    }
  };
};

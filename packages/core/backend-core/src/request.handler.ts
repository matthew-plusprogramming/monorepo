import { Effect, Either } from 'effect';
import type { RequestHandler } from 'express';

import type { handlerInput } from '@/types/handler.js';
import { HTTP_RESPONSE } from '@/types/http.js';

export type GenerateRequestHandlerProps<R, E extends Error> = {
  effectfulHandler: (input: handlerInput) => Effect.Effect<R, E, never>;
  shouldObfuscate: (error: E) => boolean;
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
            if (error instanceof errorType) {
              if (shouldObfuscate(error)) {
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
        res.status(HTTP_RESPONSE.INTERNAL_SERVER_ERROR).send(error.message);
      }
    } else {
      res.status(successCode).send(result.right);
    }
  };
};

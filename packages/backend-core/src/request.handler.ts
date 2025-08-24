import { Effect, Either } from 'effect';
import type { RequestHandler } from 'express';

import type { handlerInput } from './types/handler';
import { HTTP_RESPONSE } from './types/http';

export type GenerateRequestHandlerProps<R, E extends Error> = {
  effectfulHandler: (input: handlerInput) => Effect.Effect<R, E>;
  statusCodesToErrors: Record<
    number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { errorType: new (...args: any[]) => E; mapper: (error: E) => any }
  >;
  successCode: number;
};

// TODO: Allow for a obfuscate config to be passed (either all, or condition and
// TODO: what the obfuscation error resolves to)
export const generateRequestHandler = <R, E extends Error>({
  effectfulHandler,
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
      for (const [statusCode, { errorType, mapper }] of Object.entries(
        statusCodesToErrors,
      )) {
        Effect.try({
          try: () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (error instanceof (errorType as any)) {
              res.status(parseInt(statusCode)).send(mapper(error));
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

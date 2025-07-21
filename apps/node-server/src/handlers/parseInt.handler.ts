import { Effect, pipe } from 'effect';
import type { RequestHandler } from 'express';

import { ParseError } from '../types/errors';
import type { handlerInput } from '../types/handler';
const parseIntHandler = (
  input: handlerInput,
): Effect.Effect<number, ParseError> => {
  return pipe(
    input,
    Effect.flatMap((req) => {
      const parsed = parseInt(req.body.data);

      if (isNaN(parsed)) {
        return Effect.fail(new ParseError({ message: 'Integer not provided' }));
      }
      return Effect.succeed(parsed);
    }),
  );
};

export const parseIntRequestHandler: RequestHandler = async (req, res) => {
  const result = Effect.succeed(req)
    .pipe(parseIntHandler)
    .pipe(
      Effect.catchTag('ParseError', (error) => {
        console.error('Parse error:', error.message);
        return Effect.succeed(`Error: ${error.message}`);
      }),
    );

  res.send(Effect.runSync(result));
};

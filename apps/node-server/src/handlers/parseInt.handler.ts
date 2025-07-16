import { Effect, pipe } from 'effect';

import { ParseError } from '../types/errors';
import type { handlerInput } from '../types/handler';

export const parseIntHandler = (
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

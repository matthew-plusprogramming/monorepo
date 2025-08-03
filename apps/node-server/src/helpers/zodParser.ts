import { Effect } from 'effect';
import type { ZodType } from 'zod';
import { type output, ZodError } from 'zod';

import { InternalServerError } from '../types/errors/http';

export const parseInput = <T extends ZodType>(
  schema: T,
  toParse: unknown,
): Effect.Effect<output<T>, InternalServerError | ZodError> =>
  Effect.try({
    try: () => schema.parse(toParse),
    catch: (error) => {
      if (error instanceof Error) {
        if (error instanceof ZodError) {
          return error;
        }
        return new InternalServerError(error);
      }
      return new InternalServerError({
        message: 'An unknown error occurred',
      });
    },
  });

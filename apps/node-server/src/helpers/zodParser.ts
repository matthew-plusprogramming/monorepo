import { InternalServerError } from '@packages/backend-core';
import { Effect } from 'effect';
import { type output, ZodError, type ZodType } from 'zod';

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
        return new InternalServerError({
          message: 'Failed to parse input',
          cause: error,
        });
      }
      return new InternalServerError({
        message: 'An unknown error occurred',
        cause: error,
      });
    },
  });

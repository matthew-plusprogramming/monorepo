import {
  generateRequestHandler,
  type handlerInput,
  HTTP_RESPONSE,
  InternalServerError,
  NotFoundError,
} from '@packages/backend-core';
import {
  GetUserSchema,
  type User,
  type UserPublic,
} from '@packages/schemas/user';
import { Effect } from 'effect';
import z, { ZodError } from 'zod';

import { parseInput } from '@/helpers/zodParser';
import { UserRepo } from '@/services/userRepo.service';

const getUserHandler = (
  input: handlerInput,
): Effect.Effect<
  UserPublic,
  InternalServerError | ZodError | NotFoundError,
  UserRepo
> => {
  return Effect.gen(function* () {
    const req = yield* input;

    const parsedInput = yield* parseInput<typeof GetUserSchema>(
      GetUserSchema,
      req.params?.identifier,
    );

    const userRepo = yield* UserRepo;
    const maybeUser = yield* userRepo.findByIdentifier(parsedInput);

    if (maybeUser._tag === 'None') {
      return yield* new NotFoundError({
        message: `User not found for identifier: ${parsedInput}`,
      });
    }

    return maybeUser.value as unknown as User;
  });
};

export const getUserRequestHandler = generateRequestHandler<
  UserPublic,
  NotFoundError | InternalServerError | ZodError
>({
  effectfulHandler: getUserHandler,
  shouldObfuscate: () => true,
  statusCodesToErrors: {
    [HTTP_RESPONSE.BAD_REQUEST]: {
      errorType: ZodError,
      mapper: (e) => z.prettifyError(e as ZodError),
    },
    [HTTP_RESPONSE.NOT_FOUND]: {
      errorType: NotFoundError,
      mapper: (e) => e.message,
    },
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      mapper: (e) => e.message,
    },
  },
  successCode: HTTP_RESPONSE.SUCCESS,
});

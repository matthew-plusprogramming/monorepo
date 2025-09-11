import { randomUUID } from 'node:crypto';

import argon2 from '@node-rs/argon2';
import {
  ConflictError,
  generateRequestHandler,
  type handlerInput,
  HTTP_RESPONSE,
  InternalServerError,
} from '@packages/backend-core';
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  USER_ROLE,
} from '@packages/backend-core/auth';
import {
  RegisterInputSchema,
  type UserCreate,
  type UserToken,
} from '@packages/schemas/user';
import { Effect } from 'effect';
import { sign } from 'jsonwebtoken';
import z, { ZodError } from 'zod';

import { parseInput } from '@/helpers/zodParser';
import { UserRepo } from '@/services/userRepo.service';

const registerHandler = (
  input: handlerInput,
): Effect.Effect<
  string,
  ConflictError | InternalServerError | ZodError,
  UserRepo
> => {
  return Effect.gen(function* () {
    const req = yield* input;

    const parsedInput = yield* parseInput<typeof RegisterInputSchema>(
      RegisterInputSchema,
      req.body,
    );

    const userRepo = yield* UserRepo;
    const userId = randomUUID();

    const maybeExisting = yield* userRepo.findByIdentifier(parsedInput.email);
    if (maybeExisting._tag === 'Some') {
      return yield* new ConflictError({
        message: 'User with email already exists',
      });
    }

    const hashedPassword = yield* Effect.promise(() =>
      argon2.hash(parsedInput.password, {
        secret: Buffer.from(process.env.PEPPER),
      }),
    );

    const userToCreate: UserCreate = {
      id: userId,
      username: parsedInput.username,
      email: parsedInput.email,
      passwordHash: hashedPassword,
    };
    yield* userRepo.create(userToCreate);

    const now = Date.now();
    const inOneHour = now + 60 * 60 * 1000;

    const userToken = {
      iss: JWT_ISSUER,
      sub: userId,
      aud: JWT_AUDIENCE,
      exp: inOneHour,
      iat: now,
      jti: randomUUID(),
      role: USER_ROLE,
    } satisfies UserToken;

    return sign(userToken, process.env.JWT_SECRET);
  });
};

export const registerRequestHandler = generateRequestHandler<
  string,
  ConflictError | InternalServerError | ZodError
>({
  effectfulHandler: registerHandler,
  shouldObfuscate: () => true,
  statusCodesToErrors: {
    [HTTP_RESPONSE.BAD_REQUEST]: {
      errorType: ZodError,
      mapper: (e) => z.prettifyError(e as ZodError),
    },
    [HTTP_RESPONSE.CONFLICT]: {
      errorType: ConflictError,
      mapper: (e) => e.message,
    },
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      mapper: (e) => e.message,
    },
  },
  successCode: HTTP_RESPONSE.CREATED,
});

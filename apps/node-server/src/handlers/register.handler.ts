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
  type RegisterInput,
  RegisterInputSchema,
  type UserCreate,
} from '@packages/schemas/user';
import { Effect } from 'effect';
import z, { ZodError } from 'zod';

import { buildUserToken, signToken } from '@/helpers/token';
import { parseInput } from '@/helpers/zodParser';
import { AppLayer } from '@/layers/app.layer';
import { UserRepo, type UserRepoSchema } from '@/services/userRepo.service';

const parseRegistrationInput = (
  body: unknown,
): Effect.Effect<RegisterInput, InternalServerError | ZodError> =>
  parseInput<typeof RegisterInputSchema>(RegisterInputSchema, body);

const ensureUserDoesNotExist = (
  userRepo: UserRepoSchema,
  identifiers: Pick<z.infer<typeof RegisterInputSchema>, 'email' | 'username'>,
): Effect.Effect<void, ConflictError | InternalServerError> =>
  Effect.gen(function* () {
    const { email, username } = identifiers;
    const maybeExistingByEmail = yield* userRepo.findByIdentifier(email);
    if (maybeExistingByEmail._tag === 'Some') {
      return yield* new ConflictError({
        message: 'User with email already exists',
        cause: undefined,
      });
    }

    const maybeExistingByUsername = yield* userRepo.findByIdentifier(username);
    if (maybeExistingByUsername._tag === 'Some') {
      return yield* new ConflictError({
        message: 'User with username already exists',
        cause: undefined,
      });
    }
  });

const hashPassword = (
  password: string,
): Effect.Effect<string, InternalServerError> =>
  Effect.tryPromise({
    try: () =>
      argon2.hash(password, {
        secret: Buffer.from(process.env.PEPPER),
      }),
    catch: (error) => {
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      const message =
        error instanceof Error
          ? `Failed to hash password: ${error.message}`
          : 'Failed to hash password';
      return new InternalServerError({
        message,
        cause: normalizedError,
      });
    },
  });

const createUserToPersist = (
  userId: string,
  input: RegisterInput,
  passwordHash: string,
): UserCreate => ({
  id: userId,
  fullName: String(input.fullName),
  username: String(input.username),
  email: String(input.email),
  passwordHash,
});

const registerHandler = (
  input: handlerInput,
): Effect.Effect<
  string,
  ConflictError | InternalServerError | ZodError,
  UserRepo
> => {
  return Effect.gen(function* () {
    const req = yield* input;

    const parsedInput = yield* parseRegistrationInput(req.body);
    const userRepo = yield* UserRepo;
    const userId = randomUUID();
    yield* ensureUserDoesNotExist(userRepo, parsedInput);
    const hashedPassword = yield* hashPassword(parsedInput.password);
    yield* userRepo.create(
      createUserToPersist(userId, parsedInput, hashedPassword),
    );
    const signedToken = yield* signToken(buildUserToken(userId));
    return signedToken;
  });
};

export const registerRequestHandler = generateRequestHandler<
  string,
  ConflictError | InternalServerError | ZodError
>({
  effectfulHandler: (input) =>
    registerHandler(input).pipe(Effect.provide(AppLayer)),
  shouldObfuscate: () => false,
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

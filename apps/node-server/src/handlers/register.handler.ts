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
import { AppLayer } from '@/layers/app.layer';
import { UserRepo, type UserRepoSchema } from '@/services/userRepo.service';

const parseRegistrationInput = (
  body: unknown,
): Effect.Effect<
  z.infer<typeof RegisterInputSchema>,
  InternalServerError | ZodError
> => parseInput<typeof RegisterInputSchema>(RegisterInputSchema, body);

const ensureUserDoesNotExist = (
  userRepo: UserRepoSchema,
  email: string,
): Effect.Effect<void, ConflictError | InternalServerError> =>
  Effect.gen(function* () {
    const maybeExisting = yield* userRepo.findByIdentifier(email);
    if (maybeExisting._tag === 'Some') {
      return yield* new ConflictError({
        message: 'User with email already exists',
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
    catch: (error) =>
      new InternalServerError({
        message:
          error instanceof Error
            ? `Failed to hash password: ${error.message}`
            : 'Failed to hash password',
        cause: error,
      }),
  });

const createUserToPersist = (
  userId: string,
  input: z.infer<typeof RegisterInputSchema>,
  passwordHash: string,
): UserCreate => ({
  id: userId,
  username: input.username,
  email: input.email,
  passwordHash,
});

const buildUserToken = (userId: string): UserToken => {
  const issuedAtSeconds = Date.now() / 1000;

  return {
    iss: JWT_ISSUER,
    sub: userId,
    aud: JWT_AUDIENCE,
    exp: issuedAtSeconds + 60 * 60,
    iat: issuedAtSeconds,
    jti: randomUUID(),
    role: USER_ROLE,
  };
};

const signToken = (
  payload: UserToken,
): Effect.Effect<string, InternalServerError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        sign(
          payload,
          process.env.JWT_SECRET,
          {
            algorithm: 'HS256',
          },
          (err, token) => {
            if (err || !token) {
              reject(
                new Error(
                  err ? `JWT sign error: ${err.message}` : 'No token returned',
                ),
              );
            } else {
              resolve(token);
            }
          },
        );
      }),
    catch: (error) =>
      new InternalServerError({
        message:
          error instanceof Error
            ? `Failed to sign JWT: ${error.message}`
            : 'Failed to sign JWT',
        cause: error,
      }),
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
    yield* ensureUserDoesNotExist(userRepo, parsedInput.email);
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

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

    const hashedPassword = yield* Effect.tryPromise({
      try: () =>
        argon2.hash(parsedInput.password, {
          secret: Buffer.from(process.env.PEPPER),
        }),
      catch: (error) =>
        new InternalServerError({
          message:
            error instanceof Error
              ? `Failed to hash password: ${error.message}`
              : 'Failed to hash password',
        }),
    });

    const userToCreate: UserCreate = {
      id: userId,
      username: parsedInput.username,
      email: parsedInput.email,
      passwordHash: hashedPassword,
    };
    yield* userRepo.create(userToCreate);

    const nowSeconds = Date.now() / 1000;
    const inOneHourSeconds = nowSeconds + 60 * 60;

    const userToken = {
      iss: JWT_ISSUER,
      sub: userId,
      aud: JWT_AUDIENCE,
      exp: inOneHourSeconds,
      iat: nowSeconds,
      jti: randomUUID(),
      role: USER_ROLE,
    } satisfies UserToken;

    const signResult = yield* Effect.tryPromise({
      try: () =>
        new Promise<string>((resolve, reject) => {
          sign(
            userToken,
            process.env.JWT_SECRET,
            {
              algorithm: 'HS256',
            },
            (err, token) => {
              if (err || !token) {
                reject(
                  new Error(
                    err
                      ? `JWT sign error: ${err.message}`
                      : 'No token returned',
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
        }),
    });

    return signResult;
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

import argon2 from '@node-rs/argon2';
import {
  generateRequestHandler,
  type handlerInput,
  HTTP_RESPONSE,
  InternalServerError,
  UserInvalidCredentialsError,
} from '@packages/backend-core';
import { LoginInputSchema } from '@packages/schemas/user';
import { Effect } from 'effect';
import z, { ZodError } from 'zod';

import { buildUserToken, signToken } from '@/helpers/token';
import { parseInput } from '@/helpers/zodParser';
import { AppLayer } from '@/layers/app.layer';
import { UserRepo } from '@/services/userRepo.service';

const parseLoginInput = (
  body: unknown,
): Effect.Effect<
  z.infer<typeof LoginInputSchema>,
  InternalServerError | ZodError
> => parseInput<typeof LoginInputSchema>(LoginInputSchema, body);

const verifyPassword = (
  hash: string,
  password: string,
): Effect.Effect<boolean, InternalServerError> =>
  Effect.tryPromise({
    try: () =>
      argon2.verify(hash, password, {
        secret: Buffer.from(process.env.PEPPER),
      }),
    catch: (error) =>
      new InternalServerError({
        message:
          error instanceof Error
            ? `Failed to verify password: ${error.message}`
            : 'Failed to verify password',
        cause: error,
      }),
  });

const loginHandler = (
  input: handlerInput,
): Effect.Effect<
  string,
  InternalServerError | UserInvalidCredentialsError | ZodError,
  UserRepo
> => {
  return Effect.gen(function* () {
    const req = yield* input;

    const parsedInput = yield* parseLoginInput(req.body);
    const userRepo = yield* UserRepo;
    const maybeCredentials = yield* userRepo.findCredentialsByIdentifier(
      parsedInput.identifier,
    );

    if (maybeCredentials._tag === 'None') {
      return yield* new UserInvalidCredentialsError({
        message: 'Invalid username/email or password',
        cause: undefined,
      });
    }

    const credentials = maybeCredentials.value;
    const passwordMatches = yield* verifyPassword(
      credentials.passwordHash,
      parsedInput.password,
    );

    if (!passwordMatches) {
      return yield* new UserInvalidCredentialsError({
        message: 'Invalid username/email or password',
        cause: undefined,
      });
    }

    const signedToken = yield* signToken(buildUserToken(credentials.id));
    return signedToken;
  });
};

export const loginRequestHandler = generateRequestHandler<
  string,
  InternalServerError | UserInvalidCredentialsError | ZodError
>({
  effectfulHandler: (input) =>
    loginHandler(input).pipe(Effect.provide(AppLayer)),
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    [HTTP_RESPONSE.BAD_REQUEST]: {
      errorType: ZodError,
      mapper: (e) => z.prettifyError(e as ZodError),
    },
    [HTTP_RESPONSE.UNAUTHORIZED]: {
      errorType: UserInvalidCredentialsError,
      mapper: (e) => e.message,
    },
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      mapper: (e) => e.message,
    },
  },
  successCode: HTTP_RESPONSE.OK,
});

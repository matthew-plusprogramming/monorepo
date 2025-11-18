import { randomUUID } from 'node:crypto';

import { InternalServerError } from '@packages/backend-core';
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  USER_ROLE,
} from '@packages/backend-core/auth';
import type { UserToken } from '@packages/schemas/user';
import { Effect } from 'effect';
import { sign } from 'jsonwebtoken';

export const buildUserToken = (userId: string): UserToken => {
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

export const signToken = (
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

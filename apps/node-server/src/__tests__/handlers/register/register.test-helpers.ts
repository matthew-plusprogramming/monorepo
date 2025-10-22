import { HTTP_RESPONSE } from '@packages/backend-core';
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  USER_ROLE,
} from '@packages/backend-core/auth';
import type { Mock } from 'vitest';
import { expect } from 'vitest';

import type { UserRepoFake } from '@/__tests__/fakes/userRepo';

export type JwtPayload = {
  readonly iss: string;
  readonly aud: string;
  readonly exp: number;
  readonly iat: number;
  readonly role: string;
  readonly sub: string;
  readonly jti: string;
  readonly [key: string]: unknown;
};

export type JwtSignCallback = (error: Error | null, token?: string) => void;

export type JwtSignMock = (
  payload: Record<string, unknown>,
  secret: string,
  options: Record<string, unknown> | undefined,
  callback: JwtSignCallback,
) => void;

export type RegisterBody = {
  readonly username: string;
  readonly email: string;
  readonly password: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isJwtPayload = (candidate: unknown): candidate is JwtPayload => {
  if (!isRecord(candidate)) {
    return false;
  }

  const { iss, aud, role, sub, jti, exp, iat } = candidate;

  return (
    typeof iss === 'string' &&
    typeof aud === 'string' &&
    typeof role === 'string' &&
    typeof sub === 'string' &&
    typeof jti === 'string' &&
    typeof exp === 'number' &&
    typeof iat === 'number'
  );
};

const isJwtSignCall = (
  candidate: unknown,
): candidate is [
  Record<string, unknown>,
  string,
  Record<string, unknown> | undefined,
  JwtSignCallback,
] =>
  Array.isArray(candidate) &&
  candidate.length === 4 &&
  isRecord(candidate[0]) &&
  typeof candidate[1] === 'string' &&
  (candidate[2] === undefined ||
    (typeof candidate[2] === 'object' && candidate[2] !== null)) &&
  typeof candidate[3] === 'function';

export const createRegisterBody = ({
  username,
  email,
  password = 'supersecret',
}: {
  readonly username: string;
  readonly email: string;
  readonly password?: string;
}): RegisterBody => ({ username, email, password });

export const prepareSuccessfulRegistration = ({
  hashMock,
  signMock,
  userRepoFake,
  hashResult,
  tokenResult,
}: {
  readonly hashMock: Mock<(password: string, salt?: string) => Promise<string>>;
  readonly signMock: Mock<JwtSignMock>;
  readonly userRepoFake: UserRepoFake;
  readonly hashResult: string;
  readonly tokenResult: string;
}): void => {
  userRepoFake.reset();
  hashMock.mockResolvedValueOnce(hashResult);
  signMock.mockImplementationOnce(
    (_payload, _secret, _options, callback: JwtSignCallback) => {
      callback(null, tokenResult);
    },
  );
  userRepoFake.queueFindNone();
  userRepoFake.queueCreateSuccess();
};

export const assertSuccessfulRegistration = ({
  body,
  captured,
  expectedToken,
  issuedAtIso,
  signMock,
  userRepoFake,
}: {
  readonly body: RegisterBody;
  readonly captured: {
    statusCode?: number;
    sendBody?: unknown;
  };
  readonly expectedToken: string;
  readonly issuedAtIso: string;
  readonly signMock: Mock<JwtSignMock>;
  readonly userRepoFake: UserRepoFake;
}): void => {
  expect(captured.statusCode).toBe(HTTP_RESPONSE.CREATED);
  expect(captured.sendBody).toBe(expectedToken);

  const signCall = signMock.mock.calls[0];
  if (!isJwtSignCall(signCall)) {
    throw new Error('JWT sign call missing');
  }
  const [payload, secret, options] = signCall;
  expect(secret).toBe('shh-its-a-secret');
  expect(options).toMatchObject({ algorithm: 'HS256' });
  if (!isJwtPayload(payload)) {
    throw new Error('JWT payload missing fields');
  }

  const issuedAtMillis = Date.parse(issuedAtIso);
  const expectedIssuedAtSeconds = issuedAtMillis / 1000;
  const expectedExpiresAtSeconds = expectedIssuedAtSeconds + 60 * 60;

  expect(payload).toMatchObject({
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    exp: expectedExpiresAtSeconds,
    iat: expectedIssuedAtSeconds,
    role: USER_ROLE,
  });

  const { sub, jti } = payload;
  if (typeof jti !== 'string' || typeof sub !== 'string') {
    throw new Error('JWT payload missing identifiers');
  }
  expect(jti.length).toBeGreaterThan(0);

  const createCall = userRepoFake.calls.create[0];
  if (!createCall) {
    throw new Error('UserRepo create call missing');
  }
  expect(createCall).toMatchObject({
    username: body.username,
    email: body.email,
    passwordHash: 'hashed-password',
  });
  expect(createCall.id).toBe(sub);
};

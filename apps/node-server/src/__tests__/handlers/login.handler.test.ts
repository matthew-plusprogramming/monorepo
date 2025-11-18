import { HTTP_RESPONSE } from '@packages/backend-core';
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  USER_ROLE,
} from '@packages/backend-core/auth';
import {
  makeRequestContext,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import type { RequestHandler } from 'express';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildUserCreate } from '@/__tests__/builders/user';
import type { UserRepoFake } from '@/__tests__/fakes/userRepo';
import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';
import { withFixedTime } from '@/__tests__/utils/time';
import { mockRandomUUID, restoreRandomUUID } from '@/__tests__/utils/uuid';

import type { JwtSignMock } from './register/register.test-helpers.js';

type ArgonVerifyFn = (
  hash: string,
  password: string,
  options?: Record<string, unknown>,
) => Promise<boolean>;
type ArgonVerifyMock = Mock<ArgonVerifyFn>;

type LoginBody = {
  readonly identifier: string;
  readonly password: string;
};

const userRepoModule = vi.hoisted((): { fake?: UserRepoFake } => ({}));
const argonModule = vi.hoisted((): { verify?: ArgonVerifyMock } => ({}));
const jwtModule = vi.hoisted((): { sign?: Mock<JwtSignMock> } => ({}));

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('@/layers/app.layer', async () => {
  const { createUserRepoFake } = await import('@/__tests__/fakes/userRepo');
  const fake = createUserRepoFake();
  userRepoModule.fake = fake;
  return { AppLayer: fake.layer };
});

vi.mock('@node-rs/argon2', () => {
  const verify = vi.fn<ArgonVerifyFn>();
  argonModule.verify = verify;
  return { default: { verify } };
});

vi.mock('jsonwebtoken', () => {
  const sign = vi.fn<JwtSignMock>();
  jwtModule.sign = sign;
  return { sign };
});

const createLoginBody = ({
  identifier = 'login-user@example.com',
  password = 'supersecret',
}: Partial<LoginBody> = {}): LoginBody => ({
  identifier,
  password,
});

const getUserRepoFake = (): UserRepoFake => {
  if (!userRepoModule.fake) {
    throw new Error('UserRepo fake was not initialized');
  }
  return userRepoModule.fake;
};

const getVerifyMock = (): ArgonVerifyMock => {
  if (!argonModule.verify) {
    throw new Error('argon2 verify mock was not initialized');
  }
  return argonModule.verify;
};

const getSignMock = (): Mock<JwtSignMock> => {
  if (!jwtModule.sign) {
    throw new Error('jwt sign mock was not initialized');
  }
  return jwtModule.sign;
};

const importLoginHandler = async (): Promise<RequestHandler> => {
  const module = await import('@/handlers/login.handler');
  return module.loginRequestHandler;
};

const initializeLoginContext = (): void => {
  vi.resetModules();
  setBundledRuntime(false);
  restoreRandomUUID();
  vi.stubEnv('PEPPER', 'test-pepper');
  vi.stubEnv('JWT_SECRET', 'shh-its-a-secret');
  argonModule.verify?.mockReset();
  jwtModule.sign?.mockReset();
  userRepoModule.fake?.reset();
};

afterEach(() => {
  vi.unstubAllEnvs();
});

const queueCredentialLookup = (
  repoFake: UserRepoFake,
  overrides: Partial<ReturnType<typeof buildUserCreate>> = {},
): void => {
  repoFake.queueFindCredentialsSome(
    buildUserCreate({
      id: '99999999-9999-4999-8999-999999999999',
      username: 'login-user',
      email: 'login-user@example.com',
      passwordHash:
        '$argon2id$v=19$m=65536,t=3,p=4$ZGVmYXVsdC1zYWx0$ZGVmYXVsdC1oYXNo',
      ...overrides,
    }),
  );
};

const assertSuccessfulLogin = ({
  body,
  captured,
  expectedToken,
  issuedAtIso,
  signMock,
  repoFake,
}: {
  readonly body: LoginBody;
  readonly captured: { statusCode?: number; sendBody?: unknown };
  readonly expectedToken: string;
  readonly issuedAtIso: string;
  readonly signMock: Mock<JwtSignMock>;
  readonly repoFake: UserRepoFake;
}): void => {
  expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
  expect(captured.sendBody).toBe(expectedToken);

  const signCall = signMock.mock.calls[0];
  if (!signCall) {
    throw new Error('JWT sign call missing');
  }

  const [payload, secret, options] = signCall;
  expect(secret).toBe('shh-its-a-secret');
  expect(options).toMatchObject({ algorithm: 'HS256' });

  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as { iss?: string }).iss !== 'string'
  ) {
    throw new Error('JWT payload missing fields');
  }

  const issuedAtMillis = Date.parse(issuedAtIso);
  const expectedIssuedAtSeconds = issuedAtMillis / 1000;
  const expectedExpiresAtSeconds = expectedIssuedAtSeconds + 60 * 60;

  expect(payload).toMatchObject({
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    role: USER_ROLE,
    iat: expectedIssuedAtSeconds,
    exp: expectedExpiresAtSeconds,
  });

  expect(repoFake.calls.findCredentialsByIdentifier[0]).toBe(body.identifier);
};

const returns200ForValidCredentials = async (): Promise<void> => {
  // Arrange
  const body = createLoginBody();
  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/login',
    body,
  });
  const handler = await importLoginHandler();
  const repoFake = getUserRepoFake();
  const verifyMock = getVerifyMock();
  const signMock = getSignMock();
  queueCredentialLookup(repoFake, { email: body.identifier });
  verifyMock.mockResolvedValueOnce(true);
  signMock.mockImplementationOnce(
    (
      _payload,
      _secret,
      _options,
      callback: (error: Error | null, token?: string) => void,
    ) => {
      callback(null, 'signed.token.value');
    },
  );

  // Act
  mockRandomUUID('77777777-7777-4777-8777-777777777777');
  await withFixedTime('2024-01-01T00:00:00.000Z', async () => {
    await handler(req, res, vi.fn());
  });

  // Assert
  assertSuccessfulLogin({
    body,
    captured,
    expectedToken: 'signed.token.value',
    issuedAtIso: '2024-01-01T00:00:00.000Z',
    signMock,
    repoFake,
  });
  const verifyCall = verifyMock.mock.calls[0];
  expect(verifyCall?.[0]).toContain('$argon2id$');
  expect(verifyCall?.[1]).toBe(body.password);
  const secretArg = (verifyCall?.[2] as { secret?: unknown })?.secret;
  expect(Buffer.isBuffer(secretArg)).toBe(true);
};

const obfuscatesMissingUserAs502 = async (): Promise<void> => {
  // Arrange
  const body = createLoginBody();
  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/login',
    body,
  });
  const handler = await importLoginHandler();
  const repoFake = getUserRepoFake();
  repoFake.queueFindCredentialsNone();

  // Act
  await handler(req, res, vi.fn());

  // Assert
  expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
  expect(captured.sendBody).toBe('Bad Gateway');
};

const obfuscatesInvalidPasswordAs502 = async (): Promise<void> => {
  // Arrange
  const body = createLoginBody();
  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/login',
    body,
  });
  const handler = await importLoginHandler();
  const verifyMock = getVerifyMock();
  const repoFake = getUserRepoFake();
  queueCredentialLookup(repoFake, { email: body.identifier });
  verifyMock.mockResolvedValueOnce(false);

  // Act
  await handler(req, res, vi.fn());

  // Assert
  expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
  expect(captured.sendBody).toBe('Bad Gateway');
};

const propagatesCredentialLookupFailure = async (): Promise<void> => {
  // Arrange
  const body = createLoginBody();
  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/login',
    body,
  });
  const handler = await importLoginHandler();
  const { InternalServerError } = await import('@packages/backend-core');
  const repoFake = getUserRepoFake();
  repoFake.queueFindCredentialsFailure(
    new InternalServerError({ message: 'ddb failure', cause: undefined }),
  );

  // Act
  await handler(req, res, vi.fn());

  // Assert
  expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
  expect(captured.sendBody).toBe('Bad Gateway');
};

const propagatesVerificationFailure = async (): Promise<void> => {
  // Arrange
  const body = createLoginBody();
  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/login',
    body,
  });
  const handler = await importLoginHandler();
  const verifyMock = getVerifyMock();
  const repoFake = getUserRepoFake();
  queueCredentialLookup(repoFake, { email: body.identifier });
  verifyMock.mockRejectedValueOnce(new Error('argon2 verify failed'));

  // Act
  await handler(req, res, vi.fn());

  // Assert
  expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
  expect(captured.sendBody).toBe('Bad Gateway');
};

const propagatesVerificationFailureForNonError = async (): Promise<void> => {
  // Arrange
  const body = createLoginBody();
  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/login',
    body,
  });
  const handler = await importLoginHandler();
  const verifyMock = getVerifyMock();
  const repoFake = getUserRepoFake();
  queueCredentialLookup(repoFake, { email: body.identifier });
  verifyMock.mockRejectedValueOnce('argon2 unreachable');

  // Act
  await handler(req, res, vi.fn());

  // Assert
  expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
  expect(captured.sendBody).toBe('Bad Gateway');
};

const propagatesJwtFailure = async (): Promise<void> => {
  // Arrange
  const body = createLoginBody();
  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/login',
    body,
  });
  const handler = await importLoginHandler();
  const verifyMock = getVerifyMock();
  const signMock = getSignMock();
  const repoFake = getUserRepoFake();
  queueCredentialLookup(repoFake, { email: body.identifier });
  verifyMock.mockResolvedValueOnce(true);
  signMock.mockImplementationOnce((_payload, _secret, _options, callback) => {
    callback(new Error('jwt sign failed'));
  });

  // Act
  await handler(req, res, vi.fn());

  // Assert
  expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
  expect(captured.sendBody).toBe('Bad Gateway');
};

describe('loginRequestHandler', () => {
  beforeEach(initializeLoginContext);

  it(
    'returns 200 and a token for valid credentials',
    returns200ForValidCredentials,
  );
  it('obfuscates missing users as 502 responses', obfuscatesMissingUserAs502);
  it(
    'obfuscates invalid password attempts as 502 responses',
    obfuscatesInvalidPasswordAs502,
  );
  it(
    'propagates credential lookup failures as obfuscated 502 errors',
    propagatesCredentialLookupFailure,
  );
  it(
    'propagates password verification failures as obfuscated 502 errors',
    propagatesVerificationFailure,
  );
  it(
    'propagates non-Error password verification failures as obfuscated 502 errors',
    propagatesVerificationFailureForNonError,
  );
  it(
    'propagates JWT signing failures as obfuscated 502 errors',
    propagatesJwtFailure,
  );
});

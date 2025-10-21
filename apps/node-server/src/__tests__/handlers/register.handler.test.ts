import { HTTP_RESPONSE, InternalServerError } from '@packages/backend-core';
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  USER_ROLE,
} from '@packages/backend-core/auth';
import type { RequestHandler } from 'express';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable max-lines */
import type { UserRepoFake } from '@/__tests__/fakes/userRepo';
// no need for value imports; use simple tuple typing instead
import { makeRequestContext } from '@/__tests__/utils/express';
import { withFixedTime } from '@/__tests__/utils/time';
import { restoreRandomUUID } from '@/__tests__/utils/uuid';

// Hoisted state to capture the fake exposed by the AppLayer mock
const userRepoModule = vi.hoisted((): { fake?: UserRepoFake } => ({}));
const argonModule = vi.hoisted((): { hash?: ReturnType<typeof vi.fn> } => ({}));
const jwtModule = vi.hoisted((): { sign?: Mock<JwtSignMock> } => ({}));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

type JwtPayload = {
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  role: string;
  sub: string;
  jti: string;
  [key: string]: unknown;
};

type JwtSignCallback = (error: Error | null, token?: string) => void;
type JwtSignMock = (
  payload: Record<string, unknown>,
  secret: string,
  options: Record<string, unknown> | undefined,
  callback: JwtSignCallback,
) => void;

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

vi.hoisted(() => {
  Reflect.set(globalThis, '__BUNDLED__', false);
  return undefined;
});

vi.mock('@/clients/cdkOutputs', () => ({
  usersTableName: 'users-table',
}));

vi.mock('@/layers/app.layer', async () => {
  const { createUserRepoFake } = await import('@/__tests__/fakes/userRepo');
  const fake = createUserRepoFake();
  userRepoModule.fake = fake;
  return { AppLayer: fake.layer };
});

vi.mock('@node-rs/argon2', () => {
  const hash = vi.fn<(password: string, salt?: string) => Promise<string>>();
  argonModule.hash = hash;
  return { default: { hash } };
});

vi.mock('jsonwebtoken', () => {
  const sign = vi.fn<JwtSignMock>();
  jwtModule.sign = sign;
  return { sign };
});

const getUserRepoFake = (): UserRepoFake => {
  if (!userRepoModule.fake) {
    throw new Error('UserRepo fake was not initialized');
  }
  return userRepoModule.fake;
};

const getHashMock = (): ReturnType<typeof vi.fn> => {
  if (!argonModule.hash) {
    throw new Error('argon2 hash mock was not initialized');
  }
  return argonModule.hash;
};

const getSignMock = (): Mock<JwtSignMock> => {
  if (!jwtModule.sign) {
    throw new Error('jwt sign mock was not initialized');
  }
  return jwtModule.sign;
};

type RegisterTestContext = ReturnType<typeof makeRequestContext>;
type RegisterHandler = RequestHandler;

async function importRegisterHandler(): Promise<RegisterHandler> {
  const module = await import('@/handlers/register.handler');
  return module.registerRequestHandler;
}

function initializeRegisterContext(): void {
  vi.resetModules();
  restoreRandomUUID();
  process.env.PEPPER = 'test-pepper';
  process.env.JWT_SECRET = 'shh-its-a-secret';
  argonModule.hash?.mockReset();
  jwtModule.sign?.mockReset();
}

async function returns201ForNewUser(): Promise<void> {
  // Arrange
  const body = createRegisterBody({
    username: 'new-user',
    email: 'new-user@example.com',
  });
  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/register',
    body,
  });

  // Act
  await withFixedTime('2024-01-01T00:00:00.000Z', async () => {
    const handler = await importRegisterHandler();
    prepareSuccessfulRegistration('hashed-password', 'signed.token.value');
    await handler(req, res, vi.fn());
  });

  // Assert
  assertSuccessfulRegistration({
    body,
    captured,
    expectedToken: 'signed.token.value',
    issuedAtIso: '2024-01-01T00:00:00.000Z',
  });
}

async function obfuscatesConflictAs502(): Promise<void> {
  // Arrange
  const body = createRegisterBody({
    username: 'dup',
    email: 'dup@example.com',
  });
  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/register',
    body,
  });
  const handler = await importRegisterHandler();

  const repoFake = resetUserRepoFake();
  repoFake.queueFindSome({
    id: '11111111-1111-1111-1111-111111111111',
    username: 'dup',
    email: 'dup@example.com',
  });

  // Act
  await handler(req, res, vi.fn());

  // Assert
  expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
  expect(captured.sendBody).toBe('Bad Gateway');
}

async function propagatesRepoCreateFailure(): Promise<void> {
  // Arrange
  const handler = await importRegisterHandler();
  getHashMock().mockResolvedValueOnce('hashed-password');

  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/register',
    body: createRegisterBody({ username: 'user', email: 'user@example.com' }),
  });

  const repoFake = resetUserRepoFake();
  repoFake.queueFindNone();
  repoFake.queueCreateFailure(
    new InternalServerError({ message: 'ddb put failed' }),
  );

  // Act
  await handler(req, res, vi.fn());

  // Assert
  expect(captured.statusCode).toBe(HTTP_RESPONSE.INTERNAL_SERVER_ERROR);
  expect(captured.sendBody).toBe('ddb put failed');
}

async function propagatesHashingFailure(): Promise<void> {
  // Arrange
  getHashMock().mockRejectedValueOnce(new Error('argon2 failed'));

  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/register',
    body: createRegisterBody({ username: 'user', email: 'user@example.com' }),
  });

  const handler = await importRegisterHandler();
  const repoFake = resetUserRepoFake();
  repoFake.queueFindNone();

  // Act
  await handler(req, res, vi.fn());

  // Assert
  expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
  expect(captured.sendBody).toBe('Bad Gateway');
}

async function propagatesJwtFailure(): Promise<void> {
  // Arrange
  const handler = await importRegisterHandler();
  getHashMock().mockResolvedValueOnce('hashed-password');
  getSignMock().mockImplementationOnce(
    (_payload, _secret, _options, callback) => {
      callback(new Error('jwt sign failed'));
    },
  );

  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/register',
    body: createRegisterBody({ username: 'user', email: 'user@example.com' }),
  });

  // Act
  await withFixedTime('2024-01-01T00:00:00.000Z', async () => {
    const repoFake = resetUserRepoFake();
    repoFake.queueFindNone();
    repoFake.queueCreateSuccess();
    await handler(req, res, vi.fn());
  });

  // Assert
  expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
  expect(captured.sendBody).toBe('Bad Gateway');
}

function createRegisterBody({
  username,
  email,
  password = 'supersecret',
}: {
  username: string;
  email: string;
  password?: string;
}): { username: string; email: string; password: string } {
  return { username, email, password };
}

function resetUserRepoFake(): UserRepoFake {
  const fake = getUserRepoFake();
  fake.reset();
  return fake;
}

function prepareSuccessfulRegistration(
  hashResult: string,
  tokenResult: string,
): void {
  getHashMock().mockResolvedValueOnce(hashResult);
  getSignMock().mockImplementationOnce(
    (_payload, _secret, _options, callback) => {
      callback(null, tokenResult);
    },
  );
  const repoFake = resetUserRepoFake();
  repoFake.queueFindNone();
  repoFake.queueCreateSuccess();
}

function assertSuccessfulRegistration({
  body,
  captured,
  expectedToken,
  issuedAtIso,
}: {
  body: { username: string; email: string; password: string };
  captured: RegisterTestContext['captured'];
  expectedToken: string;
  issuedAtIso: string;
}): void {
  expect(captured.statusCode).toBe(HTTP_RESPONSE.CREATED);
  expect(captured.sendBody).toBe(expectedToken);

  const signMock = getSignMock();
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

  const createCall = getUserRepoFake().calls.create[0];
  if (!createCall) {
    throw new Error('UserRepo create call missing');
  }
  expect(createCall).toMatchObject({
    username: body.username,
    email: body.email,
    passwordHash: 'hashed-password',
  });
  expect(createCall.id).toBe(sub);
}
describe('registerRequestHandler', () => {
  beforeEach(initializeRegisterContext);

  it('returns 201 and a token for a new user', returns201ForNewUser);
  it(
    'obfuscates conflict as 502 when user already exists',
    obfuscatesConflictAs502,
  );
  it(
    'propagates repo create failure via InternalServerError (obfuscated 502)',
    propagatesRepoCreateFailure,
  );
  it(
    'propagates hashing failure via InternalServerError (obfuscated 502)',
    propagatesHashingFailure,
  );
  it(
    'propagates JWT signing failure via InternalServerError (obfuscated 502)',
    propagatesJwtFailure,
  );
});

/* eslint-enable max-lines */

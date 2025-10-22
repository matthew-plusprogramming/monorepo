import { HTTP_RESPONSE, InternalServerError } from '@packages/backend-core';
import {
  makeRequestContext,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import type { RequestHandler } from 'express';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserRepoFake } from '@/__tests__/fakes/userRepo';
import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';
import { withFixedTime } from '@/__tests__/utils/time';
import { restoreRandomUUID } from '@/__tests__/utils/uuid';

import {
  assertSuccessfulRegistration,
  createRegisterBody,
  type JwtSignMock,
  prepareSuccessfulRegistration,
} from './register/register.test-helpers.js';

// Hoisted state to capture the fake exposed by the AppLayer mock
const userRepoModule = vi.hoisted((): { fake?: UserRepoFake } => ({}));
const argonModule = vi.hoisted((): { hash?: ReturnType<typeof vi.fn> } => ({}));
const jwtModule = vi.hoisted((): { sign?: Mock<JwtSignMock> } => ({}));

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

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

type RegisterHandler = RequestHandler;

async function importRegisterHandler(): Promise<RegisterHandler> {
  const module = await import('@/handlers/register.handler');
  return module.registerRequestHandler;
}

function initializeRegisterContext(): void {
  vi.resetModules();
  setBundledRuntime(false);
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
  let hashMock: ReturnType<typeof getHashMock>;
  let signMock: Mock<JwtSignMock> | undefined;
  let userRepoFake: UserRepoFake | undefined;

  await withFixedTime('2024-01-01T00:00:00.000Z', async () => {
    const handler = await importRegisterHandler();
    hashMock = getHashMock();
    const resolvedSignMock = getSignMock();
    const resolvedUserRepoFake = getUserRepoFake();
    signMock = resolvedSignMock;
    userRepoFake = resolvedUserRepoFake;

    prepareSuccessfulRegistration({
      hashMock,
      signMock: resolvedSignMock,
      userRepoFake: resolvedUserRepoFake,
      hashResult: 'hashed-password',
      tokenResult: 'signed.token.value',
    });
    await handler(req, res, vi.fn());
  });

  // Assert
  if (!signMock) {
    throw new Error('Expected JWT sign mock to be initialized');
  }
  if (!userRepoFake) {
    throw new Error('Expected user repository fake to be initialized');
  }

  assertSuccessfulRegistration({
    body,
    captured,
    expectedToken: 'signed.token.value',
    issuedAtIso: '2024-01-01T00:00:00.000Z',
    signMock,
    userRepoFake,
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

function resetUserRepoFake(): UserRepoFake {
  const fake = getUserRepoFake();
  fake.reset();
  return fake;
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

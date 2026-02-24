import { HTTP_RESPONSE } from '@packages/backend-core';
import {
  makeRequestContext,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import type { RequestHandler } from 'express';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

type ArgonHashFn = (password: string, salt?: string) => Promise<string>;
type ArgonHashMock = Mock<ArgonHashFn>;

// Hoisted state to capture the fake exposed by the AppLayer mock
const userRepoModule = vi.hoisted((): { fake?: UserRepoFake } => ({}));
const argonModule = vi.hoisted((): { hash?: ArgonHashMock } => ({}));
const jwtModule = vi.hoisted((): { sign?: Mock<JwtSignMock> } => ({}));

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('@/layers/app.layer', async () => {
  const { createUserRepoFake } = await import('@/__tests__/fakes/userRepo');
  const fake = createUserRepoFake();
  userRepoModule.fake = fake;
  return { AppLayer: fake.layer };
});

vi.mock('@node-rs/argon2', () => {
  const hash = vi.fn<ArgonHashFn>();
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

const getHashMock = (): ArgonHashMock => {
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

const importRegisterHandler = async (): Promise<RegisterHandler> => {
  const module = await import('@/handlers/register.handler');
  return module.registerRequestHandler;
};

const initializeRegisterContext = (): void => {
  vi.resetModules();
  setBundledRuntime(false);
  restoreRandomUUID();
  vi.stubEnv('PEPPER', 'test-pepper');
  vi.stubEnv('JWT_SECRET', 'shh-its-a-secret');
  argonModule.hash?.mockReset();
  jwtModule.sign?.mockReset();
};

afterEach(() => {
  vi.unstubAllEnvs();
});

const returns201ForNewUser = async (): Promise<void> => {
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
  let hashMock: ArgonHashMock;
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
};

const resetUserRepoFake = (): UserRepoFake => {
  const fake = getUserRepoFake();
  fake.reset();
  return fake;
};

const EMAIL_CONFLICT_MESSAGE = 'User with email already exists';
const USERNAME_CONFLICT_MESSAGE = 'User with username already exists';
const HASH_FAILURE_MESSAGE = 'Failed to hash password: argon2 failed';
const GENERIC_HASH_FAILURE_MESSAGE = 'Failed to hash password';
const JWT_SIGN_FAILURE_MESSAGE =
  'Failed to sign JWT: JWT sign error: jwt sign failed';

const returns409WhenEmailAlreadyExists = async (): Promise<void> => {
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
    fullName: body.fullName,
    username: 'dup',
    email: 'dup@example.com',
  });

  // Act
  await handler(req, res, vi.fn());

  // Assert
  expect(captured.statusCode).toBe(HTTP_RESPONSE.CONFLICT);
  expect(captured.sendBody).toBe(EMAIL_CONFLICT_MESSAGE);
};

const returns409WhenUsernameAlreadyExists = async (): Promise<void> => {
  // Arrange
  const body = createRegisterBody({
    username: 'duplicate-user',
    email: 'unique@example.com',
  });
  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/register',
    body,
  });
  const handler = await importRegisterHandler();

  const repoFake = resetUserRepoFake();
  repoFake.queueFindNone();
  repoFake.queueFindSome({
    id: '22222222-2222-4222-8222-222222222222',
    fullName: body.fullName,
    username: body.username,
    email: 'different@example.com',
  });

  // Act
  await handler(req, res, vi.fn());

  // Assert
  expect(repoFake.calls.findByIdentifier).toEqual([body.email, body.username]);
  expect(captured.statusCode).toBe(HTTP_RESPONSE.CONFLICT);
  expect(captured.sendBody).toBe(USERNAME_CONFLICT_MESSAGE);
};

const propagatesRepoCreateFailure = async (): Promise<void> => {
  // Arrange
  const handler = await importRegisterHandler();
  const { InternalServerError } = await import('@packages/backend-core');
  getHashMock().mockResolvedValueOnce('hashed-password');

  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/register',
    body: createRegisterBody({ username: 'user', email: 'user@example.com' }),
  });

  const repoFake = resetUserRepoFake();
  repoFake.queueFindNone();
  repoFake.queueFindNone();
  repoFake.queueCreateFailure(
    new InternalServerError({ message: 'ddb put failed', cause: undefined }),
  );

  // Act
  await handler(req, res, vi.fn());

  // Assert — AC1.3: InternalServerError mapper returns generic message
  expect(captured.statusCode).toBe(HTTP_RESPONSE.INTERNAL_SERVER_ERROR);
  expect(captured.sendBody).toEqual({ error: 'Internal server error' });
};

const propagatesHashingFailure = async (): Promise<void> => {
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
  repoFake.queueFindNone();

  // Act
  await handler(req, res, vi.fn());

  // Assert — AC1.3: InternalServerError mapper returns generic message
  expect(captured.statusCode).toBe(HTTP_RESPONSE.INTERNAL_SERVER_ERROR);
  expect(captured.sendBody).toEqual({ error: 'Internal server error' });
};

const propagatesHashingFailureWithoutErrorCause = async (): Promise<void> => {
  // Arrange
  getHashMock().mockRejectedValueOnce('argon2 blew up');

  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/register',
    body: createRegisterBody({ username: 'user', email: 'user@example.com' }),
  });

  const handler = await importRegisterHandler();
  const repoFake = resetUserRepoFake();
  repoFake.queueFindNone();
  repoFake.queueFindNone();

  // Act
  await handler(req, res, vi.fn());

  // Assert — AC1.3: InternalServerError mapper returns generic message
  expect(captured.statusCode).toBe(HTTP_RESPONSE.INTERNAL_SERVER_ERROR);
  expect(captured.sendBody).toEqual({ error: 'Internal server error' });
};

const propagatesJwtFailure = async (): Promise<void> => {
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
    repoFake.queueFindNone();
    repoFake.queueCreateSuccess();
    await handler(req, res, vi.fn());
  });

  // Assert — AC1.3: InternalServerError mapper returns generic message
  expect(captured.statusCode).toBe(HTTP_RESPONSE.INTERNAL_SERVER_ERROR);
  expect(captured.sendBody).toEqual({ error: 'Internal server error' });
};

describe('registerRequestHandler', () => {
  beforeEach(initializeRegisterContext);

  it('returns 201 and a token for a new user', returns201ForNewUser);
  it(
    'returns 409 when a user with the email already exists',
    returns409WhenEmailAlreadyExists,
  );
  it(
    'returns 409 when a user with the username already exists',
    returns409WhenUsernameAlreadyExists,
  );
  it(
    'propagates repo create failure via InternalServerError (500)',
    propagatesRepoCreateFailure,
  );
  it(
    'propagates hashing failure via InternalServerError (500)',
    propagatesHashingFailure,
  );
  it(
    'propagates hashing failure when the argon2 rejection is not an Error',
    propagatesHashingFailureWithoutErrorCause,
  );
  it(
    'propagates JWT signing failure via InternalServerError (500)',
    propagatesJwtFailure,
  );
});

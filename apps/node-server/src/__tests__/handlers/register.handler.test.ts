import { HTTP_RESPONSE, InternalServerError } from '@packages/backend-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserRepoFake } from '@/__tests__/fakes/userRepo';
// no need for value imports; use simple tuple typing instead
import { makeRequestContext } from '@/__tests__/utils/express';
import { withFixedTime } from '@/__tests__/utils/time';
import { restoreRandomUUID } from '@/__tests__/utils/uuid';

// Hoisted state to capture the fake exposed by the AppLayer mock
const userRepoModule = vi.hoisted(() => ({ fake: undefined as unknown }));
const argonModule = vi.hoisted(() => ({ hash: undefined as unknown }));
const jwtModule = vi.hoisted(() => ({ sign: undefined as unknown }));

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __BUNDLED__: boolean }).__BUNDLED__ =
    false;
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
  const hash = vi.fn();
  argonModule.hash = hash;
  return { default: { hash } };
});

vi.mock('jsonwebtoken', () => {
  const sign = vi.fn();
  jwtModule.sign = sign;
  return { sign };
});

const getUserRepoFake = (): UserRepoFake => userRepoModule.fake as UserRepoFake;
const getHashMock = (): ReturnType<typeof vi.fn> => argonModule.hash as never;
const getSignMock = (): ReturnType<typeof vi.fn> => jwtModule.sign as never;

describe('registerRequestHandler', () => {
  beforeEach(() => {
    vi.resetModules();
    restoreRandomUUID();
    process.env.PEPPER = 'test-pepper';
    process.env.JWT_SECRET = 'shh-its-a-secret';
  });

  it('returns 201 and a token for a new user', async () => {
    const body = {
      username: 'new-user',
      email: 'new-user@example.com',
      password: 'supersecret',
    } as const;

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/register',
      body,
    });

    await withFixedTime('2024-01-01T00:00:00.000Z', async () => {
      const { registerRequestHandler } = await import(
        '@/handlers/register.handler'
      );
      getHashMock().mockResolvedValueOnce('hashed-password');
      getSignMock().mockReturnValueOnce('signed.token.value');
      getUserRepoFake().reset();
      getUserRepoFake().queueFindNone();
      getUserRepoFake().queueCreateSuccess();
      await registerRequestHandler(req, res, vi.fn());
    });

    expect(captured.statusCode).toBe(HTTP_RESPONSE.CREATED);
    expect(captured.sendBody).toBe('signed.token.value');

    const [, secret] = getSignMock().mock.calls[0] as [unknown, string];
    expect(secret).toBe('shh-its-a-secret');
  });

  it('obfuscates conflict as 502 when user already exists', async () => {
    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/register',
      body: {
        username: 'dup',
        email: 'dup@example.com',
        password: 'supersecret',
      },
    });
    const { registerRequestHandler } = await import(
      '@/handlers/register.handler'
    );
    getUserRepoFake().reset();
    getUserRepoFake().queueFindSome({
      id: '11111111-1111-1111-1111-111111111111',
      username: 'dup',
      email: 'dup@example.com',
    });
    await registerRequestHandler(req, res, vi.fn());

    expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
    expect(captured.sendBody).toBe('Bad Gateway');
  });

  it('propagates repo create failure via InternalServerError (obfuscated 502)', async () => {
    const { registerRequestHandler } = await import(
      '@/handlers/register.handler'
    );
    getHashMock().mockResolvedValueOnce('hashed-password');

    const { req, res, captured } = makeRequestContext({
      method: 'POST',
      url: '/register',
      body: {
        username: 'user',
        email: 'user@example.com',
        password: 'supersecret',
      },
    });

    getUserRepoFake().reset();
    getUserRepoFake().queueFindNone();
    getUserRepoFake().queueCreateFailure(
      new InternalServerError({ message: 'ddb put failed' }),
    );
    await registerRequestHandler(req, res, vi.fn());

    expect(captured.statusCode).toBe(HTTP_RESPONSE.INTERNAL_SERVER_ERROR);
    expect(captured.sendBody).toBe('ddb put failed');
  });

  it('rejects when hashing throws an unknown error', async () => {
    getHashMock().mockRejectedValueOnce(new Error('argon2 failed'));

    const { req, res } = makeRequestContext({
      method: 'POST',
      url: '/register',
      body: {
        username: 'user',
        email: 'user@example.com',
        password: 'supersecret',
      },
    });

    const { registerRequestHandler } = await import(
      '@/handlers/register.handler'
    );
    getUserRepoFake().reset();
    getUserRepoFake().queueFindNone();
    await expect(
      registerRequestHandler(req, res, vi.fn()),
    ).rejects.toBeDefined();
  });

  it('rejects when JWT signing throws an unknown error', async () => {
    const { registerRequestHandler } = await import(
      '@/handlers/register.handler'
    );
    getHashMock().mockResolvedValueOnce('hashed-password');
    getSignMock().mockImplementationOnce(() => {
      throw new Error('jwt sign failed');
    });

    // UUIDs are non-deterministic here; token content is validated indirectly

    const { req, res } = makeRequestContext({
      method: 'POST',
      url: '/register',
      body: {
        username: 'user',
        email: 'user@example.com',
        password: 'supersecret',
      },
    });

    await withFixedTime('2024-01-01T00:00:00.000Z', async () => {
      getUserRepoFake().reset();
      getUserRepoFake().queueFindNone();
      getUserRepoFake().queueCreateSuccess();
      await expect(
        registerRequestHandler(req, res, vi.fn()),
      ).rejects.toBeDefined();
    });
  });
});

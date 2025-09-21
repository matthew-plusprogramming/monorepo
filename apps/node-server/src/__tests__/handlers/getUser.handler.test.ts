import { HTTP_RESPONSE } from '@packages/backend-core';
import type { UserPublic } from '@packages/schemas/user';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildUserPublic } from '@/__tests__/builders/user';
import type { UserRepoFake } from '@/__tests__/fakes/userRepo';
import { makeRequestContext } from '@/__tests__/utils/express';

// Hoisted state to capture the fake exposed by the AppLayer mock
const userRepoModule = vi.hoisted(() => ({ fake: undefined as unknown }));

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

const getUserRepoFake = (): UserRepoFake => userRepoModule.fake as UserRepoFake;

describe('getUserRequestHandler', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns 200 and the user for a valid identifier', async () => {
    const { req, res, captured } = makeRequestContext({
      params: { identifier: buildUserPublic().email },
    });

    const { getUserRequestHandler } = await import(
      '@/handlers/getUser.handler'
    );
    const user: UserPublic = buildUserPublic();
    getUserRepoFake().reset();
    getUserRepoFake().queueFindSome(user);

    await getUserRequestHandler(req, res, vi.fn());

    // Verify the fake was invoked with the parsed identifier
    expect(getUserRepoFake().calls.findByIdentifier[0]).toBe(user.email);
    expect(captured.statusCode).toBe(HTTP_RESPONSE.SUCCESS);
    expect(captured.sendBody).toStrictEqual(user);
  });

  it('obfuscates NotFoundError as 502 when user is missing', async () => {
    const { req, res, captured } = makeRequestContext({
      params: { identifier: '11111111-1111-1111-1111-111111111111' },
    });

    const { getUserRequestHandler } = await import(
      '@/handlers/getUser.handler'
    );
    getUserRepoFake().reset();
    getUserRepoFake().queueFindNone();

    await getUserRequestHandler(req, res, vi.fn());

    expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
    expect(captured.sendBody).toBe('Bad Gateway');
  });

  it('obfuscates Zod validation failures as 502', async () => {
    // No repo call expected since input parsing fails first
    const { req, res, captured } = makeRequestContext({
      params: { identifier: 'not-a-uuid-or-email' },
    });

    const { getUserRequestHandler } = await import(
      '@/handlers/getUser.handler'
    );

    await getUserRequestHandler(req, res, vi.fn());

    expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
    expect(captured.sendBody).toBe('Bad Gateway');
  });
});

import { HTTP_RESPONSE } from '@packages/backend-core';
import {
  makeRequestContext,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import type { UserPublic } from '@packages/schemas/user';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildUserPublic } from '@/__tests__/builders/user';
import type { UserRepoFake } from '@/__tests__/fakes/userRepo';
import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';

// Hoisted state to capture the fake exposed by the AppLayer mock
const userRepoModule = vi.hoisted((): { fake?: UserRepoFake } => ({}));

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('@/layers/app.layer', async () => {
  const { createUserRepoFake } = await import('@/__tests__/fakes/userRepo');
  const fake = createUserRepoFake();
  userRepoModule.fake = fake;
  return { AppLayer: fake.layer };
});

const getUserRepoFake = (): UserRepoFake => {
  if (!userRepoModule.fake) {
    throw new Error('UserRepo fake was not initialized');
  }
  return userRepoModule.fake;
};

describe('getUserRequestHandler', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
  });

  it('returns 200 and the user for a valid identifier', async () => {
    // Arrange
    const { req, res, captured } = makeRequestContext({
      params: { identifier: buildUserPublic().email },
    });

    const { getUserRequestHandler } = await import(
      '@/handlers/getUser.handler'
    );
    const user: UserPublic = buildUserPublic();
    getUserRepoFake().reset();
    getUserRepoFake().queueFindSome(user);

    // Act
    await getUserRequestHandler(req, res, vi.fn());

    // Assert
    // Verify the fake was invoked with the parsed identifier
    expect(getUserRepoFake().calls.findByIdentifier[0]).toBe(user.email);
    expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
    expect(captured.sendBody).toStrictEqual(user);
  });

  it('obfuscates NotFoundError as 502 when user is missing', async () => {
    // Arrange
    const { req, res, captured } = makeRequestContext({
      params: { identifier: '11111111-1111-1111-1111-111111111111' },
    });

    const { getUserRequestHandler } = await import(
      '@/handlers/getUser.handler'
    );
    getUserRepoFake().reset();
    getUserRepoFake().queueFindNone();

    // Act
    await getUserRequestHandler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
    expect(captured.sendBody).toBe('Bad Gateway');
  });

  it('obfuscates Zod validation failures as 502', async () => {
    // Arrange
    // No repo call expected since input parsing fails first
    const { req, res, captured } = makeRequestContext({
      params: { identifier: '' },
    });

    const { getUserRequestHandler } = await import(
      '@/handlers/getUser.handler'
    );

    // Act
    await getUserRequestHandler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
    expect(captured.sendBody).toBe('Bad Gateway');
  });
});

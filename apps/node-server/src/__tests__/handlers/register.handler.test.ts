import type * as BackendCoreModuleType from '@packages/backend-core';
import {
  ConflictError,
  type handlerInput,
  InternalServerError,
} from '@packages/backend-core';
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  USER_ROLE,
} from '@packages/backend-core/auth';
import type { UserCreate } from '@packages/schemas/user';
import type { Layer } from 'effect';
import { Effect, Either, Option } from 'effect';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { buildUserCreate } from '@/__tests__/builders/user';
import { createUserRepoFake } from '@/__tests__/fakes/userRepo';

const handlerCapture = vi.hoisted(() => ({
  effectfulHandler: undefined as
    | ((
        input: handlerInput,
      ) => Effect.Effect<
        string,
        ConflictError | InternalServerError | ZodError,
        never
      >)
    | undefined,
}));

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __BUNDLED__?: boolean }).__BUNDLED__ =
    false;
  return undefined;
});

const outputsModule = vi.hoisted(() => ({
  value: {
    'api-stack': {
      usersTableName: 'users-table',
      applicationLogGroupName: 'application-log-group',
      serverLogStreamName: 'server-log-stream',
    },
    'api-security-stack': {
      securityLogGroupName: 'security-log-group',
      securityLogStreamName: 'security-log-stream',
      rateLimitTableName: 'rate-limit-table',
      denyListTableName: 'deny-list-table',
    },
  } as const,
}));

vi.mock(
  '@cdk/backend-server-cdk',
  (): {
    readonly loadCDKOutput: (
      stack: keyof typeof outputsModule.value,
      basePath?: string,
    ) => (typeof outputsModule.value)[keyof typeof outputsModule.value];
  } => ({
    loadCDKOutput: (stack: keyof typeof outputsModule.value) =>
      outputsModule.value[stack],
  }),
);

const appLayerState = vi.hoisted(() => ({
  layer: undefined as Layer.Layer<never, never, unknown> | undefined,
}));

const randomUuidMock = vi.hoisted(() => ({
  fn: vi.fn<() => string>(),
}));

const argon2Mock = vi.hoisted(() => ({
  hash: vi.fn<
    (password: string, options: { secret: Buffer }) => Promise<string>
  >(),
}));

const signMock = vi.hoisted(() => ({
  fn: vi.fn<(payload: unknown, secret: string | undefined) => string>(),
}));

type BackendCoreModule = typeof BackendCoreModuleType;

vi.mock(
  '@packages/backend-core',
  async (importOriginal): Promise<BackendCoreModule> => {
    const actual: BackendCoreModule = await importOriginal();
    const originalGenerateRequestHandler = actual.generateRequestHandler;
    const patchedGenerateRequestHandler: typeof actual.generateRequestHandler =
      (config) => {
        handlerCapture.effectfulHandler =
          config.effectfulHandler as unknown as typeof handlerCapture.effectfulHandler;
        return originalGenerateRequestHandler(config);
      };
    return {
      ...actual,
      generateRequestHandler: patchedGenerateRequestHandler,
    } satisfies BackendCoreModule;
  },
);

type AppLayerModule = { readonly AppLayer: Layer.Layer<never, never, unknown> };

vi.mock(
  '@/layers/app.layer',
  (): AppLayerModule => ({
    get AppLayer(): Layer.Layer<never, never, unknown> {
      if (!appLayerState.layer) {
        throw new Error('AppLayer layer not configured for test');
      }
      return appLayerState.layer;
    },
  }),
);

vi.mock('node:crypto', (): { randomUUID: () => string } => ({
  randomUUID: () => randomUuidMock.fn(),
}));

vi.mock(
  '@node-rs/argon2',
  (): { default: { hash: typeof argon2Mock.hash } } => ({
    default: {
      hash: argon2Mock.hash,
    },
  }),
);

vi.mock('jsonwebtoken', (): { sign: typeof signMock.fn } => ({
  sign: signMock.fn,
}));

describe('register handler', () => {
  const loadModule = async (): Promise<void> => {
    await import('@/handlers/register.handler');
  };

  const getCapturedHandler = (): NonNullable<
    (typeof handlerCapture)['effectfulHandler']
  > => {
    const handler = handlerCapture.effectfulHandler;
    if (!handler) {
      throw new Error('Effectful handler was not captured');
    }
    return handler;
  };

  const runHandler = (
    request: Partial<Request>,
  ): Promise<
    Either.Either<string, ConflictError | InternalServerError | ZodError>
  > =>
    Effect.runPromise(
      getCapturedHandler()(Effect.succeed(request as Request)).pipe(
        Effect.catchAllDefect((defect) =>
          Effect.fail(defect as ConflictError | InternalServerError | ZodError),
        ),
        Effect.either,
      ),
    );

  beforeEach((): void => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    handlerCapture.effectfulHandler = undefined;
    appLayerState.layer = undefined;
    randomUuidMock.fn.mockReset();
    argon2Mock.hash.mockReset();
    signMock.fn.mockReset();
    process.env.PEPPER = 'test-pepper';
    process.env.JWT_SECRET = 'jwt-secret';
  });

  afterEach((): void => {
    vi.useRealTimers();
    Reflect.deleteProperty(process.env, 'PEPPER');
    Reflect.deleteProperty(process.env, 'JWT_SECRET');
  });

  it('returns a signed token when registration succeeds', async (): Promise<void> => {
    const userRepoFake = createUserRepoFake();
    appLayerState.layer = userRepoFake.layer;
    userRepoFake.queueFindByIdentifier(Option.none());
    userRepoFake.queueCreateSuccess();

    const userInput = {
      username: 'new-user',
      email: 'new-user@example.com',
      password: 'StrongPass123!',
    } as const;
    const hashedPassword = 'hashed-password';
    const userId = '11111111-1111-4111-8111-111111111111';
    const tokenId = '22222222-2222-4222-8222-222222222222';
    randomUuidMock.fn.mockReturnValueOnce(userId).mockReturnValueOnce(tokenId);
    argon2Mock.hash.mockResolvedValue(hashedPassword);
    signMock.fn.mockReturnValue('signed-token');

    await loadModule();

    const result = await runHandler({ body: userInput });

    if (!Either.isRight(result)) {
      throw new Error('Expected handler to succeed');
    }
    expect(result.right).toBe('signed-token');
    expect(userRepoFake.calls.findByIdentifier).toEqual([userInput.email]);
    expect(userRepoFake.calls.create).toHaveLength(1);
    const createdUser = userRepoFake.calls.create[0] as UserCreate;
    expect(createdUser).toMatchObject({
      id: userId,
      username: userInput.username,
      email: userInput.email,
      passwordHash: hashedPassword,
    });
    expect(Buffer.isBuffer(argon2Mock.hash.mock.calls[0]?.[1]?.secret)).toBe(
      true,
    );
    expect(argon2Mock.hash.mock.calls[0]?.[1]?.secret?.toString('utf8')).toBe(
      'test-pepper',
    );
    const issuedAt = new Date('2024-01-01T00:00:00.000Z').getTime();
    const expiresAt = issuedAt + 60 * 60 * 1000;
    expect(signMock.fn).toHaveBeenCalledWith(
      {
        iss: JWT_ISSUER,
        sub: userId,
        aud: JWT_AUDIENCE,
        exp: expiresAt,
        iat: issuedAt,
        jti: tokenId,
        role: USER_ROLE,
      },
      'jwt-secret',
    );
  });

  it('fails with ConflictError when the user already exists', async (): Promise<void> => {
    const userRepoFake = createUserRepoFake();
    appLayerState.layer = userRepoFake.layer;
    userRepoFake.queueFindByIdentifier(Option.some(buildUserCreate()));

    await loadModule();

    const result = await runHandler({
      body: {
        username: 'existing-user',
        email: 'test-user@example.com',
        password: 'StrongPass123!',
      },
    });

    if (!Either.isLeft(result)) {
      throw new Error('Expected handler to fail with ConflictError');
    }
    expect(result.left).toBeInstanceOf(ConflictError);
    expect(userRepoFake.calls.create).toHaveLength(0);
    expect(argon2Mock.hash).not.toHaveBeenCalled();
    expect(signMock.fn).not.toHaveBeenCalled();
  });

  it('propagates a ZodError when the input payload is invalid', async (): Promise<void> => {
    const userRepoFake = createUserRepoFake();
    appLayerState.layer = userRepoFake.layer;

    await loadModule();

    const result = await runHandler({
      body: {
        username: '',
        email: 'not-an-email',
        password: '123',
      },
    });

    if (!Either.isLeft(result)) {
      throw new Error('Expected handler to fail with ZodError');
    }
    expect(result.left).toBeInstanceOf(ZodError);
    expect(userRepoFake.calls.findByIdentifier).toHaveLength(0);
    expect(userRepoFake.calls.create).toHaveLength(0);
  });

  it('fails with InternalServerError when hashing rejects', async (): Promise<void> => {
    const userRepoFake = createUserRepoFake();
    appLayerState.layer = userRepoFake.layer;
    userRepoFake.queueFindByIdentifier(Option.none());

    const hashingError = new InternalServerError({ message: 'hash failure' });
    argon2Mock.hash.mockRejectedValue(hashingError);

    await loadModule();

    const result = await runHandler({
      body: {
        username: 'hash-failure',
        email: 'hash@example.com',
        password: 'StrongPass123!',
      },
    });

    if (!Either.isLeft(result)) {
      throw new Error('Expected handler to fail with InternalServerError');
    }
    expect(result.left).toBeInstanceOf(InternalServerError);
    expect(userRepoFake.calls.create).toHaveLength(0);
  });
});

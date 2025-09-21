import type { InternalServerError } from '@packages/backend-core';
import type * as BackendCoreModuleType from '@packages/backend-core';
import { type handlerInput, NotFoundError } from '@packages/backend-core';
import type { UserPublic } from '@packages/schemas/user';
import type { Layer } from 'effect';
import { Effect, Either, Option } from 'effect';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { buildUserPublic } from '@/__tests__/builders/user';
import { createUserRepoFake } from '@/__tests__/fakes/userRepo';

const handlerCapture = vi.hoisted(() => ({
  effectfulHandler: undefined as
    | ((
        input: handlerInput,
      ) => Effect.Effect<
        UserPublic,
        NotFoundError | InternalServerError | ZodError,
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

describe('getUser handler', () => {
  const loadModule = async (): Promise<void> => {
    await import('@/handlers/getUser.handler');
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
    Either.Either<UserPublic, NotFoundError | InternalServerError | ZodError>
  > =>
    Effect.runPromise(
      getCapturedHandler()(Effect.succeed(request as Request)).pipe(
        Effect.catchAllDefect((defect) =>
          Effect.fail(defect as NotFoundError | InternalServerError | ZodError),
        ),
        Effect.either,
      ),
    );

  beforeEach((): void => {
    vi.resetModules();
    handlerCapture.effectfulHandler = undefined;
    appLayerState.layer = undefined;
  });

  it('resolves with the user when the identifier matches an existing record', async (): Promise<void> => {
    const userRepoFake = createUserRepoFake();
    appLayerState.layer = userRepoFake.layer;
    const user = buildUserPublic({ email: 'existing@example.com' });
    userRepoFake.queueFindByIdentifier(Option.some(user));

    await loadModule();

    const result = await runHandler({ params: { identifier: user.email } });

    if (!Either.isRight(result)) {
      throw new Error('Expected handler to resolve with a user');
    }
    expect(result.right).toStrictEqual(user);
    expect(userRepoFake.calls.findByIdentifier).toEqual([user.email]);
  });

  it('fails with NotFoundError when the repo returns Option.none', async (): Promise<void> => {
    const userRepoFake = createUserRepoFake();
    appLayerState.layer = userRepoFake.layer;
    userRepoFake.queueFindByIdentifier(Option.none());

    await loadModule();

    const result = await runHandler({
      params: { identifier: 'missing-user@example.com' },
    });

    if (!Either.isLeft(result)) {
      throw new Error('Expected handler to fail with NotFoundError');
    }
    expect(result.left).toBeInstanceOf(NotFoundError);
    expect(userRepoFake.calls.findByIdentifier).toEqual([
      'missing-user@example.com',
    ]);
  });

  it('propagates a ZodError when the identifier fails validation', async (): Promise<void> => {
    const userRepoFake = createUserRepoFake();
    appLayerState.layer = userRepoFake.layer;

    await loadModule();

    const result = await runHandler({
      params: { identifier: 'not-an-identifier' },
    });

    if (!Either.isLeft(result)) {
      throw new Error('Expected handler to fail with ZodError');
    }
    expect(result.left).toBeInstanceOf(ZodError);
    expect(userRepoFake.calls.findByIdentifier).toHaveLength(0);
  });
});

import type { InternalServerError } from '@packages/backend-core';
import type { UserCreate, UserPublic } from '@packages/schemas/user';
import type { Option } from 'effect';
import { Effect, Layer } from 'effect';

import { UserRepo, type UserRepoSchema } from '@/services/userRepo.service';

type QueuedFindResult =
  | { readonly kind: 'success'; readonly value: Option.Option<UserPublic> }
  | { readonly kind: 'error'; readonly error: InternalServerError };

type QueuedCreateResult =
  | { readonly kind: 'success' }
  | { readonly kind: 'error'; readonly error: InternalServerError };

export type UserRepoFake = {
  readonly service: UserRepoSchema;
  readonly layer: Layer.Layer<never, never, UserRepo>;
  readonly calls: {
    readonly findByIdentifier: string[];
    readonly create: UserCreate[];
  };
  readonly queueFindByIdentifier: (result: Option.Option<UserPublic>) => void;
  readonly queueFindError: (error: InternalServerError) => void;
  readonly queueCreateSuccess: () => void;
  readonly queueCreateError: (error: InternalServerError) => void;
  readonly reset: () => void;
};

export const createUserRepoFake = (): UserRepoFake => {
  const findQueue: QueuedFindResult[] = [];
  const createQueue: QueuedCreateResult[] = [];
  const calls = {
    findByIdentifier: [] as string[],
    create: [] as UserCreate[],
  };

  const service: UserRepoSchema = {
    findByIdentifier: (identifier) =>
      Effect.suspend(() => {
        calls.findByIdentifier.push(identifier);
        const next = findQueue.shift();
        if (!next) {
          return Effect.die(
            new Error('No queued result for findByIdentifier in UserRepoFake'),
          );
        }
        if (next.kind === 'error') {
          return Effect.fail(next.error);
        }
        return Effect.succeed(next.value);
      }),
    create: (user) =>
      Effect.suspend(() => {
        calls.create.push(user);
        const next = createQueue.shift();
        if (!next) {
          return Effect.die(
            new Error('No queued result for create in UserRepoFake'),
          );
        }
        if (next.kind === 'error') {
          return Effect.fail(next.error);
        }
        return Effect.succeed(true as const);
      }),
  } satisfies UserRepoSchema;

  const queueFindByIdentifier = (result: Option.Option<UserPublic>): void => {
    findQueue.push({ kind: 'success', value: result });
  };

  const queueFindError = (error: InternalServerError): void => {
    findQueue.push({ kind: 'error', error });
  };

  const queueCreateSuccess = (): void => {
    createQueue.push({ kind: 'success' });
  };

  const queueCreateError = (error: InternalServerError): void => {
    createQueue.push({ kind: 'error', error });
  };

  const reset = (): void => {
    findQueue.length = 0;
    createQueue.length = 0;
    calls.findByIdentifier.length = 0;
    calls.create.length = 0;
  };

  return {
    service,
    layer: Layer.succeed(UserRepo, service),
    calls,
    queueFindByIdentifier,
    queueFindError,
    queueCreateSuccess,
    queueCreateError,
    reset,
  };
};

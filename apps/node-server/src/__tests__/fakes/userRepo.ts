import { InternalServerError } from '@packages/backend-core';
import type { UserCreate, UserPublic } from '@packages/schemas/user';
import { Effect, Layer, Option } from 'effect';

import { UserRepo, type UserRepoSchema } from '@/services/userRepo.service';

type OperationName = 'findByIdentifier' | 'create';

type ResponseEntry<T> =
  | { type: 'success'; value: T }
  | { type: 'error'; error: InternalServerError };

type Queues = {
  readonly findByIdentifier: Array<ResponseEntry<Option.Option<UserPublic>>>;
  readonly create: Array<ResponseEntry<true>>;
};

type Calls = {
  readonly findByIdentifier: Array<string>;
  readonly create: Array<UserCreate>;
};

export type UserRepoFake = {
  readonly service: UserRepoSchema;
  readonly layer: Layer.Layer<never, never, UserRepo>;
  readonly calls: Calls;
  readonly reset: () => void;
  // Queue helpers
  readonly queueFindSome: (value: UserPublic) => void;
  readonly queueFindNone: () => void;
  readonly queueFindFailure: (error: InternalServerError) => void;
  readonly queueCreateSuccess: () => void;
  readonly queueCreateFailure: (error: InternalServerError) => void;
};

const dequeue = <T>(
  queue: Array<ResponseEntry<T>>,
  op: OperationName,
): Effect.Effect<T, InternalServerError> => {
  const next = queue.shift();
  if (!next) {
    return Effect.fail(
      new InternalServerError({
        message: `No response queued for UserRepo.${op}`,
      }),
    );
  }
  return next.type === 'success'
    ? Effect.succeed(next.value)
    : Effect.fail(next.error);
};

export const createUserRepoFake = (): UserRepoFake => {
  const queues: Queues = {
    findByIdentifier: [],
    create: [],
  };

  const calls: Calls = {
    findByIdentifier: [],
    create: [],
  };

  const service: UserRepoSchema = {
    findByIdentifier: (idOrEmail: string) => {
      calls.findByIdentifier.push(idOrEmail);
      return dequeue(queues.findByIdentifier, 'findByIdentifier');
    },
    create: (user) => {
      calls.create.push(user);
      return dequeue(queues.create, 'create');
    },
  };

  return {
    service,
    layer: Layer.succeed(UserRepo, service),
    calls,
    reset: (): void => {
      queues.findByIdentifier.length = 0;
      queues.create.length = 0;
      calls.findByIdentifier.length = 0;
      calls.create.length = 0;
    },
    queueFindSome: (value: UserPublic): void => {
      queues.findByIdentifier.push({
        type: 'success',
        value: Option.some(value),
      });
    },
    queueFindNone: (): void => {
      queues.findByIdentifier.push({ type: 'success', value: Option.none() });
    },
    queueFindFailure: (error: InternalServerError): void => {
      queues.findByIdentifier.push({ type: 'error', error });
    },
    queueCreateSuccess: (): void => {
      queues.create.push({ type: 'success', value: true });
    },
    queueCreateFailure: (error: InternalServerError): void => {
      queues.create.push({ type: 'error', error });
    },
  };
};

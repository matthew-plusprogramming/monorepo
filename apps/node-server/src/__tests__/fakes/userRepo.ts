import { InternalServerError } from '@packages/backend-core';
import type { UserCreate, UserPublic } from '@packages/schemas/user';
import { Effect, Layer, Option } from 'effect';

import { UserRepo, type UserRepoSchema } from '@/services/userRepo.service';

type OperationName =
  | 'findByIdentifier'
  | 'findCredentialsByIdentifier'
  | 'create';

type ResponseEntry<T> =
  | { type: 'success'; value: T }
  | { type: 'error'; error: InternalServerError };

type Queues = {
  readonly findByIdentifier: Array<ResponseEntry<Option.Option<UserPublic>>>;
  readonly findCredentialsByIdentifier: Array<
    ResponseEntry<Option.Option<UserCreate>>
  >;
  readonly create: Array<ResponseEntry<true>>;
};

type Calls = {
  readonly findByIdentifier: Array<string>;
  readonly findCredentialsByIdentifier: Array<string>;
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
  readonly queueFindCredentialsSome: (value: UserCreate) => void;
  readonly queueFindCredentialsNone: () => void;
  readonly queueFindCredentialsFailure: (error: InternalServerError) => void;
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
        cause: undefined,
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
    findCredentialsByIdentifier: [],
    create: [],
  };

  const calls: Calls = {
    findByIdentifier: [],
    findCredentialsByIdentifier: [],
    create: [],
  };

  const service: UserRepoSchema = {
    findByIdentifier: (identifier: string) => {
      calls.findByIdentifier.push(identifier);
      return dequeue(queues.findByIdentifier, 'findByIdentifier');
    },
    findCredentialsByIdentifier: (identifier: string) => {
      calls.findCredentialsByIdentifier.push(identifier);
      return dequeue(
        queues.findCredentialsByIdentifier,
        'findCredentialsByIdentifier',
      ).pipe(
        Effect.map((userCreate) =>
          Option.map(userCreate, ({ id, username, email, passwordHash }) => ({
            id,
            username,
            email,
            passwordHash,
          })),
        ),
      );
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
      queues.findCredentialsByIdentifier.length = 0;
      queues.create.length = 0;
      calls.findByIdentifier.length = 0;
      calls.findCredentialsByIdentifier.length = 0;
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
    queueFindCredentialsSome: (value: UserCreate): void => {
      queues.findCredentialsByIdentifier.push({
        type: 'success',
        value: Option.some(value),
      });
    },
    queueFindCredentialsNone: (): void => {
      queues.findCredentialsByIdentifier.push({
        type: 'success',
        value: Option.none(),
      });
    },
    queueFindCredentialsFailure: (error: InternalServerError): void => {
      queues.findCredentialsByIdentifier.push({ type: 'error', error });
    },
    queueCreateSuccess: (): void => {
      queues.create.push({ type: 'success', value: true });
    },
    queueCreateFailure: (error: InternalServerError): void => {
      queues.create.push({ type: 'error', error });
    },
  };
};

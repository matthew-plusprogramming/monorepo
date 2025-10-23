import { InternalServerError } from '@packages/backend-core';
import type {
  __ENTITY_PASCAL__Create,
  __ENTITY_PASCAL__Public,
} from '@packages/schemas/__ENTITY_SLUG__';
import { Effect, Layer, Option } from 'effect';

import {
  __ENTITY_PASCAL__Repo,
  type __ENTITY_PASCAL__RepoSchema,
} from '@/services/__ENTITY_CAMEL__Repo.service';

type OperationName = 'getById' | 'create';

type ResponseEntry<T> =
  | { type: 'success'; value: T }
  | { type: 'error'; error: InternalServerError };

type Queues = {
  readonly getById: Array<ResponseEntry<Option.Option<__ENTITY_PASCAL__Public>>>;
  readonly create: Array<ResponseEntry<true>>;
};

type Calls = {
  readonly getById: Array<string>;
  readonly create: Array<__ENTITY_PASCAL__Create>;
};

export type __ENTITY_PASCAL__RepoFake = {
  readonly service: __ENTITY_PASCAL__RepoSchema;
  readonly layer: Layer.Layer<never, never, __ENTITY_PASCAL__Repo>;
  readonly calls: Calls;
  readonly reset: () => void;
  readonly queueGetSome: (value: __ENTITY_PASCAL__Public) => void;
  readonly queueGetNone: () => void;
  readonly queueGetFailure: (error: InternalServerError) => void;
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
        message: `No response queued for __ENTITY_PASCAL__Repo.${op}`,
      }),
    );
  }
  return next.type === 'success'
    ? Effect.succeed(next.value)
    : Effect.fail(next.error);
};

export const create__ENTITY_PASCAL__RepoFake = (): __ENTITY_PASCAL__RepoFake => {
  const queues: Queues = {
    getById: [],
    create: [],
  };

  const calls: Calls = {
    getById: [],
    create: [],
  };

  const service: __ENTITY_PASCAL__RepoSchema = {
    getById: (id: string) => {
      calls.getById.push(id);
      return dequeue(queues.getById, 'getById');
    },
    create: (entity) => {
      calls.create.push(entity);
      return dequeue(queues.create, 'create');
    },
  };

  return {
    service,
    layer: Layer.succeed(__ENTITY_PASCAL__Repo, service),
    calls,
    reset: (): void => {
      queues.getById.length = 0;
      queues.create.length = 0;
      calls.getById.length = 0;
      calls.create.length = 0;
    },
    queueGetSome: (value: __ENTITY_PASCAL__Public): void => {
      queues.getById.push({
        type: 'success',
        value: Option.some(value),
      });
    },
    queueGetNone: (): void => {
      queues.getById.push({ type: 'success', value: Option.none() });
    },
    queueGetFailure: (error: InternalServerError): void => {
      queues.getById.push({ type: 'error', error });
    },
    queueCreateSuccess: (): void => {
      queues.create.push({ type: 'success', value: true });
    },
    queueCreateFailure: (error: InternalServerError): void => {
      queues.create.push({ type: 'error', error });
    },
  };
};

/**
 * Spec Group Repository Fake
 *
 * Provides a fake implementation of SpecGroupRepository for testing.
 */

import { Effect, Layer, Option } from 'effect';

import {
  InvalidStateTransitionError,
  SpecGroupConflictError,
  SpecGroupNotFoundError,
} from '@/spec-groups/errors.js';
import {
  SpecGroupRepository,
  type SpecGroupRepositorySchema,
} from '@/spec-groups/repository.js';
import { validateTransition } from '@/spec-groups/stateMachine.js';
import {
  SpecGroupState,
  type CreateSpecGroupInput,
  type DecisionLogEntry,
  type SpecGroup,
  type TransitionStateInput,
} from '@/spec-groups/types.js';
import { InternalServerError } from '@/types/errors/http.js';

type SuccessEntry<T> = { type: 'success'; value: T };
type ErrorEntry<E> = { type: 'error'; error: E };
type ResponseEntry<T, E> = SuccessEntry<T> | ErrorEntry<E>;

type ResponseQueues = {
  readonly getById: Array<
    ResponseEntry<Option.Option<SpecGroup>, InternalServerError>
  >;
  readonly create: Array<ResponseEntry<SpecGroup, InternalServerError>>;
  readonly transitionState: Array<
    ResponseEntry<
      SpecGroup,
      | SpecGroupNotFoundError
      | InvalidStateTransitionError
      | SpecGroupConflictError
      | InternalServerError
    >
  >;
  readonly updateFlags: Array<
    ResponseEntry<SpecGroup, SpecGroupNotFoundError | InternalServerError>
  >;
};

type CallHistory = {
  readonly getById: Array<string>;
  readonly create: Array<CreateSpecGroupInput>;
  readonly transitionState: Array<TransitionStateInput>;
  readonly updateFlags: Array<{
    id: string;
    flags: Partial<{
      sectionsCompleted: boolean;
      allGatesPassed: boolean;
      prMerged: boolean;
    }>;
  }>;
};

export type SpecGroupRepoFake = {
  readonly service: SpecGroupRepositorySchema;
  readonly layer: Layer.Layer<SpecGroupRepository, never, never>;
  readonly queueGetByIdSome: (specGroup: SpecGroup) => void;
  readonly queueGetByIdNone: () => void;
  readonly queueGetByIdError: (error: InternalServerError) => void;
  readonly queueCreateSuccess: (specGroup: SpecGroup) => void;
  readonly queueCreateError: (error: InternalServerError) => void;
  readonly queueTransitionSuccess: (specGroup: SpecGroup) => void;
  readonly queueTransitionError: (
    error:
      | SpecGroupNotFoundError
      | InvalidStateTransitionError
      | SpecGroupConflictError
      | InternalServerError,
  ) => void;
  readonly queueUpdateFlagsSuccess: (specGroup: SpecGroup) => void;
  readonly queueUpdateFlagsError: (
    error: SpecGroupNotFoundError | InternalServerError,
  ) => void;
  readonly calls: CallHistory;
  readonly reset: () => void;
};

const dequeue = <T, E>(
  queue: Array<ResponseEntry<T, E>>,
  operation: string,
): Effect.Effect<T, E | InternalServerError> => {
  const next = queue.shift();
  if (!next) {
    return Effect.fail(
      new InternalServerError({
        message: `No response queued for SpecGroupRepository.${operation}`,
        cause: undefined,
      }),
    );
  }

  if (next.type === 'success') {
    return Effect.succeed(next.value);
  }

  return Effect.fail(next.error);
};

export const createSpecGroupRepoFake = (): SpecGroupRepoFake => {
  const responseQueues: ResponseQueues = {
    getById: [],
    create: [],
    transitionState: [],
    updateFlags: [],
  };

  const callHistory: CallHistory = {
    getById: [],
    create: [],
    transitionState: [],
    updateFlags: [],
  };

  const service: SpecGroupRepositorySchema = {
    getById: (id: string) =>
      Effect.sync(() => {
        callHistory.getById.push(id);
      }).pipe(Effect.flatMap(() => dequeue(responseQueues.getById, 'getById'))),

    create: (input: CreateSpecGroupInput) =>
      Effect.sync(() => {
        callHistory.create.push(input);
      }).pipe(Effect.flatMap(() => dequeue(responseQueues.create, 'create'))),

    transitionState: (input: TransitionStateInput) =>
      Effect.sync(() => {
        callHistory.transitionState.push(input);
      }).pipe(
        Effect.flatMap(() =>
          dequeue(responseQueues.transitionState, 'transitionState'),
        ),
      ),

    updateFlags: (
      id: string,
      flags: Partial<{
        sectionsCompleted: boolean;
        allGatesPassed: boolean;
        prMerged: boolean;
      }>,
    ) =>
      Effect.sync(() => {
        callHistory.updateFlags.push({ id, flags });
      }).pipe(
        Effect.flatMap(() =>
          dequeue(responseQueues.updateFlags, 'updateFlags'),
        ),
      ),
  };

  return {
    service,
    layer: Layer.succeed(SpecGroupRepository, service),
    queueGetByIdSome: (specGroup: SpecGroup): void => {
      responseQueues.getById.push({
        type: 'success',
        value: Option.some(specGroup),
      });
    },
    queueGetByIdNone: (): void => {
      responseQueues.getById.push({
        type: 'success',
        value: Option.none(),
      });
    },
    queueGetByIdError: (error: InternalServerError): void => {
      responseQueues.getById.push({ type: 'error', error });
    },
    queueCreateSuccess: (specGroup: SpecGroup): void => {
      responseQueues.create.push({ type: 'success', value: specGroup });
    },
    queueCreateError: (error: InternalServerError): void => {
      responseQueues.create.push({ type: 'error', error });
    },
    queueTransitionSuccess: (specGroup: SpecGroup): void => {
      responseQueues.transitionState.push({
        type: 'success',
        value: specGroup,
      });
    },
    queueTransitionError: (
      error:
        | SpecGroupNotFoundError
        | InvalidStateTransitionError
        | SpecGroupConflictError
        | InternalServerError,
    ): void => {
      responseQueues.transitionState.push({ type: 'error', error });
    },
    queueUpdateFlagsSuccess: (specGroup: SpecGroup): void => {
      responseQueues.updateFlags.push({ type: 'success', value: specGroup });
    },
    queueUpdateFlagsError: (
      error: SpecGroupNotFoundError | InternalServerError,
    ): void => {
      responseQueues.updateFlags.push({ type: 'error', error });
    },
    calls: callHistory,
    reset: (): void => {
      responseQueues.getById.length = 0;
      responseQueues.create.length = 0;
      responseQueues.transitionState.length = 0;
      responseQueues.updateFlags.length = 0;
      callHistory.getById.length = 0;
      callHistory.create.length = 0;
      callHistory.transitionState.length = 0;
      callHistory.updateFlags.length = 0;
    },
  };
};

/**
 * Helper to create a mock spec group for testing.
 */
export const createMockSpecGroup = (
  overrides: Partial<SpecGroup> = {},
): SpecGroup => ({
  id: 'test-spec-group-id',
  name: 'Test Spec Group',
  description: 'A test spec group',
  state: SpecGroupState.DRAFT,
  decisionLog: [],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'test-user',
  sectionsCompleted: false,
  allGatesPassed: false,
  prMerged: false,
  ...overrides,
});

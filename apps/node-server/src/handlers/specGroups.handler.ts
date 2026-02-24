/**
 * Spec Groups Handler
 *
 * Handles API endpoints for spec group operations including:
 * - GET /api/spec-groups/:id - Get a spec group by ID
 * - POST /api/spec-groups/:id/transition - Transition state
 * - PUT /api/spec-groups/:id/flags - Update flags
 */

import {
  generateRequestHandler,
  getAvailableTransitions,
  HTTP_RESPONSE,
  InternalServerError,
  InvalidStateTransitionError,
  SpecGroupConflictError,
  SpecGroupNotFoundError,
  SpecGroupRepository,
  STATE_DISPLAY_CONFIG,
  type handlerInput,
  type SpecGroup,
  type SpecGroupStateType,
} from '@packages/backend-core';
import { Effect, Option } from 'effect';
import z, { ZodError } from 'zod';

import { parseInput } from '@/helpers/zodParser';
import { AppLayer } from '@/layers/app.layer';

/**
 * Schema for transition request body.
 */
const TransitionInputSchema = z.object({
  toState: z.enum([
    'DRAFT',
    'REVIEWED',
    'APPROVED',
    'IN_PROGRESS',
    'CONVERGED',
    'MERGED',
  ]),
  reason: z.string().optional(),
});

/**
 * Schema for update flags request body.
 */
const UpdateFlagsInputSchema = z.object({
  sectionsCompleted: z.boolean().optional(),
  allGatesPassed: z.boolean().optional(),
  prMerged: z.boolean().optional(),
});

/**
 * Response type for get spec group endpoint.
 */
type GetSpecGroupResponse = {
  readonly specGroup: SpecGroup;
  readonly stateDisplay: {
    readonly label: string;
    readonly color: string;
  };
  readonly availableTransitions: readonly {
    readonly toState: SpecGroupStateType;
    readonly description: string;
    readonly enabled: boolean;
    readonly disabledReason?: string;
  }[];
};

/**
 * Handler for GET /api/spec-groups/:id
 */
const getSpecGroupHandler = (input: handlerInput) =>
  Effect.gen(function* () {
    const req = yield* input;
    const id = req.params.id as string;

    const repo = yield* SpecGroupRepository;
    const maybeSpecGroup = yield* repo.getById(id);

    if (Option.isNone(maybeSpecGroup)) {
      return yield* new SpecGroupNotFoundError({
        message: `Spec group with id ${id} not found`,
        cause: undefined,
      });
    }

    const specGroup = maybeSpecGroup.value;
    const stateDisplay = STATE_DISPLAY_CONFIG[specGroup.state];
    const availableTransitions = getAvailableTransitions(specGroup);

    return {
      specGroup,
      stateDisplay,
      availableTransitions,
    };
  });

/**
 * Handler for POST /api/spec-groups/:id/transition
 */
const transitionStateHandler = (input: handlerInput) =>
  Effect.gen(function* () {
    const req = yield* input;
    const id = req.params.id as string;

    const parsedInput = yield* parseInput(TransitionInputSchema, req.body);

    // Get actor from authenticated user (fallback to 'system' for now)
    const actor =
      (req as unknown as { user?: { id?: string } }).user?.id ?? 'system';

    const repo = yield* SpecGroupRepository;
    const updatedSpecGroup = yield* repo.transitionState({
      specGroupId: id,
      toState: parsedInput.toState as SpecGroupStateType,
      actor,
      reason: parsedInput.reason,
    });

    const stateDisplay = STATE_DISPLAY_CONFIG[updatedSpecGroup.state];
    const availableTransitions = getAvailableTransitions(updatedSpecGroup);

    return {
      specGroup: updatedSpecGroup,
      stateDisplay,
      availableTransitions,
    };
  });

/**
 * Handler for PUT /api/spec-groups/:id/flags
 */
const updateFlagsHandler = (input: handlerInput) =>
  Effect.gen(function* () {
    const req = yield* input;
    const id = req.params.id as string;

    const parsedInput = yield* parseInput(UpdateFlagsInputSchema, req.body);

    const repo = yield* SpecGroupRepository;
    const updatedSpecGroup = yield* repo.updateFlags(id, parsedInput);

    const stateDisplay = STATE_DISPLAY_CONFIG[updatedSpecGroup.state];
    const availableTransitions = getAvailableTransitions(updatedSpecGroup);

    return {
      specGroup: updatedSpecGroup,
      stateDisplay,
      availableTransitions,
    };
  });

/**
 * Exported request handlers.
 */
export const getSpecGroupRequestHandler = generateRequestHandler<
  GetSpecGroupResponse,
  SpecGroupNotFoundError | InternalServerError
>({
  effectfulHandler: (input) =>
    getSpecGroupHandler(input).pipe(Effect.provide(AppLayer)),
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    [HTTP_RESPONSE.NOT_FOUND]: {
      errorType: SpecGroupNotFoundError,
      mapper: (e) => ({ error: e.message }),
    },
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      // AC1.3: Return generic message, real error logged by generateRequestHandler
      mapper: () => ({ error: 'Internal server error' }),
    },
  },
  successCode: HTTP_RESPONSE.OK,
});

export const transitionStateRequestHandler = generateRequestHandler<
  GetSpecGroupResponse,
  | SpecGroupNotFoundError
  | InvalidStateTransitionError
  | SpecGroupConflictError
  | InternalServerError
  | ZodError
>({
  effectfulHandler: (input) =>
    transitionStateHandler(input).pipe(Effect.provide(AppLayer)),
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    [HTTP_RESPONSE.BAD_REQUEST]: {
      errorType: ZodError,
      mapper: (e) => ({ error: z.prettifyError(e as ZodError) }),
    },
    [HTTP_RESPONSE.NOT_FOUND]: {
      errorType: SpecGroupNotFoundError,
      mapper: (e) => ({ error: e.message }),
    },
    [HTTP_RESPONSE.CONFLICT]: {
      errorType: SpecGroupConflictError,
      mapper: (e) => ({ error: e.message }),
    },
    [HTTP_RESPONSE.BAD_REQUEST + 1]: {
      // Use 422 for invalid state transition
      errorType: InvalidStateTransitionError,
      mapper: (e) => ({ error: e.message }),
    },
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      // AC1.3: Return generic message, real error logged by generateRequestHandler
      mapper: () => ({ error: 'Internal server error' }),
    },
  },
  successCode: HTTP_RESPONSE.OK,
});

export const updateFlagsRequestHandler = generateRequestHandler<
  GetSpecGroupResponse,
  SpecGroupNotFoundError | InternalServerError | ZodError
>({
  effectfulHandler: (input) =>
    updateFlagsHandler(input).pipe(Effect.provide(AppLayer)),
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    [HTTP_RESPONSE.BAD_REQUEST]: {
      errorType: ZodError,
      mapper: (e) => ({ error: z.prettifyError(e as ZodError) }),
    },
    [HTTP_RESPONSE.NOT_FOUND]: {
      errorType: SpecGroupNotFoundError,
      mapper: (e) => ({ error: e.message }),
    },
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      // AC1.3: Return generic message, real error logged by generateRequestHandler
      mapper: () => ({ error: 'Internal server error' }),
    },
  },
  successCode: HTTP_RESPONSE.OK,
});

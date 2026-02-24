/**
 * Projects Handler (AS-001)
 *
 * Handles API endpoints for project operations including:
 * - GET /api/projects - List all projects with spec group counts and health
 * - GET /api/projects/:id - Get a specific project
 */

import {
  DynamoDbService,
  generateRequestHandler,
  HTTP_RESPONSE,
  InternalServerError,
  ProjectNotFoundError,
  ProjectRepository,
  type handlerInput,
  type ListProjectsResponse,
  type Project,
} from '@packages/backend-core';
import { Effect, Option } from 'effect';

import { AppLayer } from '@/layers/app.layer';

/**
 * Handler for GET /api/projects (AC1.1, AC1.2, AC1.3)
 *
 * Returns all projects with:
 * - Name and status (AC1.1)
 * - Spec group count (AC1.2)
 * - Health indicator based on convergence gates (AC1.3)
 */
const listProjectsHandler = (
  _input: handlerInput,
): Effect.Effect<
  ListProjectsResponse,
  InternalServerError,
  ProjectRepository | DynamoDbService
> => {
  return Effect.gen(function* () {
    const repo = yield* ProjectRepository;
    const result = yield* repo.list();

    return result;
  });
};

/**
 * Handler for GET /api/projects/:id
 */
const getProjectHandler = (
  input: handlerInput,
): Effect.Effect<
  Project,
  ProjectNotFoundError | InternalServerError,
  ProjectRepository | DynamoDbService
> => {
  return Effect.gen(function* () {
    const req = yield* input;
    const id = req.params.id as string;

    const repo = yield* ProjectRepository;
    const maybeProject = yield* repo.getById(id);

    if (Option.isNone(maybeProject)) {
      return yield* new ProjectNotFoundError({
        message: `Project with id ${id} not found`,
        cause: undefined,
      });
    }

    return maybeProject.value;
  });
};

/**
 * Exported request handlers.
 */
export const listProjectsRequestHandler = generateRequestHandler<
  ListProjectsResponse,
  InternalServerError
>({
  effectfulHandler: (input) =>
    listProjectsHandler(input).pipe(Effect.provide(AppLayer)),
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      // AC1.3: Return generic message, real error logged by generateRequestHandler
      mapper: () => ({ error: 'Internal server error' }),
    },
  },
  successCode: HTTP_RESPONSE.OK,
});

export const getProjectRequestHandler = generateRequestHandler<
  Project,
  ProjectNotFoundError | InternalServerError
>({
  effectfulHandler: (input) =>
    getProjectHandler(input).pipe(Effect.provide(AppLayer)),
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    [HTTP_RESPONSE.NOT_FOUND]: {
      errorType: ProjectNotFoundError,
      // AC1.6: 4xx errors keep user-facing messages
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

import {
  generateRequestHandler,
  HTTP_RESPONSE,
  InternalServerError,
  type handlerInput,
} from '@packages/backend-core';
import { Effect } from 'effect';
import { z } from 'zod';

import { parseInput } from '@/helpers/zodParser';
import { AppLayer } from '@/layers/app.layer';
import {
  __ENTITY_PASCAL__Repo,
  type __ENTITY_PASCAL__RepoSchema,
} from '@/services/__ENTITY_CAMEL__Repo.service';

const __ENTITY_CAMEL__RequestSchema = z.object({
  /**
   * TODO: define the request payload expected by this handler.
   */
});

const handle__ENTITY_PASCAL__Request = (
  input: handlerInput,
): Effect.Effect<
  unknown,
  InternalServerError | z.ZodError,
  __ENTITY_PASCAL__Repo
> =>
  Effect.gen(function* () {
    const req = yield* input;
    const parsed = yield* parseInput(__ENTITY_CAMEL__RequestSchema, req.body);

    const repo = yield* __ENTITY_PASCAL__Repo;

    /**
     * TODO: replace with real repository calls (e.g., create, query by GSI).
     * Avoid hardcoding table names; rely on generated CDK outputs wired through AppLayer.
     */
    yield* repo.create(parsed as __ENTITY_PASCAL__RepoSchema['create'] extends (
      arg: infer A,
    ) => unknown
      ? A
      : never);

    return {
      status: 'TODO: replace with domain response',
    };
  });

export const __ENTITY_CAMEL__RequestHandler = generateRequestHandler<
  unknown,
  InternalServerError | z.ZodError
>({
  effectfulHandler: (input) =>
    handle__ENTITY_PASCAL__Request(input).pipe(Effect.provide(AppLayer)),
  statusCodesToErrors: {
    [HTTP_RESPONSE.BAD_REQUEST]: {
      errorType: z.ZodError,
      mapper: (error) => z.prettifyError(error as z.ZodError),
    },
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      mapper: (error) => error.message,
    },
  },
  successCode: HTTP_RESPONSE.OK,
});

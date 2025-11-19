import {
  generateRequestHandler,
  type handlerInput,
  HTTP_RESPONSE,
  InternalServerError,
  NotFoundError,
} from '@packages/backend-core';
import {
  __ENTITY_PASCAL__IdSchema,
  type __ENTITY_PASCAL__Public,
} from '@packages/schemas/__ENTITY_SLUG__';
import { Effect } from 'effect';
import z, { ZodError } from 'zod';

import { parseInput } from '@/helpers/zodParser';
import { AppLayer } from '@/layers/app.layer';
import { __ENTITY_PASCAL__Repo } from '@/services/__ENTITY_CAMEL__Repo.service';

const __HANDLER_PASCAL__Handler = (
  input: handlerInput,
): Effect.Effect<
  __ENTITY_PASCAL__Public,
  InternalServerError | NotFoundError | ZodError,
  __ENTITY_PASCAL__Repo
> =>
  Effect.gen(function* () {
    const req = yield* input;
    const entityId = yield* parseInput<typeof __ENTITY_PASCAL__IdSchema>(
      __ENTITY_PASCAL__IdSchema,
      /**
       * TODO: align the parameter key with the router definition (e.g. `identifier`).
       */
      req.params?.id,
    );

    const repo = yield* __ENTITY_PASCAL__Repo;
    const maybeEntity = yield* repo.getById(entityId);

    if (maybeEntity._tag === 'None') {
      return yield* new NotFoundError({
        message: `__ENTITY_PASCAL__ not found for id: ${entityId}`,
      });
    }

    return maybeEntity.value;
  });

export const __HANDLER_CAMEL__RequestHandler = generateRequestHandler<
  __ENTITY_PASCAL__Public,
  InternalServerError | NotFoundError | ZodError
>({
  effectfulHandler: (input) =>
    __HANDLER_PASCAL__Handler(input).pipe(Effect.provide(AppLayer)),
  shouldObfuscate: () => true,
  statusCodesToErrors: {
    [HTTP_RESPONSE.BAD_REQUEST]: {
      errorType: ZodError,
      mapper: (error) => z.prettifyError(error as ZodError),
    },
    [HTTP_RESPONSE.NOT_FOUND]: {
      errorType: NotFoundError,
      mapper: (error) => error.message,
    },
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      mapper: (error) => error.message,
    },
  },
  successCode: HTTP_RESPONSE.OK,
});


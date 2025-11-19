import {
  generateRequestHandler,
  type handlerInput,
  HTTP_RESPONSE,
  InternalServerError,
} from '@packages/backend-core';
import { Effect } from 'effect';

const __HANDLER_PASCAL__Handler = (
  input: handlerInput,
): Effect.Effect<{ message: string }, InternalServerError> =>
  Effect.gen(function* () {
    yield* input;

    /**
     * TODO: replace the placeholder payload with the real domain response.
     */
    return {
      message: '__HANDLER_PASCAL__ handler response',
    };
  });

export const __HANDLER_CAMEL__RequestHandler = generateRequestHandler<
  { message: string },
  InternalServerError
>({
  effectfulHandler: (input) => __HANDLER_PASCAL__Handler(input),
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      mapper: (error) => error.message,
    },
  },
  successCode: HTTP_RESPONSE.OK,
});


import { loadCDKOutput } from '@cdk/monorepo-cdk';
import { RegisterInputSchema, type User } from '@packages/schemas/user';
import { Effect, Either } from 'effect';
import type { RequestHandler } from 'express';
import { v4 as uuidV4 } from 'uuid';
import z, { ZodError } from 'zod';

import { parseInput } from '../helpers/zodParser';
import {
  DynamoDbService,
  LiveDynamoDbService,
} from '../services/dynamodb.service';
import { InternalServerError } from '../types/errors/http';
import type { handlerInput } from '../types/handler';
import { HTTP_RESPONSE } from '../types/http';

const usersTableName = loadCDKOutput<'my-stack'>('my-stack').userTableName;

const registerHandler = (
  input: handlerInput,
): Effect.Effect<Partial<User>, InternalServerError | ZodError, never> => {
  return Effect.gen(function* () {
    const req = yield* input;

    const parsedInput = yield* parseInput<typeof RegisterInputSchema>(
      RegisterInputSchema,
      req.body,
    );

    const databaseService = yield* DynamoDbService;

    // TODO: Implement duplicate checking
    yield* databaseService
      .putItem({
        TableName: usersTableName,
        Item: {
          id: { S: uuidV4() },
          username: { S: parsedInput.username },
          email: { S: parsedInput.email },
          // ! In production, never store passwords in plain text
          password: { S: parsedInput.password },
        },
      })
      .pipe(
        Effect.catchAll((e) => {
          // TODO: Implement logging
          return Effect.fail(new InternalServerError({ message: e.message }));
        }),
      );

    return parsedInput;
  }).pipe(Effect.provide(LiveDynamoDbService));
};

export const registerRequestHandler: RequestHandler = async (req, res) => {
  const result = await Effect.succeed(req)
    .pipe(registerHandler)
    .pipe(Effect.either)
    .pipe(Effect.runPromise);

  if (Either.isLeft(result)) {
    const error = result.left;
    if (error instanceof ZodError) {
      res.status(HTTP_RESPONSE.BAD_REQUEST).send(z.prettifyError(error));
      return;
    }

    res.status(HTTP_RESPONSE.INTERNAL_SERVER_ERROR).send();
  } else {
    res.status(HTTP_RESPONSE.CREATED).send();
  }
};

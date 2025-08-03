import { loadCDKOutput } from '@cdk/monorepo-cdk';
import {
  GetUserSchema,
  type User,
  UserEmailSchema,
} from '@packages/schemas/user';
import { Effect, Either } from 'effect';
import type { RequestHandler } from 'express';
import z, { ZodError } from 'zod';

import { parseInput } from '../helpers/zodParser';
import {
  DynamoDbService,
  LiveDynamoDbService,
} from '../services/dynamodb.service';
import { InternalServerError, NotFoundError } from '../types/errors/http';
import type { handlerInput } from '../types/handler';
import { HTTP_RESPONSE } from '../types/http';

const usersTableName = loadCDKOutput<'my-stack'>('my-stack').userTableName;

const getUserHandler = (
  input: handlerInput,
): Effect.Effect<
  User,
  InternalServerError | ZodError | NotFoundError,
  never
> => {
  return Effect.gen(function* () {
    const req = yield* input;

    const parsedInput = yield* parseInput<typeof GetUserSchema>(
      GetUserSchema,
      req.params?.identifier,
    );

    const databaseService = yield* DynamoDbService;

    const key = ((): 'email-index' | 'id' => {
      if (UserEmailSchema.safeParse(parsedInput).success) {
        return 'email-index';
      }
      return 'id';
    })();
    const value = parsedInput;

    const getUserResponse = yield* Effect.if(key === 'id', {
      onTrue: () => {
        return databaseService
          .getItem({
            TableName: usersTableName,
            Key: {
              id: {
                S: value,
              },
            },
          })
          .pipe(Effect.map((response) => response.Item));
      },
      onFalse: () => {
        return databaseService
          .query({
            TableName: usersTableName,
            IndexName: 'email-index',
            KeyConditionExpression: 'email = :email',
            ExpressionAttributeValues: {
              ':email': {
                S: value,
              },
            },
          })
          .pipe(Effect.map((response) => response.Items?.[0]));
      },
    }).pipe(
      Effect.catchAll((e) => {
        console.error(e);
        // TODO: Implement logging
        return Effect.fail(new InternalServerError({ message: e.message }));
      }),
    );

    if (!getUserResponse) {
      return yield* new NotFoundError({
        message: `User not found for identifier: ${parsedInput}`,
      });
    }

    const parsed = Object.fromEntries(
      Object.entries(getUserResponse).map(([key, value]) => [key, value?.S]),
    );

    return parsed as unknown as User;
  }).pipe(Effect.provide(LiveDynamoDbService));
};

export const getUserRequestHandler: RequestHandler = async (req, res) => {
  const result = await Effect.succeed(req)
    .pipe(getUserHandler)
    .pipe(Effect.either)
    .pipe(Effect.runPromise);

  if (Either.isLeft(result)) {
    const error = result.left;
    if (error instanceof ZodError) {
      res.status(HTTP_RESPONSE.BAD_REQUEST).send(z.prettifyError(error));
      return;
    } else if (error instanceof NotFoundError) {
      res.status(HTTP_RESPONSE.NOT_FOUND).send(error.message);
      return;
    }

    res.status(HTTP_RESPONSE.INTERNAL_SERVER_ERROR).send();
  } else {
    res.status(HTTP_RESPONSE.SUCCESS).send(result.right);
  }
};

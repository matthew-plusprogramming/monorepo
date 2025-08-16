import { RegisterInputSchema, type UserToken } from '@packages/schemas/user';
import { USER_SCHEMA_CONSTANTS } from '@packages/schemas/user';
import { Effect, Either } from 'effect';
import type { RequestHandler } from 'express';
import { sign } from 'jsonwebtoken';
import { v4 as uuidV4 } from 'uuid';
import z, { ZodError } from 'zod';

import { usersTableName } from '../clients/cdkOutputs';
import { JWT_AUDIENCE, JWT_ISSUER } from '../constants/jwt';
import { USER_ROLE } from '../constants/roles';
import { parseInput } from '../helpers/zodParser';
import {
  DynamoDbService,
  LiveDynamoDbService,
} from '../services/dynamodb.service';
import {
  ApplicationLoggerService,
  LoggerService,
} from '../services/logger.service';
import { InternalServerError } from '../types/errors/http';
import { ConflictError } from '../types/errors/http';
import type { handlerInput } from '../types/handler';
import { HTTP_RESPONSE } from '../types/http';

const registerHandler = (
  input: handlerInput,
): Effect.Effect<
  string,
  ConflictError | InternalServerError | ZodError,
  never
> => {
  return Effect.gen(function* () {
    const req = yield* input;

    const parsedInput = yield* parseInput<typeof RegisterInputSchema>(
      RegisterInputSchema,
      req.body,
    );

    const databaseService = yield* DynamoDbService;
    const loggerService = yield* LoggerService;
    const userId = uuidV4();

    const existingUserCheck = yield* databaseService
      .query({
        TableName: usersTableName,
        IndexName: USER_SCHEMA_CONSTANTS.gsi.email,
        KeyConditionExpression: '#email = :email',
        ExpressionAttributeNames: {
          '#email': 'email',
        },
        ExpressionAttributeValues: {
          ':email': { S: parsedInput.email },
        },
        Limit: 1,
      })
      .pipe(
        Effect.catchAll((e) => {
          loggerService.logError(e);
          return Effect.fail(new InternalServerError({ message: e.message }));
        }),
      );

    if (!existingUserCheck.Count || existingUserCheck.Count > 0) {
      return yield* new ConflictError({
        message: 'User with email already exists',
      });
    }

    yield* databaseService
      .putItem({
        TableName: usersTableName,
        Item: {
          id: { S: userId },
          username: { S: parsedInput.username },
          email: { S: parsedInput.email },
          // ! In production, never store passwords in plain text
          password: { S: parsedInput.password },
        },
      })
      .pipe(
        Effect.catchAll((e) => {
          loggerService.logError(e);
          return Effect.fail(new InternalServerError({ message: e.message }));
        }),
      );

    const now = Date.now();
    const inOneHour = now + 60 * 60 * 1000;

    const userToken = {
      iss: JWT_ISSUER,
      sub: userId,
      aud: JWT_AUDIENCE,
      exp: inOneHour,
      iat: now,
      jti: uuidV4(),
      role: USER_ROLE,
    } satisfies UserToken;

    return sign(userToken, process.env.JWT_SECRET);
  })
    .pipe(Effect.provide(LiveDynamoDbService))
    .pipe(Effect.provide(ApplicationLoggerService));
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
    } else if (error instanceof ConflictError) {
      res.status(HTTP_RESPONSE.CONFLICT).send(error.message);
    }

    res.status(HTTP_RESPONSE.INTERNAL_SERVER_ERROR).send(error.message);
  } else {
    res.status(HTTP_RESPONSE.CREATED).send(result.right);
  }
};

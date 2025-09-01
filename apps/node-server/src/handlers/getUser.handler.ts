import {
  generateRequestHandler,
  type handlerInput,
  HTTP_RESPONSE,
  InternalServerError,
  NotFoundError,
} from '@packages/backend-core';
import {
  GetUserSchema,
  type User,
  USER_SCHEMA_CONSTANTS,
  UserEmailSchema,
  type UserTableKey,
} from '@packages/schemas/user';
import { Effect } from 'effect';
import z, { ZodError } from 'zod';

import { usersTableName } from '@/clients/cdkOutputs';
import { parseInput } from '@/helpers/zodParser';
import {
  DynamoDbService,
  LiveDynamoDbService,
} from '@/services/dynamodb.service';
import {
  ApplicationLoggerService,
  LoggerService,
} from '@/services/logger.service';

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
    const loggerService = yield* LoggerService;

    // TODO: refactor out all configs to commons
    const key = ((): UserTableKey => {
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
            ProjectionExpression: 'username, email',
          })
          .pipe(Effect.map((response) => response.Item));
      },
      onFalse: () => {
        return databaseService
          .query({
            TableName: usersTableName,
            IndexName: USER_SCHEMA_CONSTANTS.gsi.email,
            KeyConditionExpression: 'email = :email',
            ExpressionAttributeValues: {
              ':email': {
                S: value,
              },
            },
            ProjectionExpression: 'id, username, email',
          })
          .pipe(Effect.map((response) => response.Items?.[0]));
      },
    }).pipe(
      Effect.catchAll((e) => {
        loggerService.logError(e);
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
  })
    .pipe(Effect.provide(LiveDynamoDbService))
    .pipe(Effect.provide(ApplicationLoggerService));
};

export const getUserRequestHandler = generateRequestHandler<
  User,
  NotFoundError | InternalServerError | ZodError
>({
  effectfulHandler: getUserHandler,
  shouldObfuscate: () => true,
  statusCodesToErrors: {
    [HTTP_RESPONSE.BAD_REQUEST]: {
      errorType: ZodError,
      mapper: (e) => z.prettifyError(e as ZodError),
    },
    [HTTP_RESPONSE.NOT_FOUND]: {
      errorType: NotFoundError,
      mapper: (e) => e.message,
    },
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      mapper: (e) => e.message,
    },
  },
  successCode: HTTP_RESPONSE.SUCCESS,
});

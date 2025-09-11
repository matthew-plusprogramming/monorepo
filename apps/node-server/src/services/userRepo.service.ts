import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { InternalServerError, LoggerService } from '@packages/backend-core';
import {
  USER_SCHEMA_CONSTANTS,
  type UserCreate,
  UserEmailSchema,
  type UserPublic,
  UserPublicSchema,
} from '@packages/schemas/user';
import { Context, Effect, Layer, Option } from 'effect';

import { usersTableName } from '@/clients/cdkOutputs';
import { DynamoDbService } from '@/services/dynamodb.service';

export type UserRepoSchema = {
  readonly findByIdentifier: (
    idOrEmail: string,
  ) => Effect.Effect<Option.Option<UserPublic>, InternalServerError>;
  readonly create: (
    user: UserCreate,
  ) => Effect.Effect<true, InternalServerError>;
};

export class UserRepo extends Context.Tag('UserRepo')<
  UserRepo,
  UserRepoSchema
>() {}

const unmarshallUser = (
  item?: Record<string, AttributeValue>,
): Option.Option<UserPublic> => {
  if (!item) return Option.none();
  const obj = unmarshall(item);
  const parsed = UserPublicSchema.safeParse(obj);
  if (!parsed.success) return Option.none();
  return Option.some(parsed.data);
};

const makeUserRepo = (): Effect.Effect<
  UserRepoSchema,
  never,
  DynamoDbService | LoggerService
> =>
  Effect.gen(function* () {
    const db = yield* DynamoDbService;
    const logger = yield* LoggerService;

    const findByIdentifier: UserRepoSchema['findByIdentifier'] = (idOrEmail) =>
      Effect.if(UserEmailSchema.safeParse(idOrEmail).success, {
        onTrue: () =>
          db
            .query({
              TableName: usersTableName,
              IndexName: USER_SCHEMA_CONSTANTS.gsi.email,
              KeyConditionExpression: '#email = :email',
              ExpressionAttributeNames: { '#email': 'email' },
              ExpressionAttributeValues: { ':email': { S: idOrEmail } },
              Limit: 1,
              ProjectionExpression: USER_SCHEMA_CONSTANTS.projection.userPublic,
            })
            .pipe(
              Effect.map((res) =>
                unmarshallUser(
                  res.Items?.[0] as Record<string, AttributeValue> | undefined,
                ),
              ),
              Effect.tapError((e) => logger.logError(e)),
              Effect.mapError(
                (e) => new InternalServerError({ message: e.message }),
              ),
            ),
        onFalse: () =>
          db
            .getItem({
              TableName: usersTableName,
              Key: { id: { S: idOrEmail } },
              ProjectionExpression: USER_SCHEMA_CONSTANTS.projection.userPublic,
            })
            .pipe(
              Effect.map((res) => unmarshallUser(res.Item ?? undefined)),
              Effect.tapError((e) => logger.logError(e)),
              Effect.mapError(
                (e) => new InternalServerError({ message: e.message }),
              ),
            ),
      });

    const create: UserRepoSchema['create'] = (user) =>
      db
        .putItem({
          TableName: usersTableName,
          Item: marshall(user),
        })
        .pipe(
          Effect.map(() => true as const),
          Effect.tapError((e) => logger.logError(e)),
          Effect.mapError(
            (e) => new InternalServerError({ message: e.message }),
          ),
        );

    return { findByIdentifier, create } satisfies UserRepoSchema;
  });

export const LiveUserRepo = Layer.effect(UserRepo, makeUserRepo());

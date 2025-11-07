import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
  type DynamoDbServiceSchema,
  InternalServerError,
  LoggerService,
  type LoggerServiceSchema,
} from '@packages/backend-core';
import {
  USER_SCHEMA_CONSTANTS,
  type UserCreate,
  UserCreateSchema,
  UserEmailSchema,
  UserIdSchema,
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

type UserRepoDeps = {
  readonly db: DynamoDbServiceSchema;
  readonly logger: LoggerServiceSchema;
};

const validateUserCreate = (
  deps: UserRepoDeps,
  payload: UserCreate,
): Effect.Effect<UserCreate, InternalServerError> =>
  Effect.try({
    try: () => UserCreateSchema.parse(payload),
    catch: (error) => error,
  }).pipe(
    Effect.tapError((error) => deps.logger.logError(error)),
    Effect.mapError(
      () =>
        new InternalServerError({
          message: 'Invalid user payload',
          cause: undefined,
        }),
    ),
  );

const findByEmail = (
  deps: UserRepoDeps,
  email: string,
): Effect.Effect<Option.Option<UserPublic>, InternalServerError> =>
  deps.db
    .query({
      TableName: usersTableName,
      IndexName: USER_SCHEMA_CONSTANTS.gsi.email,
      KeyConditionExpression: '#email = :email',
      ExpressionAttributeNames: {
        '#email': USER_SCHEMA_CONSTANTS.key.email,
      },
      ExpressionAttributeValues: { ':email': { S: email } },
      Limit: 1,
      ProjectionExpression: USER_SCHEMA_CONSTANTS.projection.userPublic,
    })
    .pipe(
      Effect.map((res) => unmarshallUser(res.Items?.[0])),
      Effect.tapError((error) => deps.logger.logError(error)),
      Effect.mapError(
        (error) =>
          new InternalServerError({ message: error.message, cause: error }),
      ),
    );

const findById = (
  deps: UserRepoDeps,
  id: string,
): Effect.Effect<Option.Option<UserPublic>, InternalServerError> =>
  deps.db
    .getItem({
      TableName: usersTableName,
      Key: {
        [USER_SCHEMA_CONSTANTS.key.id]: {
          S: id,
        },
      },
      ProjectionExpression: USER_SCHEMA_CONSTANTS.projection.userPublic,
    })
    .pipe(
      Effect.map((res) => unmarshallUser(res.Item)),
      Effect.tapError((error) => deps.logger.logError(error)),
      Effect.mapError(
        (error) =>
          new InternalServerError({ message: error.message, cause: error }),
      ),
    );

const buildFindByIdentifier =
  (deps: UserRepoDeps): UserRepoSchema['findByIdentifier'] =>
  (idOrEmail) =>
    Effect.if(UserEmailSchema.safeParse(idOrEmail).success, {
      onTrue: () => findByEmail(deps, idOrEmail),
      onFalse: () =>
        Effect.if(UserIdSchema.safeParse(idOrEmail).success, {
          onTrue: () => findById(deps, idOrEmail),
          onFalse: () => Effect.succeed(Option.none<UserPublic>()),
        }),
    });

const buildCreate =
  (deps: UserRepoDeps): UserRepoSchema['create'] =>
  (user) =>
    validateUserCreate(deps, user).pipe(
      Effect.flatMap((validatedUser) =>
        deps.db
          .putItem({
            TableName: usersTableName,
            Item: {
              ...marshall(validatedUser),
              createdAt: { S: new Date().toISOString() },
            },
          })
          .pipe(
            Effect.tapError((error) => deps.logger.logError(error)),
            Effect.mapError(
              (error) =>
                new InternalServerError({
                  message: error.message,
                  cause: error,
                }),
            ),
            Effect.flatMap(() => Effect.succeed(true)),
          ),
      ),
    );

const buildUserRepo = (deps: UserRepoDeps): UserRepoSchema => ({
  findByIdentifier: buildFindByIdentifier(deps),
  create: buildCreate(deps),
});

const makeUserRepo = (): Effect.Effect<
  UserRepoSchema,
  never,
  DynamoDbService | LoggerService
> =>
  Effect.gen(function* () {
    const db = yield* DynamoDbService;
    const logger = yield* LoggerService;
    return buildUserRepo({ db, logger });
  });

export const LiveUserRepo = Layer.effect(UserRepo, makeUserRepo());

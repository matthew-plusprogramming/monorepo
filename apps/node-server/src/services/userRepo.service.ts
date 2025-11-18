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
  type UserCredentials,
  UserCredentialsSchema,
  UserEmailSchema,
  UserIdSchema,
  type UserPublic,
  UserPublicSchema,
  UserUsernameSchema,
} from '@packages/schemas/user';
import { Context, Effect, Layer, Option } from 'effect';
import type { z } from 'zod';

import { usersTableName } from '@/clients/cdkOutputs';
import { DynamoDbService } from '@/services/dynamodb.service';

export type UserRepoSchema = {
  readonly findByIdentifier: (
    identifier: string,
  ) => Effect.Effect<Option.Option<UserPublic>, InternalServerError>;
  readonly findCredentialsByIdentifier: (
    identifier: string,
  ) => Effect.Effect<Option.Option<UserCredentials>, InternalServerError>;
  readonly create: (
    user: UserCreate,
  ) => Effect.Effect<true, InternalServerError>;
};

export class UserRepo extends Context.Tag('UserRepo')<
  UserRepo,
  UserRepoSchema
>() {}

const unmarshallUser = <T>(
  schema: z.ZodType<T>,
  item?: Record<string, AttributeValue>,
): Option.Option<T> => {
  if (!item) return Option.none();
  const obj = unmarshall(item);
  const parsed = schema.safeParse(obj);
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
      Effect.map((res) => unmarshallUser(UserPublicSchema, res.Items?.[0])),
      Effect.tapError((error) =>
        deps.logger.logError(
          error instanceof Error ? error : new Error(String(error)),
        ),
      ),
      Effect.mapError((error) => {
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        return new InternalServerError({
          message: normalizedError.message,
          cause: normalizedError,
        });
      }),
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
      Effect.map((res) => unmarshallUser(UserPublicSchema, res.Item)),
      Effect.tapError((error) =>
        deps.logger.logError(
          error instanceof Error ? error : new Error(String(error)),
        ),
      ),
      Effect.mapError((error) => {
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        return new InternalServerError({
          message: normalizedError.message,
          cause: normalizedError,
        });
      }),
    );

const findByUsername = (
  deps: UserRepoDeps,
  username: string,
): Effect.Effect<Option.Option<UserPublic>, InternalServerError> =>
  deps.db
    .query({
      TableName: usersTableName,
      IndexName: USER_SCHEMA_CONSTANTS.gsi.username,
      KeyConditionExpression: '#username = :username',
      ExpressionAttributeNames: {
        '#username': USER_SCHEMA_CONSTANTS.key.username,
      },
      ExpressionAttributeValues: { ':username': { S: username } },
      Limit: 1,
      ProjectionExpression: USER_SCHEMA_CONSTANTS.projection.userPublic,
    })
    .pipe(
      Effect.map((res) => unmarshallUser(UserPublicSchema, res.Items?.[0])),
      Effect.tapError((error) =>
        deps.logger.logError(
          error instanceof Error ? error : new Error(String(error)),
        ),
      ),
      Effect.mapError((error) => {
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        return new InternalServerError({
          message: normalizedError.message,
          cause: normalizedError,
        });
      }),
    );

const buildFindByIdentifier =
  (deps: UserRepoDeps): UserRepoSchema['findByIdentifier'] =>
  (identifier) =>
    Effect.if(UserEmailSchema.safeParse(identifier).success, {
      onTrue: () => findByEmail(deps, identifier),
      onFalse: () =>
        Effect.if(UserIdSchema.safeParse(identifier).success, {
          onTrue: () => findById(deps, identifier),
          onFalse: () =>
            Effect.if(UserUsernameSchema.safeParse(identifier).success, {
              onTrue: () => findByUsername(deps, identifier),
              onFalse: () => Effect.succeed(Option.none<UserPublic>()),
            }),
        }),
    });

const findCredentialsByEmail = (
  deps: UserRepoDeps,
  email: string,
): Effect.Effect<Option.Option<UserCredentials>, InternalServerError> =>
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
      ProjectionExpression: USER_SCHEMA_CONSTANTS.projection.userCredentials,
    })
    .pipe(
      Effect.map((res) =>
        unmarshallUser(UserCredentialsSchema, res.Items?.[0]),
      ),
      Effect.tapError((error) =>
        deps.logger.logError(
          error instanceof Error ? error : new Error(String(error)),
        ),
      ),
      Effect.mapError((error) => {
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        return new InternalServerError({
          message: normalizedError.message,
          cause: normalizedError,
        });
      }),
    );

const findCredentialsById = (
  deps: UserRepoDeps,
  id: string,
): Effect.Effect<Option.Option<UserCredentials>, InternalServerError> =>
  deps.db
    .getItem({
      TableName: usersTableName,
      Key: {
        [USER_SCHEMA_CONSTANTS.key.id]: {
          S: id,
        },
      },
      ProjectionExpression: USER_SCHEMA_CONSTANTS.projection.userCredentials,
    })
    .pipe(
      Effect.map((res) => unmarshallUser(UserCredentialsSchema, res.Item)),
      Effect.tapError((error) =>
        deps.logger.logError(
          error instanceof Error ? error : new Error(String(error)),
        ),
      ),
      Effect.mapError((error) => {
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        return new InternalServerError({
          message: normalizedError.message,
          cause: normalizedError,
        });
      }),
    );

const findCredentialsByUsername = (
  deps: UserRepoDeps,
  username: string,
): Effect.Effect<Option.Option<UserCredentials>, InternalServerError> =>
  deps.db
    .query({
      TableName: usersTableName,
      IndexName: USER_SCHEMA_CONSTANTS.gsi.username,
      KeyConditionExpression: '#username = :username',
      ExpressionAttributeNames: {
        '#username': USER_SCHEMA_CONSTANTS.key.username,
      },
      ExpressionAttributeValues: { ':username': { S: username } },
      Limit: 1,
      ProjectionExpression: USER_SCHEMA_CONSTANTS.projection.userCredentials,
    })
    .pipe(
      Effect.map((res) =>
        unmarshallUser(UserCredentialsSchema, res.Items?.[0]),
      ),
      Effect.tapError((error) =>
        deps.logger.logError(
          error instanceof Error ? error : new Error(String(error)),
        ),
      ),
      Effect.mapError((error) => {
        const normalizedError =
          error instanceof Error ? error : new Error(String(error));
        return new InternalServerError({
          message: normalizedError.message,
          cause: normalizedError,
        });
      }),
    );

const buildFindCredentialsByIdentifier =
  (deps: UserRepoDeps): UserRepoSchema['findCredentialsByIdentifier'] =>
  (identifier) =>
    Effect.if(UserEmailSchema.safeParse(identifier).success, {
      onTrue: () => findCredentialsByEmail(deps, identifier),
      onFalse: () =>
        Effect.if(UserIdSchema.safeParse(identifier).success, {
          onTrue: () => findCredentialsById(deps, identifier),
          onFalse: () =>
            Effect.if(UserUsernameSchema.safeParse(identifier).success, {
              onTrue: () => findCredentialsByUsername(deps, identifier),
              onFalse: () => Effect.succeed(Option.none<UserCredentials>()),
            }),
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
  findCredentialsByIdentifier: buildFindCredentialsByIdentifier(deps),
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

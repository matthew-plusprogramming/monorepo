import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
  InternalServerError,
  LoggerService,
  type LoggerServiceSchema,
  type DynamoDbServiceSchema,
} from '@packages/backend-core';
import {
  __ENTITY_CONSTANT___SCHEMA_CONSTANTS,
  type __ENTITY_PASCAL__Create,
  __ENTITY_PASCAL__CreateSchema,
  __ENTITY_PASCAL__IdSchema,
  type __ENTITY_PASCAL__Public,
  __ENTITY_PASCAL__PublicSchema,
} from '@packages/schemas/__ENTITY_SLUG__';
import { Context, Effect, Layer, Option } from 'effect';

import { DynamoDbService } from '@/services/dynamodb.service';

/**
 * TODO: Replace this placeholder with the generated table name exported from
 * `@/clients/cdkOutputs` once the CDK output schema is updated.
 */
const tableName = 'TODO_REPLACE_WITH_TABLE_NAME';

export type __ENTITY_PASCAL__RepoSchema = {
  readonly getById: (
    id: string,
  ) => Effect.Effect<
    Option.Option<__ENTITY_PASCAL__Public>,
    InternalServerError
  >;
  readonly create: (
    entity: __ENTITY_PASCAL__Create,
  ) => Effect.Effect<true, InternalServerError>;
};

export class __ENTITY_PASCAL__Repo extends Context.Tag(
  '__ENTITY_PASCAL__Repo',
)<__ENTITY_PASCAL__Repo, __ENTITY_PASCAL__RepoSchema>() {}

type __ENTITY_PASCAL__RepoDeps = {
  readonly db: DynamoDbServiceSchema;
  readonly logger: LoggerServiceSchema;
};

const unmarshall__ENTITY_PASCAL__ = (
  item?: Record<string, AttributeValue>,
): Option.Option<__ENTITY_PASCAL__Public> => {
  if (!item) return Option.none();
  const parsed = __ENTITY_PASCAL__PublicSchema.safeParse(unmarshall(item));
  if (!parsed.success) return Option.none();
  return Option.some(parsed.data);
};

const validateCreateInput = (
  deps: __ENTITY_PASCAL__RepoDeps,
  payload: __ENTITY_PASCAL__Create,
): Effect.Effect<__ENTITY_PASCAL__Create, InternalServerError> =>
  Effect.try({
    try: () => __ENTITY_PASCAL__CreateSchema.parse(payload),
    catch: (error) => error,
  }).pipe(
    Effect.tapError((error) => deps.logger.logError(error)),
    Effect.mapError(
      () =>
        new InternalServerError({
          message: 'Invalid __ENTITY_PASCAL__ payload',
        }),
    ),
  );

const buildGetById =
  (deps: __ENTITY_PASCAL__RepoDeps): __ENTITY_PASCAL__RepoSchema['getById'] =>
  (id) =>
    Effect.if(__ENTITY_PASCAL__IdSchema.safeParse(id).success, {
      onTrue: () =>
        deps.db
          .getItem({
            TableName: tableName,
            Key: {
              [__ENTITY_CONSTANT___SCHEMA_CONSTANTS.key.id]: {
                S: id,
              },
            },
            ProjectionExpression:
              __ENTITY_CONSTANT___SCHEMA_CONSTANTS.projection.__ENTITY_CAMEL__Public,
          })
          .pipe(
            Effect.map((res) => unmarshall__ENTITY_PASCAL__(res.Item ?? undefined)),
            Effect.tapError((error) => deps.logger.logError(error)),
            Effect.mapError(
              (error) =>
                new InternalServerError({
                  message: error.message,
                }),
            ),
          ),
      onFalse: () => Effect.succeed(Option.none()),
    });

const buildCreate =
  (deps: __ENTITY_PASCAL__RepoDeps): __ENTITY_PASCAL__RepoSchema['create'] =>
  (entity) =>
    validateCreateInput(deps, entity).pipe(
      Effect.flatMap((validated) =>
        deps.db
          .putItem({
            TableName: tableName,
            Item: marshall(validated),
          })
          .pipe(
            Effect.tapError((error) => deps.logger.logError(error)),
            Effect.mapError(
              (error) =>
                new InternalServerError({
                  message: error.message,
                }),
            ),
            Effect.flatMap(() => Effect.succeed(true)),
          ),
      ),
    );

const build__ENTITY_PASCAL__Repo = (
  deps: __ENTITY_PASCAL__RepoDeps,
): __ENTITY_PASCAL__RepoSchema => ({
  getById: buildGetById(deps),
  create: buildCreate(deps),
});

const make__ENTITY_PASCAL__Repo = (): Effect.Effect<
  __ENTITY_PASCAL__RepoSchema,
  never,
  DynamoDbService | LoggerService
> =>
  Effect.gen(function* () {
    const db = yield* DynamoDbService;
    const logger = yield* LoggerService;
    return build__ENTITY_PASCAL__Repo({ db, logger });
  });

export const Live__ENTITY_PASCAL__Repo = Layer.effect(
  __ENTITY_PASCAL__Repo,
  make__ENTITY_PASCAL__Repo(),
);

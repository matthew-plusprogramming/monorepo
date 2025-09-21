import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { USER_SCHEMA_CONSTANTS } from '@packages/schemas/user';
import { Effect, Layer, Option } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildUserCreate, buildUserPublic } from '@/__tests__/builders/user';
import { createDynamoDbServiceFake } from '@/__tests__/fakes/dynamodb';
import { createLoggerServiceFake } from '@/__tests__/fakes/logger';
import type { UserRepoSchema } from '@/services/userRepo.service';
import { LiveUserRepo, UserRepo } from '@/services/userRepo.service';

vi.mock('@/clients/cdkOutputs', () => ({
  usersTableName: 'test-users-table',
}));

describe('UserRepo', () => {
  const dynamoFake = createDynamoDbServiceFake();
  const loggerFake = createLoggerServiceFake();
  const dependencies = dynamoFake.layer.pipe(Layer.merge(loggerFake.layer));
  const repoLayer = LiveUserRepo.pipe(
    Layer.provide(dependencies),
  ) as Layer.Layer<UserRepo, never, never>;

  const run = <R, E>(effect: Effect.Effect<R, E, UserRepo>): Promise<R> =>
    Effect.runPromise(effect.pipe(Effect.provide(repoLayer)));

  const withRepo = <R, E>(
    use: (repo: UserRepoSchema) => Effect.Effect<R, E>,
  ): Promise<R> =>
    run(
      Effect.gen(function* () {
        const repo = yield* UserRepo;
        return yield* use(repo);
      }),
    );

  beforeEach(() => {
    dynamoFake.reset();
    loggerFake.reset();
  });

  it('returns Option.some when email query finds a user', async () => {
    const user = buildUserPublic({
      id: '11111111-1111-4111-8111-111111111111',
    });

    dynamoFake.queueSuccess('query', {
      $metadata: { httpStatusCode: 200 },
      Count: 1,
      Items: [marshall(user) as Record<string, AttributeValue>],
    });

    const result = await withRepo((repo) => repo.findByIdentifier(user.email));
    expect(Option.isSome(result)).toBe(true);
    expect(result).toEqual(Option.some(user));

    expect(dynamoFake.calls.query).toHaveLength(1);
    expect(dynamoFake.calls.query[0]).toMatchObject({
      TableName: 'test-users-table',
      IndexName: USER_SCHEMA_CONSTANTS.gsi.email,
      Limit: 1,
      ProjectionExpression: USER_SCHEMA_CONSTANTS.projection.userPublic,
    });
  });

  it('returns Option.none when email query returns an item failing schema parse', async () => {
    const invalidItem = marshall({ notAUser: true }) as Record<
      string,
      AttributeValue
    >;

    dynamoFake.queueSuccess('query', {
      $metadata: { httpStatusCode: 200 },
      Count: 1,
      Items: [invalidItem],
    });

    const result = await withRepo((repo) =>
      repo.findByIdentifier('invalid-user@example.com'),
    );

    expect(Option.isNone(result)).toBe(true);
    expect(dynamoFake.calls.query).toHaveLength(1);
    expect(dynamoFake.calls.query[0]).toMatchObject({
      TableName: 'test-users-table',
      IndexName: USER_SCHEMA_CONSTANTS.gsi.email,
    });
  });

  it('returns Option.none when id lookup misses', async () => {
    const user = buildUserPublic({
      id: '11111111-1111-4111-8111-111111111111',
    });

    dynamoFake.queueSuccess('getItem', {
      $metadata: { httpStatusCode: 200 },
    });

    const result = await withRepo((repo) => repo.findByIdentifier(user.id));

    expect(Option.isNone(result)).toBe(true);
    expect(dynamoFake.calls.getItem).toHaveLength(1);
    expect(dynamoFake.calls.getItem[0]).toMatchObject({
      TableName: 'test-users-table',
      Key: { id: { S: user.id } },
      ProjectionExpression: USER_SCHEMA_CONSTANTS.projection.userPublic,
    });
  });

  it('returns Option.some when id lookup succeeds', async () => {
    const user = buildUserPublic({
      id: '22222222-2222-4222-8222-222222222222',
    });

    dynamoFake.queueSuccess('getItem', {
      $metadata: { httpStatusCode: 200 },
      Item: marshall(user) as Record<string, AttributeValue>,
    });

    const result = await withRepo((repo) => repo.findByIdentifier(user.id));

    expect(result).toEqual(Option.some(user));
    expect(dynamoFake.calls.getItem).toHaveLength(1);
    expect(dynamoFake.calls.getItem[0]).toMatchObject({
      TableName: 'test-users-table',
      Key: { id: { S: user.id } },
    });
  });

  it('logs and maps DynamoDB failures to InternalServerError', async () => {
    const error = new Error('Dynamo offline');

    dynamoFake.queueFailure('query', error);

    await expect(
      withRepo((repo) => repo.findByIdentifier('someone@example.com')),
    ).rejects.toHaveProperty('message', error.message);

    expect(loggerFake.entries.errors).toContain(error);
  });

  it('logs getItem failures and maps to InternalServerError', async () => {
    const error = new Error('ddb get failed');

    dynamoFake.queueFailure('getItem', error);

    await expect(
      withRepo((repo) =>
        repo.findByIdentifier('33333333-3333-4333-8333-333333333333'),
      ),
    ).rejects.toHaveProperty('message', error.message);

    expect(loggerFake.entries.errors).toContain(error);
  });

  it('writes new users with marshalling and returns true', async () => {
    const user = buildUserCreate({
      id: '11111111-1111-4111-8111-111111111111',
    });

    dynamoFake.queueSuccess('putItem', {
      $metadata: { httpStatusCode: 200 },
    });

    const result = await withRepo((repo) => repo.create(user));

    expect(result).toBe(true);
    expect(dynamoFake.calls.putItem).toHaveLength(1);
    expect(dynamoFake.calls.putItem[0]).toMatchObject({
      TableName: 'test-users-table',
    });

    const marshalled = dynamoFake.calls.putItem[0]?.Item;
    expect(marshalled).toStrictEqual(marshall(user));
  });

  it('logs errors when putItem fails and emits InternalServerError', async () => {
    const user = buildUserCreate({
      id: '11111111-1111-4111-8111-111111111111',
    });
    const error = new Error('capacity exceeded');

    dynamoFake.queueFailure('putItem', error);

    await expect(withRepo((repo) => repo.create(user))).rejects.toHaveProperty(
      'message',
      error.message,
    );

    expect(loggerFake.entries.errors).toContain(error);
  });
});

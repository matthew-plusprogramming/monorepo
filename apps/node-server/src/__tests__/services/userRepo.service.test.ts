import { marshall } from '@aws-sdk/util-dynamodb';
import {
  createDynamoDbServiceFake,
  createLoggerServiceFake,
} from '@packages/backend-core/testing';
import { USER_SCHEMA_CONSTANTS } from '@packages/schemas/user';
import { Effect, Layer, Option } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildUserCreate, buildUserPublic } from '@/__tests__/builders/user';
import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';
import type { UserRepoSchema } from '@/services/userRepo.service';
import { LiveUserRepo, UserRepo } from '@/services/userRepo.service';

// Disabled for test file due to length
/* eslint-disable max-lines */

vi.mock('@/clients/cdkOutputs', () =>
  makeCdkOutputsStub({ usersTableName: 'test-users-table' }),
);

const dynamoFake = createDynamoDbServiceFake();
const loggerFake = createLoggerServiceFake();
const dependencies = dynamoFake.layer.pipe(Layer.merge(loggerFake.layer));
const repoLayer: Layer.Layer<UserRepo, never, never> = LiveUserRepo.pipe(
  Layer.provide(dependencies),
);

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

const resetRepoFakes = (): void => {
  dynamoFake.reset();
  loggerFake.reset();
};

const returnsSomeWhenEmailMatches = async (): Promise<void> => {
  // Arrange
  const user = buildUserPublic({
    id: '11111111-1111-4111-8111-111111111111',
  });

  dynamoFake.queueSuccess('query', {
    $metadata: { httpStatusCode: 200 },
    Count: 1,
    Items: [marshall(user)],
  });

  // Act
  const result = await withRepo((repo) => repo.findByIdentifier(user.email));

  // Assert
  expect(Option.isSome(result)).toBe(true);
  expect(result).toEqual(Option.some(user));

  expect(dynamoFake.calls.query).toHaveLength(1);
  expect(dynamoFake.calls.query[0]).toMatchObject({
    TableName: 'test-users-table',
    IndexName: USER_SCHEMA_CONSTANTS.gsi.email,
    ExpressionAttributeNames: {
      '#email': USER_SCHEMA_CONSTANTS.key.email,
    },
    Limit: 1,
    ProjectionExpression: USER_SCHEMA_CONSTANTS.projection.userPublic,
  });
};

const returnsNoneWhenEmailParseFails = async (): Promise<void> => {
  // Arrange
  const invalidItem = marshall({ notAUser: true });

  dynamoFake.queueSuccess('query', {
    $metadata: { httpStatusCode: 200 },
    Count: 1,
    Items: [invalidItem],
  });

  // Act
  const result = await withRepo((repo) =>
    repo.findByIdentifier('invalid-user@example.com'),
  );

  // Assert
  expect(Option.isNone(result)).toBe(true);
  expect(dynamoFake.calls.query).toHaveLength(1);
  expect(dynamoFake.calls.query[0]).toMatchObject({
    TableName: 'test-users-table',
    IndexName: USER_SCHEMA_CONSTANTS.gsi.email,
    ExpressionAttributeNames: {
      '#email': USER_SCHEMA_CONSTANTS.key.email,
    },
  });
};

const returnsNoneWhenIdMisses = async (): Promise<void> => {
  // Arrange
  const user = buildUserPublic({
    id: '11111111-1111-4111-8111-111111111111',
  });

  dynamoFake.queueSuccess('getItem', {
    $metadata: { httpStatusCode: 200 },
  });

  // Act
  const result = await withRepo((repo) => repo.findByIdentifier(user.id));

  // Assert
  expect(Option.isNone(result)).toBe(true);
  expect(dynamoFake.calls.getItem).toHaveLength(1);
  expect(dynamoFake.calls.getItem[0]).toMatchObject({
    TableName: 'test-users-table',
    Key: { id: { S: user.id } },
    ProjectionExpression: USER_SCHEMA_CONSTANTS.projection.userPublic,
  });
};

const returnsSomeWhenIdHits = async (): Promise<void> => {
  // Arrange
  const user = buildUserPublic({
    id: '22222222-2222-4222-8222-222222222222',
  });

  dynamoFake.queueSuccess('getItem', {
    $metadata: { httpStatusCode: 200 },
    Item: marshall(user),
  });

  // Act
  const result = await withRepo((repo) => repo.findByIdentifier(user.id));

  // Assert
  expect(result).toEqual(Option.some(user));
  expect(dynamoFake.calls.getItem).toHaveLength(1);
  expect(dynamoFake.calls.getItem[0]).toMatchObject({
    TableName: 'test-users-table',
    Key: { id: { S: user.id } },
  });
};

const returnsNoneWhenIdentifierInvalid = async (): Promise<void> => {
  // Arrange
  // No additional setup required

  // Act
  const result = await withRepo((repo) =>
    repo.findByIdentifier('not-a-valid-email-or-uuid'),
  );

  // Assert
  expect(Option.isNone(result)).toBe(true);
  expect(dynamoFake.calls.query).toHaveLength(0);
  expect(dynamoFake.calls.getItem).toHaveLength(0);
};

const logsQueryFailures = async (): Promise<void> => {
  // Arrange
  const error = new Error('Dynamo offline');

  dynamoFake.queueFailure('query', error);

  // Act
  const action = withRepo((repo) =>
    repo.findByIdentifier('someone@example.com'),
  );

  // Assert
  await expect(action).rejects.toHaveProperty('message', error.message);

  expect(loggerFake.entries.errors).toContainEqual([error]);
};

const logsGetItemFailures = async (): Promise<void> => {
  // Arrange
  const error = new Error('ddb get failed');

  dynamoFake.queueFailure('getItem', error);

  // Act
  const action = withRepo((repo) =>
    repo.findByIdentifier('33333333-3333-4333-8333-333333333333'),
  );

  // Assert
  await expect(action).rejects.toHaveProperty('message', error.message);

  expect(loggerFake.entries.errors).toContainEqual([error]);
};

const writesNewUsersSuccessfully = async (): Promise<void> => {
  // Arrange
  vi.useFakeTimers();
  const fixedDate = new Date('2024-05-01T12:34:56.000Z');
  vi.setSystemTime(fixedDate);

  const user = buildUserCreate({
    id: '11111111-1111-4111-8111-111111111111',
  });

  dynamoFake.queueSuccess('putItem', {
    $metadata: { httpStatusCode: 200 },
  });

  // Act
  const result = await withRepo((repo) => repo.create(user));

  try {
    // Assert
    expect(result).toBe(true);
    expect(dynamoFake.calls.putItem).toHaveLength(1);
    expect(dynamoFake.calls.putItem[0]).toMatchObject({
      TableName: 'test-users-table',
    });

    const marshalled = dynamoFake.calls.putItem[0]?.Item;
    expect(marshalled).toStrictEqual({
      ...marshall(user),
      createdAt: { S: fixedDate.toISOString() },
    });
  } finally {
    vi.useRealTimers();
  }
};

const logsPutItemFailures = async (): Promise<void> => {
  // Arrange
  const user = buildUserCreate({
    id: '11111111-1111-4111-8111-111111111111',
  });
  const error = new Error('capacity exceeded');

  dynamoFake.queueFailure('putItem', error);

  // Act
  const action = withRepo((repo) => repo.create(user));

  // Assert
  await expect(action).rejects.toHaveProperty('message', error.message);

  expect(loggerFake.entries.errors).toContainEqual([error]);
};

const validatesCreatePayload = async (): Promise<void> => {
  // Arrange
  const user = buildUserCreate({
    id: 'not-a-uuid',
  });

  // Act
  const action = withRepo((repo) => repo.create(user));

  // Assert
  await expect(action).rejects.toHaveProperty(
    'message',
    'Invalid user payload',
  );

  expect(dynamoFake.calls.putItem).toHaveLength(0);
  expect(loggerFake.entries.errors).toHaveLength(1);
  const [loggedError] = loggerFake.entries.errors[0] ?? [];
  expect(loggedError).toBeInstanceOf(Error);
};

describe('UserRepo', () => {
  beforeEach(resetRepoFakes);

  it(
    'returns Option.some when email query finds a user',
    returnsSomeWhenEmailMatches,
  );
  it(
    'returns Option.none when email query returns an item failing schema parse',
    returnsNoneWhenEmailParseFails,
  );
  it('returns Option.none when id lookup misses', returnsNoneWhenIdMisses);
  it(
    'returns Option.none without Dynamo lookups when identifier is invalid',
    returnsNoneWhenIdentifierInvalid,
  );
  it('returns Option.some when id lookup succeeds', returnsSomeWhenIdHits);
  it(
    'logs and maps DynamoDB failures to InternalServerError',
    logsQueryFailures,
  );
  it(
    'logs getItem failures and maps to InternalServerError',
    logsGetItemFailures,
  );
  it(
    'writes new users with marshalling and returns true',
    writesNewUsersSuccessfully,
  );
  it(
    'logs errors when putItem fails and emits InternalServerError',
    logsPutItemFailures,
  );
  it(
    'validates create payloads before writing and logs Zod errors',
    validatesCreatePayload,
  );
});

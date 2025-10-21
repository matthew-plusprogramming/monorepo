import {
  DynamoDbService,
  EventBridgeService,
  LoggerService,
} from '@packages/backend-core';
import { Effect, Layer, Option } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DynamoDbServiceFake } from '@/__tests__/fakes/dynamodb';
import type { EventBridgeServiceFake } from '@/__tests__/fakes/eventBridge';
import type { LoggerServiceFake } from '@/__tests__/fakes/logger';
import type * as DynamoServiceModule from '@/services/dynamodb.service';
import type * as EventBridgeServiceModule from '@/services/eventBridge.service';
import type * as LoggerServiceModule from '@/services/logger.service';
import type * as UserRepoModule from '@/services/userRepo.service';
import type { UserRepoSchema } from '@/services/userRepo.service';

vi.hoisted((): undefined => {
  Reflect.set(globalThis, '__BUNDLED__', false);
  return undefined;
});

const dynamoModule = vi.hoisted((): { fake?: DynamoDbServiceFake } => ({}));
const loggerModule = vi.hoisted((): { fake?: LoggerServiceFake } => ({}));
const eventBridgeModule = vi.hoisted(
  (): { fake?: EventBridgeServiceFake } => ({}),
);
const userRepoModule = vi.hoisted((): { service?: UserRepoSchema } => ({}));

vi.mock('@/clients/cdkOutputs', () => ({
  usersTableName: 'users-table',
  rateLimitTableName: 'rate-limit-table',
  denyListTableName: 'deny-list-table',
  analyticsEventBusArn: 'analytics-bus-arn',
  analyticsEventBusName: 'analytics-bus',
  analyticsDeadLetterQueueArn: 'analytics-dlq-arn',
  analyticsDeadLetterQueueUrl: 'https://example.com/dlq',
  analyticsDedupeTableName: 'analytics-dedupe-table',
  analyticsAggregateTableName: 'analytics-aggregate-table',
  analyticsEventLogGroupName: 'analytics-event-log-group',
  analyticsProcessorLogGroupName: 'analytics-processor-log-group',
}));

vi.mock('@/services/dynamodb.service', async (importOriginal) => {
  const actual: typeof DynamoServiceModule = await importOriginal();
  const { createDynamoDbServiceFake } = await import(
    '@/__tests__/fakes/dynamodb'
  );
  const fake = createDynamoDbServiceFake();
  dynamoModule.fake = fake;
  return {
    ...actual,
    LiveDynamoDbService: fake.layer,
  } satisfies typeof actual;
});

vi.mock('@/services/logger.service', async (importOriginal) => {
  const actual: typeof LoggerServiceModule = await importOriginal();
  const { createLoggerServiceFake } = await import('@/__tests__/fakes/logger');
  const fake = createLoggerServiceFake();
  loggerModule.fake = fake;
  return {
    ...actual,
    ApplicationLoggerService: fake.layer,
    SecurityLoggerService: fake.layer,
  } satisfies typeof actual;
});

vi.mock('@/services/eventBridge.service', async (importOriginal) => {
  const actual: typeof EventBridgeServiceModule = await importOriginal();
  const { createEventBridgeServiceFake } = await import(
    '@/__tests__/fakes/eventBridge'
  );
  const fake = createEventBridgeServiceFake();
  eventBridgeModule.fake = fake;
  return {
    ...actual,
    LiveEventBridgeService: fake.layer,
  } satisfies typeof actual;
});

vi.mock('@/services/userRepo.service', async (importOriginal) => {
  const actual: typeof UserRepoModule = await importOriginal();
  const service: UserRepoSchema = {
    findByIdentifier: vi.fn(() => Effect.succeed(Option.none())),
    create: vi.fn(() => Effect.succeed(true as const)),
  };
  userRepoModule.service = service;
  return {
    ...actual,
    LiveUserRepo: Layer.succeed(actual.UserRepo, service),
  } satisfies typeof actual;
});

describe('AppLayer', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('provides DynamoDb, Logger, EventBridge, and UserRepo services', async () => {
    // Arrange
    const { AppLayer } = await import('@/layers/app.layer');
    const { UserRepo } = await import('@/services/userRepo.service');

    // Act
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const dynamo = yield* DynamoDbService;
        const logger = yield* LoggerService;
        const eventBridge = yield* EventBridgeService;
        const repo = yield* UserRepo;
        return { dynamo, logger, eventBridge, repo };
      }).pipe(Effect.provide(AppLayer)),
    );

    // Assert
    expect(result.dynamo).toBe(getDynamoFake().service);
    expect(result.logger).toBe(getLoggerFake().service);
    expect(result.eventBridge).toBe(getEventBridgeFake().service);
    expect(result.repo).toBe(getUserRepoService());
  });
});

function getDynamoFake(): DynamoDbServiceFake {
  if (!dynamoModule.fake) {
    throw new Error('Dynamo fake was not initialized');
  }
  return dynamoModule.fake;
}

function getLoggerFake(): LoggerServiceFake {
  if (!loggerModule.fake) {
    throw new Error('Logger fake was not initialized');
  }
  return loggerModule.fake;
}

function getEventBridgeFake(): EventBridgeServiceFake {
  if (!eventBridgeModule.fake) {
    throw new Error('EventBridge fake was not initialized');
  }
  return eventBridgeModule.fake;
}

function getUserRepoService(): UserRepoSchema {
  if (!userRepoModule.service) {
    throw new Error('User repo service was not initialized');
  }
  return userRepoModule.service;
}

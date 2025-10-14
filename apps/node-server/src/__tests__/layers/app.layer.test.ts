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

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __BUNDLED__: boolean }).__BUNDLED__ =
    false;
  return undefined;
});

const dynamoModule = vi.hoisted(() => ({
  fake: undefined as DynamoDbServiceFake | undefined,
}));
const loggerModule = vi.hoisted(() => ({
  fake: undefined as LoggerServiceFake | undefined,
}));
const eventBridgeModule = vi.hoisted(() => ({
  fake: undefined as EventBridgeServiceFake | undefined,
}));
const userRepoModule = vi.hoisted(() => ({
  service: undefined as UserRepoSchema | undefined,
}));

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
  const actual = (await importOriginal()) as typeof DynamoServiceModule;
  const { createDynamoDbServiceFake } = await import(
    '@/__tests__/fakes/dynamodb'
  );
  const fake = createDynamoDbServiceFake();
  dynamoModule.fake = fake;
  return {
    ...actual,
    LiveDynamoDbService: fake.layer as typeof actual.LiveDynamoDbService,
  } satisfies typeof actual;
});

vi.mock('@/services/logger.service', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof LoggerServiceModule;
  const { createLoggerServiceFake } = await import('@/__tests__/fakes/logger');
  const fake = createLoggerServiceFake();
  loggerModule.fake = fake;
  return {
    ...actual,
    ApplicationLoggerService:
      fake.layer as typeof actual.ApplicationLoggerService,
    SecurityLoggerService: fake.layer as typeof actual.SecurityLoggerService,
  } satisfies typeof actual;
});

vi.mock('@/services/eventBridge.service', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof EventBridgeServiceModule;
  const { createEventBridgeServiceFake } = await import(
    '@/__tests__/fakes/eventBridge'
  );
  const fake = createEventBridgeServiceFake();
  eventBridgeModule.fake = fake;
  return {
    ...actual,
    LiveEventBridgeService: fake.layer as typeof actual.LiveEventBridgeService,
  } satisfies typeof actual;
});

vi.mock('@/services/userRepo.service', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof UserRepoModule;
  const service: UserRepoSchema = {
    findByIdentifier: vi.fn(() => Effect.succeed(Option.none())),
    create: vi.fn(() => Effect.succeed(true as const)),
  };
  userRepoModule.service = service;
  return {
    ...actual,
    LiveUserRepo: Layer.succeed(
      actual.UserRepo,
      service,
    ) as typeof actual.LiveUserRepo,
  } satisfies typeof actual;
});

describe('AppLayer', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('provides DynamoDb, Logger, EventBridge, and UserRepo services', async () => {
    const { AppLayer } = await import('@/layers/app.layer');
    const { UserRepo } = await import('@/services/userRepo.service');

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const dynamo = yield* DynamoDbService;
        const logger = yield* LoggerService;
        const eventBridge = yield* EventBridgeService;
        const repo = yield* UserRepo;
        return { dynamo, logger, eventBridge, repo };
      }).pipe(Effect.provide(AppLayer)),
    );

    expect(result.dynamo).toBe(getDynamoFake().service);
    expect(result.logger).toBe(getLoggerFake().service);
    expect(result.eventBridge).toBe(getEventBridgeFake().service);
    expect(result.repo).toBe(getUserRepoService());
  });
});

function getDynamoFake(): DynamoDbServiceFake {
  return dynamoModule.fake as DynamoDbServiceFake;
}

function getLoggerFake(): LoggerServiceFake {
  return loggerModule.fake as LoggerServiceFake;
}

function getEventBridgeFake(): EventBridgeServiceFake {
  return eventBridgeModule.fake as EventBridgeServiceFake;
}

function getUserRepoService(): UserRepoSchema {
  return userRepoModule.service as UserRepoSchema;
}

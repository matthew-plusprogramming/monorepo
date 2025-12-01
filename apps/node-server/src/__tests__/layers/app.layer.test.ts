import {
  DynamoDbService,
  EventBridgeService,
  LoggerService,
} from '@packages/backend-core';
import {
  type DynamoDbServiceFake,
  type EventBridgeServiceFake,
  type LoggerServiceFake,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import { Effect, Layer, Option } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';
import type * as DynamoServiceModule from '@/services/dynamodb.service';
import type * as EventBridgeServiceModule from '@/services/eventBridge.service';
import type * as LoggerServiceModule from '@/services/logger.service';
import type * as UserRepoModule from '@/services/userRepo.service';
import type { UserRepoSchema } from '@/services/userRepo.service';

const dynamoModule = vi.hoisted((): { fake?: DynamoDbServiceFake } => ({}));
const loggerModule = vi.hoisted((): { fake?: LoggerServiceFake } => ({}));
const eventBridgeModule = vi.hoisted(
  (): { fake?: EventBridgeServiceFake } => ({}),
);
const userRepoModule = vi.hoisted((): { service?: UserRepoSchema } => ({}));

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('@/services/dynamodb.service', async (importOriginal) => {
  const actual: typeof DynamoServiceModule = await importOriginal();
  const { createDynamoDbServiceFake } =
    await import('@packages/backend-core/testing');
  const fake = createDynamoDbServiceFake();
  dynamoModule.fake = fake;
  return {
    ...actual,
    LiveDynamoDbService: fake.layer,
  } satisfies typeof actual;
});

vi.mock('@/services/logger.service', async (importOriginal) => {
  const actual: typeof LoggerServiceModule = await importOriginal();
  const { createLoggerServiceFake } =
    await import('@packages/backend-core/testing');
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
  const { createEventBridgeServiceFake } =
    await import('@packages/backend-core/testing');
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
    findCredentialsByIdentifier: vi.fn(() => Effect.succeed(Option.none())),
    create: vi.fn(() => Effect.succeed(true as const)),
  };
  userRepoModule.service = service;
  return {
    ...actual,
    LiveUserRepo: Layer.succeed(actual.UserRepo, service),
  } satisfies typeof actual;
});

const getDynamoFake = (): DynamoDbServiceFake => {
  if (!dynamoModule.fake) {
    throw new Error('Dynamo fake was not initialized');
  }
  return dynamoModule.fake;
};

const getLoggerFake = (): LoggerServiceFake => {
  if (!loggerModule.fake) {
    throw new Error('Logger fake was not initialized');
  }
  return loggerModule.fake;
};

const getEventBridgeFake = (): EventBridgeServiceFake => {
  if (!eventBridgeModule.fake) {
    throw new Error('EventBridge fake was not initialized');
  }
  return eventBridgeModule.fake;
};

const getUserRepoService = (): UserRepoSchema => {
  if (!userRepoModule.service) {
    throw new Error('User repo service was not initialized');
  }
  return userRepoModule.service;
};

describe('AppLayer', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
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

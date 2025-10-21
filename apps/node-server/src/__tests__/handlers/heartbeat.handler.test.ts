import { HTTP_RESPONSE } from '@packages/backend-core';
import express, {
  type NextFunction,
  type Request,
  type Response as ExpressResponse,
} from 'express';
import request, { type Response } from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DynamoDbServiceFake } from '@/__tests__/fakes/dynamodb';
import type { EventBridgeServiceFake } from '@/__tests__/fakes/eventBridge';
import type { LoggerServiceFake } from '@/__tests__/fakes/logger';
import type { UserRepoFake } from '@/__tests__/fakes/userRepo';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const dynamoModule = vi.hoisted((): { fake?: DynamoDbServiceFake } => ({}));
const eventBridgeModule = vi.hoisted(
  (): { fake?: EventBridgeServiceFake } => ({}),
);
const loggerModule = vi.hoisted((): { fake?: LoggerServiceFake } => ({}));
const userRepoModule = vi.hoisted((): { fake?: UserRepoFake } => ({}));

vi.mock('@/clients/cdkOutputs', () => ({
  analyticsEventBusArn: 'analytics-bus-arn',
  analyticsEventBusName: 'analytics-bus',
  analyticsDeadLetterQueueArn: 'analytics-dlq-arn',
  analyticsDeadLetterQueueUrl: 'https://example.com/dlq',
  analyticsDedupeTableName: 'analytics-dedupe-table',
  analyticsAggregateTableName: 'analytics-aggregate-table',
  analyticsEventLogGroupName: 'analytics-event-log-group',
  analyticsProcessorLogGroupName: 'analytics-processor-log-group',
  rateLimitTableName: 'rate-limit-table',
  denyListTableName: 'deny-list-table',
  usersTableName: 'users-table',
}));

vi.mock('@/layers/app.layer', async () => {
  const { Layer } = await import('effect');
  const { createDynamoDbServiceFake } = await import(
    '@/__tests__/fakes/dynamodb'
  );
  const { createEventBridgeServiceFake } = await import(
    '@/__tests__/fakes/eventBridge'
  );
  const { createLoggerServiceFake } = await import('@/__tests__/fakes/logger');
  const { createUserRepoFake } = await import('@/__tests__/fakes/userRepo');

  const dynamoFake = createDynamoDbServiceFake();
  const eventBridgeFake = createEventBridgeServiceFake();
  const loggerFake = createLoggerServiceFake();
  const userRepoFake = createUserRepoFake();

  dynamoModule.fake = dynamoFake;
  eventBridgeModule.fake = eventBridgeFake;
  loggerModule.fake = loggerFake;
  userRepoModule.fake = userRepoFake;

  const AppLayer = Layer.mergeAll(
    dynamoFake.layer,
    loggerFake.layer,
    eventBridgeFake.layer,
    userRepoFake.layer,
  );

  return { AppLayer };
});

describe('heartbeatRequestHandler', () => {
  beforeEach(initializeHeartbeatContext);
  afterEach(cleanupHeartbeatContext);

  it('publishes a heartbeat event and returns 200', publishesHeartbeatEvent);
  it(
    'obfuscates failures when EventBridge reports failed entries',
    obfuscatesFailedEntries,
  );
  it(
    'obfuscates failures when publishing heartbeat event errors',
    obfuscatesPublishErrors,
  );
});

function getDynamoFake(): DynamoDbServiceFake {
  if (!dynamoModule.fake) {
    throw new Error('Dynamo fake was not initialized');
  }
  return dynamoModule.fake;
}

function getEventBridgeFake(): EventBridgeServiceFake {
  if (!eventBridgeModule.fake) {
    throw new Error('EventBridge fake was not initialized');
  }
  return eventBridgeModule.fake;
}

function getLoggerFake(): LoggerServiceFake {
  if (!loggerModule.fake) {
    throw new Error('Logger fake was not initialized');
  }
  return loggerModule.fake;
}

function getUserRepoFake(): UserRepoFake {
  if (!userRepoModule.fake) {
    throw new Error('User repo fake was not initialized');
  }
  return userRepoModule.fake;
}

function initializeHeartbeatContext(): void {
  vi.resetModules();
  process.env.APP_ENV = 'test-env';
  process.env.APP_VERSION = '2.0.0';
  Reflect.set(globalThis, '__BUNDLED__', false);
}

function cleanupHeartbeatContext(): void {
  Reflect.deleteProperty(process.env, 'APP_ENV');
  Reflect.deleteProperty(process.env, 'APP_VERSION');
}

async function publishesHeartbeatEvent(): Promise<void> {
  const { response, eventBridgeFake, loggerFake } = await runHeartbeatScenario({
    user: { sub: 'user-1', jti: 'token-1' },
    platform: 'android',
    configureEventBridge: (fake) => {
      fake.queueSuccess({
        $metadata: { httpStatusCode: 200 },
        FailedEntryCount: 0,
      });
    },
  });

  expect(response.status).toBe(HTTP_RESPONSE.SUCCESS);
  expect(response.text).toBe('OK');
  expect(eventBridgeFake.calls).toHaveLength(1);
  const [entry] = eventBridgeFake.calls[0]?.Entries ?? [];
  expect(entry?.EventBusName).toBe('analytics-bus');
  const parsedDetail: unknown = JSON.parse(entry?.Detail ?? '{}');
  if (!isRecord(parsedDetail)) {
    throw new Error('Heartbeat detail payload missing');
  }
  const detail = parsedDetail;
  expect(detail).toMatchObject({
    userId: 'user-1',
    env: 'test-env',
    appVersion: '2.0.0',
    platform: 'android',
  });
  expect(loggerFake.entries.logs).toContainEqual([
    'Heartbeat event recorded for user user-1',
  ]);
  expect(loggerFake.entries.errors).toHaveLength(0);
}

async function obfuscatesFailedEntries(): Promise<void> {
  const { response, eventBridgeFake, loggerFake } = await runHeartbeatScenario({
    user: { sub: 'user-3', jti: 'token-3' },
    configureEventBridge: (fake) => {
      fake.queueSuccess({
        $metadata: { httpStatusCode: 200 },
        FailedEntryCount: 1,
        Entries: [
          {
            ErrorCode: 'InternalFailure',
            ErrorMessage: 'Bus throttled',
          },
        ],
      });
    },
  });

  expect(response.status).toBe(HTTP_RESPONSE.BAD_GATEWAY);
  expect(response.text).toBe('Bad Gateway');
  expect(eventBridgeFake.calls).toHaveLength(1);
  expect(loggerFake.entries.logs).toHaveLength(0);
  const errorArgs = loggerFake.entries.errors[0] ?? [];
  const firstError = errorArgs[0];
  expect(firstError).toBeInstanceOf(Error);
  if (firstError instanceof Error) {
    expect(firstError.message).toContain('InternalFailure');
  }
}

async function obfuscatesPublishErrors(): Promise<void> {
  const { response, loggerFake } = await runHeartbeatScenario({
    user: { sub: 'user-2', jti: 'token-2' },
    configureEventBridge: (fake) => {
      fake.queueFailure(new Error('boom'));
    },
  });

  expect(response.status).toBe(HTTP_RESPONSE.BAD_GATEWAY);
  expect(response.text).toBe('Bad Gateway');
  expect(loggerFake.entries.errors).toHaveLength(1);
}

type HeartbeatScenarioOptions = {
  user: { sub: string; jti: string };
  platform?: string;
  configureEventBridge: (fake: EventBridgeServiceFake) => void;
};

type HeartbeatScenarioResult = {
  response: Response;
  eventBridgeFake: EventBridgeServiceFake;
  loggerFake: LoggerServiceFake;
};

async function runHeartbeatScenario({
  user,
  platform,
  configureEventBridge,
}: HeartbeatScenarioOptions): Promise<HeartbeatScenarioResult> {
  const { heartbeatRequestHandler } = await import(
    '@/handlers/heartbeat.handler'
  );
  const eventBridgeFake = getEventBridgeFake();
  const loggerFake = getLoggerFake();

  resetHeartbeatFakes(eventBridgeFake, loggerFake);
  configureEventBridge(eventBridgeFake);

  const app = express();
  app.get('/heartbeat', attachUser(user), heartbeatRequestHandler);

  const httpRequest = request(app).get('/heartbeat');
  if (platform) {
    httpRequest.set('X-Platform', platform);
  }

  const response = await httpRequest;

  return { response, eventBridgeFake, loggerFake };
}

function resetHeartbeatFakes(
  eventBridgeFake: EventBridgeServiceFake,
  loggerFake: LoggerServiceFake,
): void {
  eventBridgeFake.reset();
  loggerFake.reset();
  getDynamoFake().reset();
  getUserRepoFake().reset();
}

function attachUser(user: { sub: string; jti: string }) {
  return (req: Request, _res: ExpressResponse, next: NextFunction): void => {
    Object.assign(req, { user });
    next();
  };
}
vi.hoisted(() => {
  Reflect.set(globalThis, '__BUNDLED__', false);
  return undefined;
});

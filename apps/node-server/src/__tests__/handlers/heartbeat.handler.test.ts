import { HTTP_RESPONSE } from '@packages/backend-core';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DynamoDbServiceFake } from '@/__tests__/fakes/dynamodb';
import type { EventBridgeServiceFake } from '@/__tests__/fakes/eventBridge';
import type { LoggerServiceFake } from '@/__tests__/fakes/logger';
import type { UserRepoFake } from '@/__tests__/fakes/userRepo';

const dynamoModule = vi.hoisted(() => ({
  fake: undefined as DynamoDbServiceFake | undefined,
}));
const eventBridgeModule = vi.hoisted(() => ({
  fake: undefined as EventBridgeServiceFake | undefined,
}));
const loggerModule = vi.hoisted(() => ({
  fake: undefined as LoggerServiceFake | undefined,
}));
const userRepoModule = vi.hoisted(() => ({
  fake: undefined as UserRepoFake | undefined,
}));

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
  beforeEach(() => {
    vi.resetModules();
    process.env.APP_ENV = 'test-env';
    process.env.APP_VERSION = '2.0.0';
    (globalThis as typeof globalThis & { __BUNDLED__?: boolean }).__BUNDLED__ =
      false;
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, 'APP_ENV');
    Reflect.deleteProperty(process.env, 'APP_VERSION');
  });

  it('publishes a heartbeat event and returns 200', async () => {
    const { heartbeatRequestHandler } = await import(
      '@/handlers/heartbeat.handler'
    );
    const eventBridgeFake = getEventBridgeFake();
    eventBridgeFake.reset();
    getLoggerFake().reset();
    getDynamoFake().reset();
    getUserRepoFake().reset();
    eventBridgeFake.queueSuccess({
      $metadata: { httpStatusCode: 200 },
      FailedEntryCount: 0,
    });

    const app = express();
    app.get(
      '/heartbeat',
      (req, _res, next) => {
        Object.assign(req, {
          user: {
            sub: 'user-1',
            jti: 'token-1',
          },
        });
        next();
      },
      heartbeatRequestHandler,
    );

    const response = await request(app)
      .get('/heartbeat')
      .set('X-Platform', 'android');

    expect(response.status).toBe(HTTP_RESPONSE.SUCCESS);
    expect(response.text).toBe('OK');
    expect(eventBridgeFake.calls).toHaveLength(1);
    const [entry] = eventBridgeFake.calls[0]?.Entries ?? [];
    expect(entry?.EventBusName).toBe('analytics-bus');
    const detail = JSON.parse(entry?.Detail ?? '{}') as Record<string, unknown>;
    expect(detail).toMatchObject({
      userId: 'user-1',
      env: 'test-env',
      appVersion: '2.0.0',
      platform: 'android',
    });
    expect(getLoggerFake().entries.logs).toContainEqual([
      'Heartbeat event recorded for user user-1',
    ]);
    expect(getLoggerFake().entries.errors).toHaveLength(0);
  });

  it('obfuscates failures when EventBridge reports failed entries', async () => {
    const { heartbeatRequestHandler } = await import(
      '@/handlers/heartbeat.handler'
    );
    const eventBridgeFake = getEventBridgeFake();
    eventBridgeFake.reset();
    getLoggerFake().reset();
    getDynamoFake().reset();
    getUserRepoFake().reset();
    eventBridgeFake.queueSuccess({
      $metadata: { httpStatusCode: 200 },
      FailedEntryCount: 1,
      Entries: [
        {
          ErrorCode: 'InternalFailure',
          ErrorMessage: 'Bus throttled',
        },
      ],
    });

    const app = express();
    app.get(
      '/heartbeat',
      (req, _res, next) => {
        Object.assign(req, {
          user: {
            sub: 'user-3',
            jti: 'token-3',
          },
        });
        next();
      },
      heartbeatRequestHandler,
    );

    const response = await request(app).get('/heartbeat');

    expect(response.status).toBe(HTTP_RESPONSE.BAD_GATEWAY);
    expect(response.text).toBe('Bad Gateway');
    expect(eventBridgeFake.calls).toHaveLength(1);
    expect(getLoggerFake().entries.logs).toHaveLength(0);
    const errorArgs = getLoggerFake().entries.errors[0] ?? [];
    const firstError = errorArgs[0];
    expect(firstError).toBeInstanceOf(Error);
    if (firstError instanceof Error) {
      expect(firstError.message).toContain('InternalFailure');
    }
  });

  it('obfuscates failures when publishing heartbeat event errors', async () => {
    const { heartbeatRequestHandler } = await import(
      '@/handlers/heartbeat.handler'
    );
    const eventBridgeFake = getEventBridgeFake();
    eventBridgeFake.reset();
    getLoggerFake().reset();
    getDynamoFake().reset();
    getUserRepoFake().reset();
    eventBridgeFake.queueFailure(new Error('boom'));

    const app = express();
    app.get(
      '/heartbeat',
      (req, _res, next) => {
        Object.assign(req, {
          user: {
            sub: 'user-2',
            jti: 'token-2',
          },
        });
        next();
      },
      heartbeatRequestHandler,
    );

    const response = await request(app).get('/heartbeat');

    expect(response.status).toBe(HTTP_RESPONSE.BAD_GATEWAY);
    expect(response.text).toBe('Bad Gateway');
    expect(getLoggerFake().entries.errors).toHaveLength(1);
  });
});

function getDynamoFake(): DynamoDbServiceFake {
  return dynamoModule.fake as DynamoDbServiceFake;
}

function getEventBridgeFake(): EventBridgeServiceFake {
  return eventBridgeModule.fake as EventBridgeServiceFake;
}

function getLoggerFake(): LoggerServiceFake {
  return loggerModule.fake as LoggerServiceFake;
}

function getUserRepoFake(): UserRepoFake {
  return userRepoModule.fake as UserRepoFake;
}
vi.hoisted(() => {
  (globalThis as typeof globalThis & { __BUNDLED__?: boolean }).__BUNDLED__ =
    false;
  return undefined;
});

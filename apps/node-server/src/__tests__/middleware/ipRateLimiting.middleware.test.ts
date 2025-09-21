import type {
  UpdateItemCommandInput,
  UpdateItemCommandOutput,
} from '@aws-sdk/client-dynamodb';
import { HTTP_RESPONSE } from '@packages/backend-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DynamoDbServiceFake } from '@/__tests__/fakes/dynamodb';
import type { LoggerServiceFake } from '@/__tests__/fakes/logger';
import { makeRequestContext } from '@/__tests__/utils/express';
import { ipRateLimitingMiddlewareRequestHandler } from '@/middleware/ipRateLimiting.middleware';
import type * as DynamoServiceModule from '@/services/dynamodb.service';
import type * as LoggerServiceModule from '@/services/logger.service';

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __BUNDLED__: boolean }).__BUNDLED__ =
    false;
  return undefined;
});

const dynamoModule = vi.hoisted(() => ({ fake: undefined as unknown }));
const loggerModule = vi.hoisted(() => ({ fake: undefined as unknown }));

vi.mock('@/clients/cdkOutputs', () => ({
  rateLimitTableName: 'rate-limit-table',
  applicationLogGroupName: 'app-log-group',
  serverLogStreamName: 'app-log-stream',
  securityLogGroupName: 'sec-log-group',
  securityLogStreamName: 'sec-log-stream',
  denyListTableName: 'deny-list-table',
  usersTableName: 'users-table',
}));

vi.mock('@/services/logger.service', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof LoggerServiceModule;
  const { createLoggerServiceFake } = await import('@/__tests__/fakes/logger');
  const fake = createLoggerServiceFake();
  loggerModule.fake = fake;
  return {
    ...actual,
    ApplicationLoggerService: fake.layer,
    SecurityLoggerService: fake.layer,
  };
});

vi.mock('@/services/dynamodb.service', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof DynamoServiceModule;
  const { createDynamoDbServiceFake } = await import(
    '@/__tests__/fakes/dynamodb'
  );
  const fake = createDynamoDbServiceFake();
  dynamoModule.fake = fake;
  return {
    ...actual,
    LiveDynamoDbService: fake.layer,
  };
});

const getLoggerFake = (): LoggerServiceFake =>
  loggerModule.fake as LoggerServiceFake;
const getDynamoFake = (): DynamoDbServiceFake =>
  dynamoModule.fake as DynamoDbServiceFake;

const expectPartitionKey = (
  input: UpdateItemCommandInput,
  ip: string,
  now: Date,
): void => {
  const WINDOW_SECONDS = 60;
  const nowSec = Math.floor(now.getTime() / 1000);
  const windowStart = Math.floor(nowSec / WINDOW_SECONDS) * WINDOW_SECONDS;
  expect(input.Key?.pk?.S).toBe(`ip#${ip}#${windowStart}`);
};

describe('ipRateLimitingMiddlewareRequestHandler', () => {
  beforeEach(() => {
    getLoggerFake().reset();
    getDynamoFake().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes through when the IP is under the allowed threshold', async () => {
    vi.useFakeTimers();
    const now = new Date('2024-01-01T00:00:05Z');
    vi.setSystemTime(now);

    const { req, res, next, captured } = makeRequestContext({
      ip: '198.51.100.20',
    });

    const dynamoFake = getDynamoFake();
    const updateResult: UpdateItemCommandOutput = {
      $metadata: {},
      Attributes: {
        calls: { N: '3' },
      },
    };
    dynamoFake.queueSuccess('updateItem', updateResult);

    await expect(
      ipRateLimitingMiddlewareRequestHandler(req, res, next),
    ).resolves.toBeUndefined();

    expect(next).toHaveBeenCalledTimes(1);
    expect(captured.statusCode).toBeUndefined();

    const [updateCall] = dynamoFake.calls.updateItem;
    expect(updateCall?.TableName).toBe('rate-limit-table');
    expect(req.ip).toBeDefined();
    expectPartitionKey(
      updateCall as UpdateItemCommandInput,
      req.ip as string,
      now,
    );
  });

  it('returns 429 and logs when the rate limit is exceeded', async () => {
    vi.useFakeTimers();
    const now = new Date('2024-01-01T00:00:30Z');
    vi.setSystemTime(now);

    const { req, res, next, captured } = makeRequestContext({
      ip: '203.0.113.42',
    });

    const dynamoFake = getDynamoFake();
    const updateResult: UpdateItemCommandOutput = {
      $metadata: {},
      Attributes: {
        calls: { N: '6' },
      },
    };
    dynamoFake.queueSuccess('updateItem', updateResult);

    await expect(
      ipRateLimitingMiddlewareRequestHandler(req, res, next),
    ).rejects.toBeDefined();
    expect(captured.statusCode).toBe(HTTP_RESPONSE.THROTTLED);
    expect(next).not.toHaveBeenCalled();
    expect(getLoggerFake().entries.logs).toContain(
      `[RATE_LIMIT_EXCEEDED] ${req.ip as string} - 6 calls`,
    );
  });

  it('propagates an internal error when DynamoDB update fails', async () => {
    vi.useFakeTimers();
    const now = new Date('2024-01-01T00:00:45Z');
    vi.setSystemTime(now);

    const { req, res, next, captured } = makeRequestContext({
      ip: '192.0.2.10',
    });

    const dynamoFake = getDynamoFake();
    dynamoFake.queueFailure('updateItem', new Error('ddb down'));

    await expect(
      ipRateLimitingMiddlewareRequestHandler(req, res, next),
    ).rejects.toBeDefined();
    expect(captured.statusCode).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
    expect(getLoggerFake().entries.errors[0]?.message).toBe('ddb down');
  });
});

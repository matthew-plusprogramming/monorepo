import type {
  UpdateItemCommandInput,
  UpdateItemCommandOutput,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDbService,
  HTTP_RESPONSE,
  LoggerService,
} from '@packages/backend-core';
import {
  type DynamoDbServiceFake,
  type LoggerServiceFake,
  makeRequestContext,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';
import { ipRateLimitingMiddlewareRequestHandler } from '@/middleware/ipRateLimiting.middleware';

const dynamoModule = vi.hoisted((): { fake?: DynamoDbServiceFake } => ({}));
const loggerModule = vi.hoisted((): { fake?: LoggerServiceFake } => ({}));

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('@/services/logger.service', async () => {
  const { createLoggerServiceFake } = await import(
    '@packages/backend-core/testing'
  );
  const fake = createLoggerServiceFake();
  loggerModule.fake = fake;
  return {
    LoggerService,
    ApplicationLoggerService: fake.layer,
    SecurityLoggerService: fake.layer,
  };
});

vi.mock('@/services/dynamodb.service', async () => {
  const { createDynamoDbServiceFake } = await import(
    '@packages/backend-core/testing'
  );
  const fake = createDynamoDbServiceFake();
  dynamoModule.fake = fake;
  return {
    DynamoDbService,
    LiveDynamoDbService: fake.layer,
  };
});

const getLoggerFake = (): LoggerServiceFake => {
  if (!loggerModule.fake) {
    throw new Error('Logger fake was not initialized');
  }
  return loggerModule.fake;
};

const getDynamoFake = (): DynamoDbServiceFake => {
  if (!dynamoModule.fake) {
    throw new Error('Dynamo fake was not initialized');
  }
  return dynamoModule.fake;
};

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

const resetFakes = (): void => {
  setBundledRuntime(false);
  getLoggerFake().reset();
  getDynamoFake().reset();
};

const passesThroughWhenUnderThreshold = async (): Promise<void> => {
  // Arrange
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

  // Act
  const action = ipRateLimitingMiddlewareRequestHandler(req, res, next);

  // Assert
  await expect(action).resolves.toBeUndefined();
  expect(next).toHaveBeenCalledTimes(1);
  expect(captured.statusCode).toBeUndefined();

  const [updateCall] = dynamoFake.calls.updateItem;
  if (!updateCall) {
    throw new Error('Missing Dynamo update call');
  }
  expect(updateCall.TableName).toBe('rate-limit-table');
  const ip = req.ip;
  if (typeof ip !== 'string') {
    throw new Error('Expected request ip to be defined');
  }
  expectPartitionKey(updateCall, ip, now);
};

const returns429WhenExceeded = async (): Promise<void> => {
  // Arrange
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

  // Act
  const action = ipRateLimitingMiddlewareRequestHandler(req, res, next);

  // Assert
  await expect(action).rejects.toBeDefined();
  expect(captured.statusCode).toBe(HTTP_RESPONSE.THROTTLED);
  expect(next).not.toHaveBeenCalled();
  const ip = req.ip;
  if (typeof ip !== 'string') {
    throw new Error('Expected request ip to be defined');
  }
  expect(getLoggerFake().entries.logs).toContainEqual([
    `[RATE_LIMIT_EXCEEDED] ${ip} - 6 calls`,
  ]);
};

const propagatesWhenUpdateFails = async (): Promise<void> => {
  // Arrange
  vi.useFakeTimers();
  const now = new Date('2024-01-01T00:00:45Z');
  vi.setSystemTime(now);

  const { req, res, next, captured } = makeRequestContext({
    ip: '192.0.2.10',
  });

  const dynamoFake = getDynamoFake();
  dynamoFake.queueFailure('updateItem', new Error('ddb down'));

  // Act
  const action = ipRateLimitingMiddlewareRequestHandler(req, res, next);

  // Assert
  await expect(action).rejects.toBeDefined();
  expect(captured.statusCode).toBeUndefined();
  expect(next).not.toHaveBeenCalled();
  const errorArgs = getLoggerFake().entries.errors[0] ?? [];
  const firstError = errorArgs[0];
  expect(firstError).toBeInstanceOf(Error);
  if (firstError instanceof Error) {
    expect(firstError.message).toBe('ddb down');
  }
};

const rejectsWhenIpMissing = async (): Promise<void> => {
  // Arrange
  const { req, res, next, captured } = makeRequestContext();

  const dynamoFake = getDynamoFake();

  // Act
  const action = ipRateLimitingMiddlewareRequestHandler(req, res, next);

  // Assert
  await expect(action).rejects.toBeDefined();
  expect(captured.statusCode).toBe(HTTP_RESPONSE.THROTTLED);
  expect(dynamoFake.calls.updateItem).toHaveLength(0);
  expect(next).not.toHaveBeenCalled();
};

describe('ipRateLimitingMiddlewareRequestHandler', () => {
  beforeEach(resetFakes);
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    'passes through when the IP is under the allowed threshold',
    passesThroughWhenUnderThreshold,
  );

  it(
    'returns 429 and logs when the rate limit is exceeded',
    returns429WhenExceeded,
  );

  it(
    'propagates an internal error when DynamoDB update fails',
    propagatesWhenUpdateFails,
  );

  it('returns 429 when the request has no resolved ip', rejectsWhenIpMissing);
});

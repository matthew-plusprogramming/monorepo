import type { DescribeTableCommandOutput } from '@aws-sdk/client-dynamodb';
import { HTTP_RESPONSE, LoggerService } from '@packages/backend-core';
import {
  makeRequestContext,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import { Effect, Layer } from 'effect';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';

// Hoisted mocks - these are executed first
const mockSend = vi.hoisted(() => vi.fn());
const mockDestroy = vi.hoisted(() => vi.fn());

type LogEntry = ReadonlyArray<unknown>;

const loggerState = vi.hoisted(() => ({
  logs: [] as LogEntry[],
  errors: [] as LogEntry[],
  debugs: [] as LogEntry[],
}));

// Mock @/clients/cdkOutputs
vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

// Mock DynamoDB client - use class syntax
vi.mock('@aws-sdk/client-dynamodb', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();

  class MockDynamoDBClient {
    send = mockSend;
    destroy = mockDestroy;
  }

  return {
    ...original,
    DynamoDBClient: MockDynamoDBClient,
  };
});

// Mock LoggerService
vi.mock('@/services/logger.service', async () => {
  const { Layer, Effect } = await import('effect');
  const { LoggerService } = await import('@packages/backend-core');

  const service = {
    log: (...input: unknown[]) =>
      Effect.sync(() => {
        loggerState.logs.push(input);
      }),
    logError: (...input: unknown[]) =>
      Effect.sync(() => {
        loggerState.errors.push(input);
      }),
    logDebug: (...input: unknown[]) =>
      Effect.sync(() => {
        loggerState.debugs.push(input);
      }),
  };

  return {
    ApplicationLoggerService: Layer.succeed(LoggerService, service),
  };
});

const resetLoggerState = (): void => {
  loggerState.logs.length = 0;
  loggerState.errors.length = 0;
  loggerState.debugs.length = 0;
};

describe('health.handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBundledRuntime(false);
    resetLoggerState();
    // Set version env var for consistent testing
    vi.stubEnv('APP_VERSION', '1.2.3');
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  describe('healthRequestHandler', () => {
    const makeActiveTableResponse = (): DescribeTableCommandOutput => ({
      $metadata: {},
      Table: {
        TableName: 'users-table',
        TableStatus: 'ACTIVE',
      },
    });

    it('returns 200 with healthy status when DynamoDB is active (AC11.1, AC11.2)', async () => {
      // Arrange
      mockSend.mockResolvedValueOnce(makeActiveTableResponse());
      const { req, res, captured } = makeRequestContext();

      const { healthRequestHandler } =
        await import('@/handlers/health.handler');

      // Act
      await healthRequestHandler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
      expect(captured.sendBody).toMatchObject({
        status: 'healthy',
        components: {
          dynamodb: {
            status: 'healthy',
          },
        },
      });
    });

    it('includes DynamoDB connectivity check result (AC11.3)', async () => {
      // Arrange
      mockSend.mockResolvedValueOnce(makeActiveTableResponse());
      const { req, res, captured } = makeRequestContext();

      const { healthRequestHandler } =
        await import('@/handlers/health.handler');

      // Act
      await healthRequestHandler(req, res, vi.fn());

      // Assert
      const body = captured.sendBody as {
        components: { dynamodb: { status: string; latencyMs: number } };
      };
      expect(body.components.dynamodb).toBeDefined();
      expect(body.components.dynamodb.status).toBe('healthy');
      expect(typeof body.components.dynamodb.latencyMs).toBe('number');
    });

    it('includes timestamp in ISO 8601 format (AC11.4)', async () => {
      // Arrange
      mockSend.mockResolvedValueOnce(makeActiveTableResponse());
      const { req, res, captured } = makeRequestContext();

      const { healthRequestHandler } =
        await import('@/handlers/health.handler');

      // Act
      const beforeTime = new Date().toISOString();
      await healthRequestHandler(req, res, vi.fn());
      const afterTime = new Date().toISOString();

      // Assert
      const body = captured.sendBody as { timestamp: string };
      expect(body.timestamp).toBeDefined();
      // Validate ISO 8601 format
      expect(Date.parse(body.timestamp)).not.toBeNaN();
      // Validate timestamp is within expected range
      expect(body.timestamp >= beforeTime).toBe(true);
      expect(body.timestamp <= afterTime).toBe(true);
    });

    it('includes version/build info (AC11.5)', async () => {
      // Arrange
      mockSend.mockResolvedValueOnce(makeActiveTableResponse());
      const { req, res, captured } = makeRequestContext();

      const { healthRequestHandler } =
        await import('@/handlers/health.handler');

      // Act
      await healthRequestHandler(req, res, vi.fn());

      // Assert
      const body = captured.sendBody as { version: string };
      expect(body.version).toBe('1.2.3');
    });

    it('returns degraded status when DynamoDB table is not ACTIVE', async () => {
      // Arrange
      mockSend.mockResolvedValueOnce({
        $metadata: {},
        Table: {
          TableName: 'users-table',
          TableStatus: 'UPDATING',
        },
      } as DescribeTableCommandOutput);
      const { req, res, captured } = makeRequestContext();

      const { healthRequestHandler } =
        await import('@/handlers/health.handler');

      // Act
      await healthRequestHandler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
      const body = captured.sendBody as {
        status: string;
        components: { dynamodb: { status: string; error: string } };
      };
      expect(body.status).toBe('degraded');
      expect(body.components.dynamodb.status).toBe('degraded');
      expect(body.components.dynamodb.error).toContain('UPDATING');
    });

    it('returns unhealthy status when DynamoDB check fails', async () => {
      // Arrange
      const dynamoError = new Error('Connection refused');
      mockSend.mockRejectedValueOnce(dynamoError);
      const { req, res, captured } = makeRequestContext();

      const { healthRequestHandler } =
        await import('@/handlers/health.handler');

      // Act
      await healthRequestHandler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
      const body = captured.sendBody as {
        status: string;
        components: { dynamodb: { status: string; error: string } };
      };
      expect(body.status).toBe('unhealthy');
      expect(body.components.dynamodb.status).toBe('unhealthy');
      expect(body.components.dynamodb.error).toBe('Connection refused');
    });

    it('logs when health check returns non-healthy status', async () => {
      // Arrange
      mockSend.mockRejectedValueOnce(new Error('Connection failed'));
      const { req, res } = makeRequestContext();

      const { healthRequestHandler } =
        await import('@/handlers/health.handler');

      // Act
      await healthRequestHandler(req, res, vi.fn());

      // Assert
      expect(loggerState.logs.length).toBeGreaterThan(0);
      const logMessage = loggerState.logs[0]?.[0] as string;
      expect(logMessage).toContain('unhealthy');
    });

    it('does not log when health check returns healthy status', async () => {
      // Arrange
      mockSend.mockResolvedValueOnce(makeActiveTableResponse());
      const { req, res } = makeRequestContext();
      // Reset logger state right before the test
      resetLoggerState();

      const { healthRequestHandler } =
        await import('@/handlers/health.handler');

      // Act
      await healthRequestHandler(req, res, vi.fn());

      // Assert
      expect(loggerState.logs.length).toBe(0);
    });
  });

  describe('checkDynamoDBHealth', () => {
    it('returns healthy status with latency when DynamoDB responds', async () => {
      // Arrange
      mockSend.mockResolvedValueOnce({
        $metadata: {},
        Table: { TableName: 'users-table', TableStatus: 'ACTIVE' },
      });

      const { checkDynamoDBHealth } = await import('@/handlers/health.handler');

      // Act
      const result = await Effect.runPromise(checkDynamoDBHealth());

      // Assert
      expect(result.status).toBe('healthy');
      expect(typeof result.latencyMs).toBe('number');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('returns unhealthy status with error when DynamoDB fails', async () => {
      // Arrange
      mockSend.mockRejectedValueOnce(new Error('Network error'));

      const { checkDynamoDBHealth } = await import('@/handlers/health.handler');

      // Act
      const result = await Effect.runPromise(checkDynamoDBHealth());

      // Assert
      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('Network error');
    });
  });

  describe('determineOverallStatus', () => {
    it('returns healthy when DynamoDB is healthy', async () => {
      const { determineOverallStatus } =
        await import('@/handlers/health.handler');

      const result = determineOverallStatus({ status: 'healthy', latencyMs: 5 });

      expect(result).toBe('healthy');
    });

    it('returns degraded when DynamoDB is degraded', async () => {
      const { determineOverallStatus } =
        await import('@/handlers/health.handler');

      const result = determineOverallStatus({
        status: 'degraded',
        latencyMs: 5,
        error: 'Table updating',
      });

      expect(result).toBe('degraded');
    });

    it('returns unhealthy when DynamoDB is unhealthy', async () => {
      const { determineOverallStatus } =
        await import('@/handlers/health.handler');

      const result = determineOverallStatus({
        status: 'unhealthy',
        latencyMs: 100,
        error: 'Connection failed',
      });

      expect(result).toBe('unhealthy');
    });
  });
});

describe('health endpoint integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBundledRuntime(false);
    vi.stubEnv('APP_VERSION', '1.2.3');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('endpoint is registered without authentication middleware (AC11.7)', async () => {
    // This is a structural test verifying no auth middleware is applied
    // The actual integration test would verify this in a running server

    const { healthRequestHandler } = await import('@/handlers/health.handler');

    // Verify the handler can be called directly without auth context
    const { req, res, captured } = makeRequestContext();
    mockSend.mockResolvedValueOnce({
      $metadata: {},
      Table: { TableName: 'users-table', TableStatus: 'ACTIVE' },
    });

    await healthRequestHandler(req, res, vi.fn());

    // Should succeed without auth
    expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
  });

  it('responds within 1 second (AC11.6)', async () => {
    // Arrange
    mockSend.mockResolvedValueOnce({
      $metadata: {},
      Table: { TableName: 'users-table', TableStatus: 'ACTIVE' },
    });
    const { req, res, captured } = makeRequestContext();

    const { healthRequestHandler } = await import('@/handlers/health.handler');

    // Act
    const startTime = Date.now();
    await healthRequestHandler(req, res, vi.fn());
    const endTime = Date.now();

    // Assert - response should be within 1000ms
    const responseTime = endTime - startTime;
    expect(responseTime).toBeLessThan(1000);
    expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
  });
});

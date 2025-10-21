import { HTTP_RESPONSE } from '@packages/backend-core';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventBridgeServiceFake } from '@/__tests__/fakes/eventBridge';
import type * as EventBridgeServiceModule from '@/services/eventBridge.service';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const eventBridgeModule = vi.hoisted(
  (): { fake?: EventBridgeServiceFake } => ({}),
);

vi.hoisted(() => {
  Reflect.set(globalThis, '__BUNDLED__', false);
  return undefined;
});

vi.mock('@/clients/cdkOutputs', () => ({
  analyticsEventBusArn: 'analytics-bus-arn',
  analyticsEventBusName: 'analytics-bus',
  analyticsDeadLetterQueueArn: 'analytics-dlq-arn',
  analyticsDeadLetterQueueUrl: 'https://example.com/dlq',
  analyticsDedupeTableName: 'analytics-dedupe-table',
  analyticsAggregateTableName: 'analytics-aggregate-table',
  analyticsEventLogGroupName: 'analytics-event-log-group',
  analyticsProcessorLogGroupName: 'analytics-processor-log-group',
}));

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

describe('heartbeat integration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    Reflect.set(globalThis, '__BUNDLED__', false);
    process.env.APP_ENV = 'test-env';
    process.env.APP_VERSION = '1.2.3';
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, 'APP_ENV');
    Reflect.deleteProperty(process.env, 'APP_VERSION');
  });

  it('publishes analytics heartbeat event for authenticated requests', async () => {
    // Arrange
    const app = await buildHeartbeatApp();
    const eventBridgeFake = getEventBridgeFake();
    eventBridgeFake.reset();
    eventBridgeFake.queueSuccess({
      $metadata: { httpStatusCode: 200 },
      FailedEntryCount: 0,
    });

    // Act
    const response = await request(app)
      .get('/heartbeat')
      .set('X-Platform', 'ios');

    // Assert
    expect(response.status).toBe(HTTP_RESPONSE.SUCCESS);
    expect(response.text).toBe('OK');
    expect(eventBridgeFake.calls).toHaveLength(1);
    const [entry] = eventBridgeFake.calls[0]?.Entries ?? [];
    expect(entry?.EventBusName).toBe('analytics-bus');
    const parsedDetail: unknown = JSON.parse(entry?.Detail ?? '{}');
    if (!isRecord(parsedDetail)) {
      throw new Error('Heartbeat detail missing');
    }
    const detail = parsedDetail;
    expect(detail).toMatchObject({
      userId: 'user-1',
      env: 'test-env',
      appVersion: '1.2.3',
      platform: 'ios',
    });
  });

  it('returns 502 when EventBridge reports failed entries', async () => {
    // Arrange
    const app = await buildHeartbeatApp();
    const eventBridgeFake = getEventBridgeFake();
    eventBridgeFake.reset();
    eventBridgeFake.queueSuccess({
      $metadata: { httpStatusCode: 200 },
      FailedEntryCount: 1,
      Entries: [
        {
          ErrorCode: 'InternalFailure',
          ErrorMessage: 'rate exceeded',
        },
      ],
    });

    // Act
    const response = await request(app).get('/heartbeat');

    // Assert
    expect(response.status).toBe(HTTP_RESPONSE.BAD_GATEWAY);
    expect(response.text).toBe('Bad Gateway');
    expect(eventBridgeFake.calls).toHaveLength(1);
  });
});

async function buildHeartbeatApp(): Promise<Express> {
  const { heartbeatRequestHandler } = await import(
    '@/handlers/heartbeat.handler'
  );

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
  return app;
}

function getEventBridgeFake(): EventBridgeServiceFake {
  if (!eventBridgeModule.fake) {
    throw new Error('EventBridge fake was not initialized');
  }
  return eventBridgeModule.fake;
}

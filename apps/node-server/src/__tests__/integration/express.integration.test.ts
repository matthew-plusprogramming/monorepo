import { HTTP_RESPONSE } from '@packages/backend-core';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventBridgeServiceFake } from '@/__tests__/fakes/eventBridge';
import type * as EventBridgeServiceModule from '@/services/eventBridge.service';

const eventBridgeModule = vi.hoisted(() => ({
  fake: undefined as EventBridgeServiceFake | undefined,
}));

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __BUNDLED__?: boolean }).__BUNDLED__ =
    false;
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

describe('heartbeat integration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    (globalThis as typeof globalThis & { __BUNDLED__?: boolean }).__BUNDLED__ =
      false;
    process.env.APP_ENV = 'test-env';
    process.env.APP_VERSION = '1.2.3';
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, 'APP_ENV');
    Reflect.deleteProperty(process.env, 'APP_VERSION');
  });

  it('publishes analytics heartbeat event for authenticated requests', async () => {
    const app = await buildHeartbeatApp();
    const eventBridgeFake = getEventBridgeFake();
    eventBridgeFake.reset();
    eventBridgeFake.queueSuccess({
      $metadata: { httpStatusCode: 200 },
      FailedEntryCount: 0,
    });

    const response = await request(app)
      .get('/heartbeat')
      .set('X-Platform', 'ios');

    expect(response.status).toBe(HTTP_RESPONSE.SUCCESS);
    expect(response.text).toBe('OK');
    expect(eventBridgeFake.calls).toHaveLength(1);
    const [entry] = eventBridgeFake.calls[0]?.Entries ?? [];
    expect(entry?.EventBusName).toBe('analytics-bus');
    const detail = JSON.parse(entry?.Detail ?? '{}') as Record<string, unknown>;
    expect(detail).toMatchObject({
      userId: 'user-1',
      env: 'test-env',
      appVersion: '1.2.3',
      platform: 'ios',
    });
  });

  it('returns 502 when EventBridge reports failed entries', async () => {
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

    const response = await request(app).get('/heartbeat');

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
  return eventBridgeModule.fake as EventBridgeServiceFake;
}

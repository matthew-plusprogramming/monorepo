import { HTTP_RESPONSE } from '@packages/backend-core';
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  USER_ROLE,
} from '@packages/backend-core/auth';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DynamoDbServiceFake } from '@/__tests__/fakes/dynamodb';
import type { UserRepoFake } from '@/__tests__/fakes/userRepo';
import { withFixedTime } from '@/__tests__/utils/time';
import { restoreRandomUUID } from '@/__tests__/utils/uuid';
import type * as DynamoServiceModule from '@/services/dynamodb.service';
import type * as LoggerServiceModule from '@/services/logger.service';

const dynamoModule = vi.hoisted(() => ({ fake: undefined as unknown }));
const userRepoModule = vi.hoisted(() => ({ fake: undefined as unknown }));
const argonModule = vi.hoisted(() => ({ hash: undefined as unknown }));
const jwtModule = vi.hoisted(() => ({ sign: undefined as unknown }));

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __BUNDLED__?: boolean }).__BUNDLED__ =
    false;
  return undefined;
});

vi.mock('@/clients/cdkOutputs', () => ({
  rateLimitTableName: 'rate-limit-table',
  applicationLogGroupName: 'app-log-group',
  serverLogStreamName: 'app-log-stream',
  securityLogGroupName: 'security-log-group',
  securityLogStreamName: 'security-log-stream',
  denyListTableName: 'deny-list-table',
  usersTableName: 'users-table',
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
    LiveDynamoDbService: fake.layer,
  };
});

vi.mock('@/services/logger.service', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof LoggerServiceModule;
  const { createLoggerServiceFake } = await import('@/__tests__/fakes/logger');
  return {
    ...actual,
    ApplicationLoggerService: createLoggerServiceFake().layer,
    SecurityLoggerService: createLoggerServiceFake().layer,
  };
});

vi.mock('@/layers/app.layer', async () => {
  const { createUserRepoFake } = await import('@/__tests__/fakes/userRepo');
  const fake = createUserRepoFake();
  userRepoModule.fake = fake;
  return { AppLayer: fake.layer };
});

vi.mock('@node-rs/argon2', () => {
  const hash = vi.fn();
  argonModule.hash = hash;
  return { default: { hash } };
});

vi.mock('jsonwebtoken', () => {
  const sign = vi.fn();
  jwtModule.sign = sign;
  return { sign };
});

describe('node-server express integration slice', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    restoreRandomUUID();
    process.env.PEPPER = 'integration-pepper';
    process.env.JWT_SECRET = 'integration-secret';
    process.env.PORT = '3000' as unknown as number;
  });

  afterEach(() => {
    restoreRandomUUID();
    Reflect.deleteProperty(process.env, 'PEPPER');
    Reflect.deleteProperty(process.env, 'JWT_SECRET');
    Reflect.deleteProperty(process.env, 'PORT');
  });

  it('returns 200 for GET /heartbeat', async () => {
    const app = await buildApp();
    const dynamoFake = getDynamoFake();
    const userRepoFake = getUserRepoFake();

    dynamoFake.reset();
    userRepoFake.reset();

    dynamoFake.queueSuccess('updateItem', {
      $metadata: { httpStatusCode: 200 },
      Attributes: { calls: { N: '1' } },
    });

    const response = await request(app).get('/heartbeat');

    expect(response.status).toBe(HTTP_RESPONSE.SUCCESS);
    expect(response.text).toEqual('OK');
    expect(userRepoFake.calls.findByIdentifier).toEqual([]);
  });

  it('returns 201 and a signed token for POST /register', async () => {
    await withFixedTime('2024-01-01T00:00:00.000Z', async () => {
      const app = await buildApp();

      const dynamoFake = getDynamoFake();
      const userRepoFake = getUserRepoFake();
      const hashMock = getHashMock();
      const signMock = getSignMock();

      dynamoFake.reset();
      userRepoFake.reset();
      hashMock.mockResolvedValueOnce('hashed-password');
      signMock.mockImplementationOnce((payload: unknown) => {
        return JSON.stringify(payload);
      });

      dynamoFake.queueSuccess('updateItem', {
        $metadata: { httpStatusCode: 200 },
        Attributes: { calls: { N: '1' } },
      });
      userRepoFake.queueFindNone();
      userRepoFake.queueCreateSuccess();

      const response = await request(app)
        .post('/register')
        .set('X-Forwarded-For', '198.51.100.20')
        .send({
          username: 'new-user',
          email: 'new-user@example.com',
          password: 'supersecret',
        });

      expect(response.status).toBe(HTTP_RESPONSE.CREATED);
      const payload = JSON.parse(response.text) as Record<string, unknown>;
      expect(payload).toMatchObject({
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        exp: Date.parse('2024-01-01T01:00:00.000Z'),
        iat: Date.parse('2024-01-01T00:00:00.000Z'),
        role: USER_ROLE,
      });

      expect(typeof payload.sub).toBe('string');
      expect(typeof payload.jti).toBe('string');

      expect(userRepoFake.calls.create).toHaveLength(1);
      const createdUser = userRepoFake.calls.create[0];
      expect(createdUser).toBeDefined();
      const ensuredCreatedUser = createdUser!;
      expect(ensuredCreatedUser).toMatchObject({
        username: 'new-user',
        email: 'new-user@example.com',
        passwordHash: 'hashed-password',
      });
      expect(typeof ensuredCreatedUser.id).toBe('string');
      expect(payload.sub as string).toBe(ensuredCreatedUser.id);
      expect((payload.jti as string).length).toBeGreaterThan(0);
      expect(dynamoFake.calls.updateItem).toHaveLength(1);
      expect(dynamoFake.calls.updateItem[0]?.TableName).toBe(
        'rate-limit-table',
      );
      expect(hashMock).toHaveBeenCalledWith('supersecret', {
        secret: Buffer.from('integration-pepper'),
      });
      expect(signMock).toHaveBeenCalledWith(payload, 'integration-secret');
    });
  });

  it('obfuscates missing users when GET /user/:identifier returns none', async () => {
    const app = await buildApp();
    const dynamoFake = getDynamoFake();
    const userRepoFake = getUserRepoFake();

    dynamoFake.reset();
    userRepoFake.reset();

    dynamoFake.queueSuccess('updateItem', {
      $metadata: { httpStatusCode: 200 },
      Attributes: { calls: { N: '1' } },
    });
    userRepoFake.queueFindNone();

    const response = await request(app)
      .get('/user/33333333-3333-4333-8333-333333333333')
      .set('X-Forwarded-For', '203.0.113.10');

    expect(response.status).toBe(HTTP_RESPONSE.BAD_GATEWAY);
    expect(response.text).toBe('Bad Gateway');
    expect(userRepoFake.calls.findByIdentifier).toEqual([
      '33333333-3333-4333-8333-333333333333',
    ]);
  });

  it('returns 429 when rate limiting triggers before route logic', async () => {
    const app = await buildApp();
    const dynamoFake = getDynamoFake();
    const userRepoFake = getUserRepoFake();

    dynamoFake.reset();
    userRepoFake.reset();

    dynamoFake.queueSuccess('updateItem', {
      $metadata: { httpStatusCode: 200 },
      Attributes: { calls: { N: '6' } },
    });

    const response = await request(app)
      .post('/register')
      .set('X-Forwarded-For', '192.0.2.40')
      .send({
        username: 'rate-limited',
        email: 'rate-limited@example.com',
        password: 'supersecret',
      });

    expect(response.status).toBe(HTTP_RESPONSE.THROTTLED);
    expect(response.text).toBe('');
    expect(userRepoFake.calls.findByIdentifier).toEqual([]);
  });
});

async function buildApp(): Promise<Express> {
  const express = (await import('express')).default;
  const { ipRateLimitingMiddlewareRequestHandler } = await import(
    '@/middleware/ipRateLimiting.middleware'
  );
  const { jsonErrorMiddleware } = await import(
    '@/middleware/jsonError.middleware'
  );
  const { registerRequestHandler } = await import(
    '@/handlers/register.handler'
  );
  const { getUserRequestHandler } = await import('@/handlers/getUser.handler');
  const { heartbeatRequestHandler } = await import(
    '@/handlers/heartbeat.handler'
  );

  const app = express();
  app.use((req, res, next) => {
    if (!req.ip && typeof req.get === 'function') {
      const forwarded = req.get('x-forwarded-for');
      if (forwarded) {
        const [first] = forwarded.split(',');
        if (first) {
          Object.defineProperty(req, 'ip', {
            value: first.trim(),
            configurable: true,
          });
        }
      }
    }
    next();
  });
  app.use(ipRateLimitingMiddlewareRequestHandler);
  app.use(express.json());
  app.use(jsonErrorMiddleware);
  app.get('/heartbeat', heartbeatRequestHandler);
  app.post('/register', registerRequestHandler);
  app.get('/user/:identifier', getUserRequestHandler);

  return app;
}

function getDynamoFake(): DynamoDbServiceFake {
  return dynamoModule.fake as DynamoDbServiceFake;
}

function getUserRepoFake(): UserRepoFake {
  return userRepoModule.fake as UserRepoFake;
}

function getHashMock(): ReturnType<typeof vi.fn> {
  return argonModule.hash as ReturnType<typeof vi.fn>;
}

function getSignMock(): ReturnType<typeof vi.fn> {
  return jwtModule.sign as ReturnType<typeof vi.fn>;
}

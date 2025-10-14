import { HTTP_RESPONSE } from '@packages/backend-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoggerServiceFake } from '@/__tests__/fakes/logger';
import { makeRequestContext } from '@/__tests__/utils/express';
import { isAuthenticatedMiddlewareRequestHandler } from '@/middleware/isAuthenticated.middleware';
import type * as LoggerServiceModule from '@/services/logger.service';

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __BUNDLED__: boolean }).__BUNDLED__ =
    false;
  return undefined;
});

const verifyMock = vi.hoisted(() => ({
  fn: vi.fn<(token: string, secret: string | undefined) => unknown>(),
}));
const loggerModule = vi.hoisted(() => ({ fake: undefined as unknown }));

vi.mock('jsonwebtoken', () => ({
  verify: verifyMock.fn,
}));

vi.mock('@/clients/cdkOutputs', () => ({
  rateLimitTableName: 'rate-limit-table',
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

const getLoggerFake = (): LoggerServiceFake =>
  loggerModule.fake as LoggerServiceFake;
const getVerifyMock = (): typeof verifyMock.fn => verifyMock.fn;

describe('isAuthenticatedMiddlewareRequestHandler', () => {
  beforeEach(() => {
    getLoggerFake().reset();
    getVerifyMock().mockReset();
    process.env.JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, 'JWT_SECRET');
  });

  it('responds with 401 when the authorization header is missing', async () => {
    const { req, res, next, captured } = makeRequestContext();

    await expect(
      isAuthenticatedMiddlewareRequestHandler(req, res, next),
    ).rejects.toBeDefined();

    expect(captured.statusCode).toBe(HTTP_RESPONSE.UNAUTHORIZED);
    expect(next).not.toHaveBeenCalled();
    expect(getVerifyMock()).not.toHaveBeenCalled();
    expect(getLoggerFake().entries.logs).toHaveLength(0);
  });

  it('responds with 400 when the token fails JWT validation', async () => {
    const { req, res, next, captured } = makeRequestContext({
      headers: { authorization: 'Bearer not-a-jwt' },
    });

    await expect(
      isAuthenticatedMiddlewareRequestHandler(req, res, next),
    ).rejects.toBeDefined();

    expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_REQUEST);
    expect(next).not.toHaveBeenCalled();
    expect(getVerifyMock()).not.toHaveBeenCalled();
  });

  it('responds with 401 when token verification fails', async () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature';
    const { req, res, next, captured } = makeRequestContext({
      headers: { authorization: `Bearer ${token}` },
    });
    const verify = getVerifyMock();
    verify.mockImplementation(() => {
      throw new Error('invalid signature');
    });

    await expect(
      isAuthenticatedMiddlewareRequestHandler(req, res, next),
    ).rejects.toBeDefined();

    expect(verify).toHaveBeenCalledWith(token, 'test-secret');
    expect(captured.statusCode).toBe(HTTP_RESPONSE.UNAUTHORIZED);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches the user and logs on success', async () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature';
    const { req, res, next, captured } = makeRequestContext({
      headers: { authorization: `Bearer ${token}` },
    });
    const verify = getVerifyMock();
    const decodedToken = {
      iss: 'issuer',
      sub: '11111111-1111-4111-8111-111111111111',
      aud: '22222222-2222-4222-8222-222222222222',
      exp: 1234567890,
      iat: 1234567800,
      jti: '33333333-3333-4333-8333-333333333333',
      role: 'admin',
    } as const;
    verify.mockReturnValue(decodedToken);

    await expect(
      isAuthenticatedMiddlewareRequestHandler(req, res, next),
    ).resolves.toBeUndefined();

    expect(req.user).toStrictEqual(decodedToken);
    expect(verify).toHaveBeenCalledWith(token, 'test-secret');
    expect(next).toHaveBeenCalledTimes(1);
    expect(captured.statusCode).toBeUndefined();
    expect(getLoggerFake().entries.logs).toContain(
      `User: ${decodedToken.sub}, Role: ${decodedToken.role} Authenticated`,
    );
  });
});

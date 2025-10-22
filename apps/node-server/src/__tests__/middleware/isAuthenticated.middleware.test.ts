import { HTTP_RESPONSE, LoggerService } from '@packages/backend-core';
import {
  type LoggerServiceFake,
  makeRequestContext,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';
import { isAuthenticatedMiddlewareRequestHandler } from '@/middleware/isAuthenticated.middleware';

const verifyMock = vi.hoisted(() => ({
  fn: vi.fn<(token: string, secret: string | undefined) => unknown>(),
}));
const loggerModule = vi.hoisted((): { fake?: LoggerServiceFake } => ({}));

vi.mock('jsonwebtoken', () => ({
  verify: verifyMock.fn,
}));

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

const getLoggerFake = (): LoggerServiceFake => {
  if (!loggerModule.fake) {
    throw new Error('Logger fake was not initialized');
  }
  return loggerModule.fake;
};
const getVerifyMock = (): typeof verifyMock.fn => verifyMock.fn;

describe('isAuthenticatedMiddlewareRequestHandler', () => {
  beforeEach(initializeAuthContext);
  afterEach(cleanupAuthContext);

  it(
    'responds with 401 when the authorization header is missing',
    rejectsWhenHeaderMissing,
  );
  it(
    'responds with 400 when the token fails JWT validation',
    rejectsWhenTokenMalformed,
  );
  it(
    'responds with 401 when token verification fails',
    rejectsWhenVerificationFails,
  );
  it('attaches the user and logs on success', attachesUserAndLogs);
});

function initializeAuthContext(): void {
  setBundledRuntime(false);
  getLoggerFake().reset();
  getVerifyMock().mockReset();
  vi.stubEnv('JWT_SECRET', 'test-secret');
}

function cleanupAuthContext(): void {
  vi.unstubAllEnvs();
}

async function rejectsWhenHeaderMissing(): Promise<void> {
  // Arrange
  const { req, res, next, captured } = makeRequestContext();

  // Act
  const action = isAuthenticatedMiddlewareRequestHandler(req, res, next);

  // Assert
  await expect(action).rejects.toBeDefined();
  expect(captured.statusCode).toBe(HTTP_RESPONSE.UNAUTHORIZED);
  expect(next).not.toHaveBeenCalled();
  expect(getVerifyMock()).not.toHaveBeenCalled();
  expect(getLoggerFake().entries.logs).toHaveLength(0);
}

async function rejectsWhenTokenMalformed(): Promise<void> {
  // Arrange
  const { req, res, next, captured } = makeRequestContext({
    headers: { authorization: 'Bearer not-a-jwt' },
  });

  // Act
  const action = isAuthenticatedMiddlewareRequestHandler(req, res, next);

  // Assert
  await expect(action).rejects.toBeDefined();
  expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_REQUEST);
  expect(next).not.toHaveBeenCalled();
  expect(getVerifyMock()).not.toHaveBeenCalled();
}

async function rejectsWhenVerificationFails(): Promise<void> {
  // Arrange
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature';
  const { req, res, next, captured } = makeRequestContext({
    headers: { authorization: `Bearer ${token}` },
  });
  const verify = getVerifyMock();
  verify.mockImplementation(() => {
    throw new Error('invalid signature');
  });

  // Act
  const action = isAuthenticatedMiddlewareRequestHandler(req, res, next);

  // Assert
  await expect(action).rejects.toBeDefined();
  expect(verify).toHaveBeenCalledWith(token, 'test-secret');
  expect(captured.statusCode).toBe(HTTP_RESPONSE.UNAUTHORIZED);
  expect(next).not.toHaveBeenCalled();
}

async function attachesUserAndLogs(): Promise<void> {
  // Arrange
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

  // Act
  const action = isAuthenticatedMiddlewareRequestHandler(req, res, next);

  // Assert
  await expect(action).resolves.toBeUndefined();
  expect(req.user).toStrictEqual(decodedToken);
  expect(verify).toHaveBeenCalledWith(token, 'test-secret');
  expect(next).toHaveBeenCalledTimes(1);
  expect(captured.statusCode).toBeUndefined();
  expect(getLoggerFake().entries.logs).toContainEqual([
    `User: ${decodedToken.sub}, Role: ${decodedToken.role} Authenticated`,
  ]);
}

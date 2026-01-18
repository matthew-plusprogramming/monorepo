import crypto from 'node:crypto';

import { HTTP_RESPONSE, LoggerService } from '@packages/backend-core';
import {
  type LoggerServiceFake,
  makeRequestContext,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';
import {
  createSessionToken,
  dashboardSessionMiddlewareRequestHandler,
  getSessionCookieOptions,
} from '@/middleware/dashboardSession.middleware';

const loggerModule = vi.hoisted((): { fake?: LoggerServiceFake } => ({}));

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('@/services/logger.service', async () => {
  const { createLoggerServiceFake } =
    await import('@packages/backend-core/testing');
  const fake = createLoggerServiceFake();
  loggerModule.fake = fake;
  return {
    LoggerService,
    ApplicationLoggerService: fake.layer,
  };
});

const getLoggerFake = (): LoggerServiceFake => {
  if (!loggerModule.fake) {
    throw new Error('Logger fake was not initialized');
  }
  return loggerModule.fake;
};

const TEST_SESSION_SECRET = 'test-session-secret-key-12345';
const TEST_SESSION_EXPIRY_HOURS = 24;

const initializeContext = (): void => {
  setBundledRuntime(false);
  getLoggerFake().reset();
  vi.stubEnv('SESSION_SECRET', TEST_SESSION_SECRET);
  vi.stubEnv('SESSION_EXPIRY_HOURS', TEST_SESSION_EXPIRY_HOURS.toString());
  vi.stubEnv('APP_ENV', 'development');
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dashboardSessionMiddleware', () => {
  beforeEach(initializeContext);

  describe('createSessionToken', () => {
    it('creates a valid session token', () => {
      const token = createSessionToken(TEST_SESSION_SECRET);
      expect(token).toMatch(/^\d+:[a-f0-9]+$/);
    });

    it('creates tokens with current timestamp', () => {
      const before = Date.now();
      const token = createSessionToken(TEST_SESSION_SECRET);
      const after = Date.now();

      const timestamp = parseInt(token.split(':')[0]!, 10);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('getSessionCookieOptions', () => {
    it('returns httpOnly true', () => {
      const options = getSessionCookieOptions(24);
      expect(options.httpOnly).toBe(true);
    });

    it('returns secure false in development', () => {
      const options = getSessionCookieOptions(24);
      expect(options.secure).toBe(false);
    });

    it('returns secure true in production', () => {
      vi.stubEnv('APP_ENV', 'production');
      const options = getSessionCookieOptions(24);
      expect(options.secure).toBe(true);
    });

    it('returns sameSite strict', () => {
      const options = getSessionCookieOptions(24);
      expect(options.sameSite).toBe('strict');
    });

    it('calculates maxAge based on expiry hours', () => {
      const options = getSessionCookieOptions(24);
      expect(options.maxAge).toBe(24 * 60 * 60 * 1000);
    });
  });

  describe('middleware', () => {
    it('responds with 401 when session cookie is missing', async () => {
      const { req, res, next, captured } = makeRequestContext();

      const action = dashboardSessionMiddlewareRequestHandler(req, res, next);

      await expect(action).rejects.toBeDefined();
      expect(captured.statusCode).toBe(HTTP_RESPONSE.UNAUTHORIZED);
      expect(next).not.toHaveBeenCalled();
    });

    it('responds with 401 for invalid session token format', async () => {
      const { req, res, next, captured } = makeRequestContext();
      (req as unknown as { cookies: Record<string, string> }).cookies = {
        dashboard_session: 'invalid-token',
      };

      const action = dashboardSessionMiddlewareRequestHandler(req, res, next);

      await expect(action).rejects.toBeDefined();
      expect(captured.statusCode).toBe(HTTP_RESPONSE.UNAUTHORIZED);
      expect(next).not.toHaveBeenCalled();
    });

    it('responds with 401 for expired session token', async () => {
      // Create a token with an old timestamp (past expiry)
      const oldTimestamp = (Date.now() - 25 * 60 * 60 * 1000).toString(); // 25 hours ago
      const signature = crypto
        .createHmac('sha256', TEST_SESSION_SECRET)
        .update(oldTimestamp)
        .digest('hex');
      const expiredToken = `${oldTimestamp}:${signature}`;

      const { req, res, next, captured } = makeRequestContext();
      (req as unknown as { cookies: Record<string, string> }).cookies = {
        dashboard_session: expiredToken,
      };

      const action = dashboardSessionMiddlewareRequestHandler(req, res, next);

      await expect(action).rejects.toBeDefined();
      expect(captured.statusCode).toBe(HTTP_RESPONSE.UNAUTHORIZED);
      expect(next).not.toHaveBeenCalled();
    });

    it('responds with 401 for tampered session token', async () => {
      const validToken = createSessionToken(TEST_SESSION_SECRET);
      const [timestamp] = validToken.split(':');
      const tamperedToken = `${timestamp}:tampered-signature`;

      const { req, res, next, captured } = makeRequestContext();
      (req as unknown as { cookies: Record<string, string> }).cookies = {
        dashboard_session: tamperedToken,
      };

      const action = dashboardSessionMiddlewareRequestHandler(req, res, next);

      await expect(action).rejects.toBeDefined();
      expect(captured.statusCode).toBe(HTTP_RESPONSE.UNAUTHORIZED);
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next() for valid session token', async () => {
      const validToken = createSessionToken(TEST_SESSION_SECRET);

      const { req, res, next, captured } = makeRequestContext();
      (req as unknown as { cookies: Record<string, string> }).cookies = {
        dashboard_session: validToken,
      };

      await dashboardSessionMiddlewareRequestHandler(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(captured.statusCode).toBeUndefined();
    });

    it('logs authentication on success', async () => {
      const validToken = createSessionToken(TEST_SESSION_SECRET);

      const { req, res, next } = makeRequestContext();
      (req as unknown as { cookies: Record<string, string> }).cookies = {
        dashboard_session: validToken,
      };

      await dashboardSessionMiddlewareRequestHandler(req, res, next);

      expect(getLoggerFake().entries.logs).toContainEqual([
        'Dashboard session authenticated',
      ]);
    });
  });
});

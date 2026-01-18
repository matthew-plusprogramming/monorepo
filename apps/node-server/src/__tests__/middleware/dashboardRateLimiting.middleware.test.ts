import { HTTP_RESPONSE } from '@packages/backend-core';
import {
  makeRequestContext,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';
import {
  clearAllRateLimits,
  dashboardRateLimitingMiddlewareRequestHandler,
  getRateLimitStatus,
  recordLoginAttempt,
  resetRateLimit,
} from '@/middleware/dashboardRateLimiting.middleware';

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('@/services/logger.service', async () => {
  const { createLoggerServiceFake } = await import('@packages/backend-core/testing');
  const { LoggerService } = await import('@packages/backend-core');
  const fake = createLoggerServiceFake();
  return {
    LoggerService,
    SecurityLoggerService: fake.layer,
  };
});

const initializeContext = (): void => {
  setBundledRuntime(false);
  clearAllRateLimits();
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dashboardRateLimitingMiddleware', () => {
  beforeEach(initializeContext);

  describe('recordLoginAttempt', () => {
    it('allows first attempt', () => {
      const result = recordLoginAttempt('192.168.1.1');
      expect(result.allowed).toBe(true);
      expect(result.lockedUntil).toBeNull();
    });

    it('allows up to 5 attempts within a minute', () => {
      const ip = '192.168.1.2';
      for (let i = 0; i < 5; i++) {
        const result = recordLoginAttempt(ip);
        expect(result.allowed).toBe(true);
      }
    });

    it('blocks 6th attempt and returns lockout time', () => {
      const ip = '192.168.1.3';
      // Make 5 allowed attempts
      for (let i = 0; i < 5; i++) {
        recordLoginAttempt(ip);
      }
      // 6th attempt should be blocked
      const result = recordLoginAttempt(ip);
      expect(result.allowed).toBe(false);
      expect(result.lockedUntil).not.toBeNull();
      expect(result.lockedUntil).toBeGreaterThan(Date.now());
    });

    it('continues blocking during lockout period', () => {
      const ip = '192.168.1.4';
      // Trigger lockout
      for (let i = 0; i < 6; i++) {
        recordLoginAttempt(ip);
      }
      // Additional attempts should still be blocked
      const result = recordLoginAttempt(ip);
      expect(result.allowed).toBe(false);
    });
  });

  describe('getRateLimitStatus', () => {
    it('returns unlocked status for new IP', () => {
      const status = getRateLimitStatus('192.168.1.10');
      expect(status.isLocked).toBe(false);
      expect(status.remainingAttempts).toBe(5);
      expect(status.lockoutEndsAt).toBeNull();
    });

    it('returns decremented attempts after login attempt', () => {
      const ip = '192.168.1.11';
      recordLoginAttempt(ip);
      const status = getRateLimitStatus(ip);
      expect(status.isLocked).toBe(false);
      expect(status.remainingAttempts).toBe(4);
    });

    it('returns locked status after exceeding attempts', () => {
      const ip = '192.168.1.12';
      for (let i = 0; i < 6; i++) {
        recordLoginAttempt(ip);
      }
      const status = getRateLimitStatus(ip);
      expect(status.isLocked).toBe(true);
      expect(status.remainingAttempts).toBe(0);
      expect(status.lockoutEndsAt).not.toBeNull();
    });
  });

  describe('resetRateLimit', () => {
    it('clears rate limit for an IP', () => {
      const ip = '192.168.1.20';
      // Create some attempts
      for (let i = 0; i < 3; i++) {
        recordLoginAttempt(ip);
      }
      expect(getRateLimitStatus(ip).remainingAttempts).toBe(2);

      // Reset
      resetRateLimit(ip);
      expect(getRateLimitStatus(ip).remainingAttempts).toBe(5);
    });
  });

  describe('middleware integration', () => {
    it('calls next() when not rate limited', async () => {
      const { req, res, next } = makeRequestContext({
        ip: '192.168.1.30',
      });

      await dashboardRateLimitingMiddlewareRequestHandler(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('returns 429 when rate limited', async () => {
      const ip = '192.168.1.31';
      // Trigger lockout
      for (let i = 0; i < 6; i++) {
        recordLoginAttempt(ip);
      }

      const { req, res, next, captured } = makeRequestContext({
        ip,
      });

      await expect(
        dashboardRateLimitingMiddlewareRequestHandler(req, res, next),
      ).rejects.toBeDefined();

      expect(captured.statusCode).toBe(HTTP_RESPONSE.THROTTLED);
      expect(next).not.toHaveBeenCalled();
    });
  });
});

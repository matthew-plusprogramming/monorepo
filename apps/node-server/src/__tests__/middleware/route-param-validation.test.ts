/**
 * AS-004: Route Parameter Validation Middleware
 *
 * Tests verify that:
 * - Valid IDs (alphanumeric, underscores, colons, hyphens, up to 128 chars) pass through
 * - Invalid IDs (special chars, path traversal, too long) return 400
 * - Regex pattern: /^[a-zA-Z0-9_:-]{1,128}$/
 */
import {
  makeRequestContext,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

const initializeContext = (): void => {
  vi.resetModules();
  setBundledRuntime(false);
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AS-004: Route Parameter Validation Middleware', () => {
  beforeEach(initializeContext);

  describe('Valid IDs pass through (AC4.1)', () => {
    const validIds = [
      'simple-id',
      'abc123',
      'with_underscore',
      'with-hyphen',
      'with:colon',
      'MixedCase123',
      'a', // Single character
      'a'.repeat(128), // Max length
      'uuid-like:550e8400-e29b-41d4-a716-446655440000',
      'spec-group_v2:draft',
    ];

    for (const validId of validIds) {
      it(`should allow valid ID "${validId.length > 40 ? validId.slice(0, 40) + '...' : validId}" to pass through`, async () => {
        // Arrange
        const { validateRouteParam } =
          await import('@/middleware/validateRouteParam.middleware');
        const middleware = validateRouteParam('id');
        const { req, res, next, captured } = makeRequestContext({
          method: 'GET',
          url: `/api/spec-groups/${validId}`,
          params: { id: validId },
        });

        // Act
        middleware(req, res, next);

        // Assert
        expect(next).toHaveBeenCalledTimes(1);
        expect(captured.statusCode).toBeUndefined();
      });
    }
  });

  describe('Invalid IDs return 400 (AC4.1)', () => {
    const invalidIds = [
      { id: '../../../etc/passwd', reason: 'path traversal' },
      { id: 'id with spaces', reason: 'spaces' },
      { id: 'id/slash', reason: 'forward slash' },
      { id: 'id\\backslash', reason: 'backslash' },
      { id: '<script>alert(1)</script>', reason: 'HTML injection' },
      { id: "'; DROP TABLE users; --", reason: 'SQL injection' },
      { id: 'id.with.dots', reason: 'dots' },
      { id: 'id@domain', reason: 'at sign' },
      { id: 'id#fragment', reason: 'hash' },
      { id: 'id?query=1', reason: 'question mark' },
      { id: 'id%00null', reason: 'percent encoding' },
      { id: '', reason: 'empty string' },
      { id: 'a'.repeat(129), reason: 'exceeds 128 characters' },
      { id: '\x00\x01\x02', reason: 'control characters' },
    ];

    for (const { id, reason } of invalidIds) {
      it(`should reject invalid ID with ${reason}`, async () => {
        // Arrange
        const { validateRouteParam } =
          await import('@/middleware/validateRouteParam.middleware');
        const middleware = validateRouteParam('id');
        const { req, res, next, captured } = makeRequestContext({
          method: 'GET',
          url: `/api/spec-groups/${id}`,
          params: { id },
        });

        // Act
        middleware(req, res, next);

        // Assert
        expect(captured.statusCode).toBe(400);
        expect(next).not.toHaveBeenCalled();
      });
    }
  });

  describe('Middleware accepts configurable param name (AC4.2)', () => {
    it('should validate the "identifier" parameter for user routes', async () => {
      // Arrange
      const { validateRouteParam } =
        await import('@/middleware/validateRouteParam.middleware');
      const middleware = validateRouteParam('identifier');
      const { req, res, next, captured } = makeRequestContext({
        method: 'GET',
        url: '/user/../admin',
        params: { identifier: '../admin' },
      });

      // Act
      middleware(req, res, next);

      // Assert
      expect(captured.statusCode).toBe(400);
      expect(next).not.toHaveBeenCalled();
    });

    it('should pass valid "identifier" parameter', async () => {
      // Arrange
      const { validateRouteParam } =
        await import('@/middleware/validateRouteParam.middleware');
      const middleware = validateRouteParam('identifier');
      const { req, res, next, captured } = makeRequestContext({
        method: 'GET',
        url: '/user/john-doe_123',
        params: { identifier: 'john-doe_123' },
      });

      // Act
      middleware(req, res, next);

      // Assert
      expect(next).toHaveBeenCalledTimes(1);
      expect(captured.statusCode).toBeUndefined();
    });
  });

  describe('Custom regex override (AC4.2)', () => {
    it('should accept custom regex pattern', async () => {
      // Arrange
      const { validateRouteParam } =
        await import('@/middleware/validateRouteParam.middleware');
      // Only digits allowed
      const middleware = validateRouteParam('id', /^[0-9]{1,10}$/);
      const {
        req: reqValid,
        res: resValid,
        next: nextValid,
      } = makeRequestContext({
        params: { id: '12345' },
      });
      const {
        req: reqInvalid,
        res: resInvalid,
        next: nextInvalid,
        captured: capturedInvalid,
      } = makeRequestContext({
        params: { id: 'abc' },
      });

      // Act
      middleware(reqValid, resValid, nextValid);
      middleware(reqInvalid, resInvalid, nextInvalid);

      // Assert
      expect(nextValid).toHaveBeenCalledTimes(1);
      expect(capturedInvalid.statusCode).toBe(400);
      expect(nextInvalid).not.toHaveBeenCalled();
    });
  });

  describe('Error response format (AC4.1)', () => {
    it('should return a JSON error response with 400 status', async () => {
      // Arrange
      const { validateRouteParam } =
        await import('@/middleware/validateRouteParam.middleware');
      const middleware = validateRouteParam('id');
      const { req, res, next, captured } = makeRequestContext({
        params: { id: '../traversal' },
      });

      // Act
      middleware(req, res, next);

      // Assert
      expect(captured.statusCode).toBe(400);
      const body = captured.jsonBody ?? captured.sendBody;
      expect(body).toBeDefined();
      if (typeof body === 'object' && body !== null) {
        expect((body as Record<string, unknown>)['error']).toBeDefined();
      }
    });
  });
});

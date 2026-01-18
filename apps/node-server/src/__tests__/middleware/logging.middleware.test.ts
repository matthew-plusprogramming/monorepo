import { makeRequestContext } from '@packages/backend-core/testing';
import type { Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createLoggingMiddleware,
  formatLogEntry,
  type LogOutput,
  redactSensitiveFields,
  REQUEST_ID_HEADER,
  type RequestLogEntry,
} from '@/middleware/logging.middleware';

// Helper to add missing Express Response methods to the mock
const addResponseMocks = (res: Response): void => {
  res.setHeader = vi.fn().mockReturnValue(res);

  // Wrap status to also set res.statusCode (not just captured.statusCode)
  const originalStatus = res.status.bind(res);
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return originalStatus(code);
  }) as typeof res.status;

  // Store original end if exists, otherwise create a simple mock
  const originalEnd = res.end;
  res.end = vi.fn(function (this: Response, ...args: unknown[]) {
    if (typeof originalEnd === 'function') {
      return originalEnd.apply(this, args as Parameters<typeof res.end>);
    }
    return this;
  }) as typeof res.end;
};

describe('logging.middleware', () => {
  describe('redactSensitiveFields', () => {
    it('redacts password fields', () => {
      const input = { username: 'john', password: 'secret123' };
      const result = redactSensitiveFields(input);

      expect(result).toStrictEqual({
        username: 'john',
        password: '[REDACTED]',
      });
    });

    it('redacts token fields', () => {
      const input = { userId: '123', token: 'abc.def.ghi' };
      const result = redactSensitiveFields(input);

      expect(result).toStrictEqual({
        userId: '123',
        token: '[REDACTED]',
      });
    });

    it('redacts authorization header', () => {
      const input = { authorization: 'Bearer xyz', accept: 'application/json' };
      const result = redactSensitiveFields(input);

      expect(result).toStrictEqual({
        authorization: '[REDACTED]',
        accept: 'application/json',
      });
    });

    it('redacts nested sensitive fields', () => {
      const input = {
        user: {
          name: 'John',
          auth: {
            password: 'secret',
            token: 'abc123',
          },
        },
      };
      const result = redactSensitiveFields(input);

      expect(result).toStrictEqual({
        user: {
          name: 'John',
          auth: {
            password: '[REDACTED]',
            token: '[REDACTED]',
          },
        },
      });
    });

    it('handles arrays with objects containing sensitive fields', () => {
      const input = {
        users: [
          { name: 'John', password: 'pass1' },
          { name: 'Jane', password: 'pass2' },
        ],
      };
      const result = redactSensitiveFields(input);

      expect(result).toStrictEqual({
        users: [
          { name: 'John', password: '[REDACTED]' },
          { name: 'Jane', password: '[REDACTED]' },
        ],
      });
    });

    it('preserves arrays with primitive values', () => {
      const input = { tags: ['a', 'b', 'c'], count: 3 };
      const result = redactSensitiveFields(input);

      expect(result).toStrictEqual({
        tags: ['a', 'b', 'c'],
        count: 3,
      });
    });

    it('handles case-insensitive field matching', () => {
      const input = {
        PASSWORD: 'secret1',
        Token: 'secret2',
        API_KEY: 'secret3',
      };
      const result = redactSensitiveFields(input);

      expect(result).toStrictEqual({
        PASSWORD: '[REDACTED]',
        Token: '[REDACTED]',
        API_KEY: '[REDACTED]',
      });
    });

    it('redacts various sensitive field patterns', () => {
      const input = {
        apikey: 'key1',
        api_key: 'key2',
        'api-key': 'key3',
        accesstoken: 'token1',
        access_token: 'token2',
        refreshtoken: 'token3',
        refresh_token: 'token4',
        secret: 'mysecret',
        cookie: 'session=abc',
        ssn: '123-45-6789',
        creditcard: '4111111111111111',
        credit_card: '4111111111111111',
      };
      const result = redactSensitiveFields(input);

      for (const key of Object.keys(input)) {
        expect(result[key]).toBe('[REDACTED]');
      }
    });
  });

  describe('formatLogEntry', () => {
    it('produces valid JSON output', () => {
      const entry: RequestLogEntry = {
        timestamp: '2026-01-17T12:00:00.000Z',
        level: 'info',
        requestId: 'test-uuid',
        method: 'GET',
        path: '/api/users',
        statusCode: 200,
        durationMs: 42,
      };

      const result = formatLogEntry(entry);
      const parsed = JSON.parse(result);

      expect(parsed).toStrictEqual(entry);
    });

    it('includes optional fields when present', () => {
      const entry: RequestLogEntry = {
        timestamp: '2026-01-17T12:00:00.000Z',
        level: 'error',
        requestId: 'test-uuid',
        method: 'POST',
        path: '/api/login',
        statusCode: 500,
        durationMs: 100,
        userAgent: 'Mozilla/5.0',
        ip: '192.168.1.1',
        error: {
          message: 'Database connection failed',
          stack: 'Error: Database connection failed\n    at ...',
        },
      };

      const result = formatLogEntry(entry);
      const parsed = JSON.parse(result);

      expect(parsed.userAgent).toBe('Mozilla/5.0');
      expect(parsed.ip).toBe('192.168.1.1');
      expect(parsed.error.message).toBe('Database connection failed');
      expect(parsed.error.stack).toContain('Database connection failed');
    });

    it('produces single-line output', () => {
      const entry: RequestLogEntry = {
        timestamp: '2026-01-17T12:00:00.000Z',
        level: 'info',
        requestId: 'test-uuid',
        method: 'GET',
        path: '/api/test',
        statusCode: 200,
        durationMs: 10,
      };

      const result = formatLogEntry(entry);

      expect(result).not.toContain('\n');
    });
  });

  describe('createLoggingMiddleware', () => {
    let logOutput: ReturnType<typeof vi.fn<LogOutput>>;
    let loggedMessages: string[];

    beforeEach(() => {
      loggedMessages = [];
      logOutput = vi.fn((msg: string) => {
        loggedMessages.push(msg);
      });
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-17T12:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('logs request on completion with all required fields (AC12.1, AC12.2, AC12.3)', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext({
        method: 'GET',
        url: '/api/users',
      });
      addResponseMocks(res);

      // Act
      middleware(req, res, next);
      expect(next).toHaveBeenCalled();

      // Simulate response completion
      res.status(200);
      res.end();

      // Assert
      expect(logOutput).toHaveBeenCalledTimes(1);
      const loggedJson = JSON.parse(loggedMessages[0]!);

      // AC12.2: timestamp, method, path, status code
      expect(loggedJson.timestamp).toBe('2026-01-17T12:00:00.000Z');
      expect(loggedJson.method).toBe('GET');
      expect(loggedJson.path).toBe('/api/users');
      expect(loggedJson.statusCode).toBe(200);

      // AC12.3: duration and request ID
      expect(typeof loggedJson.durationMs).toBe('number');
      expect(loggedJson.durationMs).toBeGreaterThanOrEqual(0);
      expect(loggedJson.requestId).toBeDefined();
      expect(typeof loggedJson.requestId).toBe('string');
    });

    it('produces valid JSON output (AC12.4)', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext({
        method: 'POST',
        url: '/api/login',
      });
      addResponseMocks(res);

      // Act
      middleware(req, res, next);
      res.status(201);
      res.end();

      // Assert
      expect(() => {
        JSON.parse(loggedMessages[0]!);
      }).not.toThrow();
    });

    it('writes to provided output function (AC12.5 - stdout via custom output)', () => {
      // Arrange
      const customMessages: string[] = [];
      const customOutput = vi.fn((msg: string) => customMessages.push(msg));
      const middleware = createLoggingMiddleware(customOutput);
      const { req, res, next } = makeRequestContext();
      addResponseMocks(res);

      // Act
      middleware(req, res, next);
      res.status(200);
      res.end();

      // Assert
      expect(customOutput).toHaveBeenCalledTimes(1);
      expect(typeof customMessages[0]).toBe('string');
    });

    it('generates a new request ID when not provided', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext();
      addResponseMocks(res);

      // Act
      middleware(req, res, next);
      res.status(200);
      res.end();

      // Assert
      const loggedJson = JSON.parse(loggedMessages[0]!);
      expect(loggedJson.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('uses existing request ID from header when provided', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const existingId = 'existing-request-id-123';
      const { req, res, next } = makeRequestContext({
        headers: { [REQUEST_ID_HEADER]: existingId },
      });
      addResponseMocks(res);

      // Act
      middleware(req, res, next);
      res.status(200);
      res.end();

      // Assert
      const loggedJson = JSON.parse(loggedMessages[0]!);
      expect(loggedJson.requestId).toBe(existingId);
    });

    it('sets request ID in response header', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext();
      addResponseMocks(res);
      const setHeaderSpy = res.setHeader as ReturnType<typeof vi.fn>;

      // Act
      middleware(req, res, next);

      // Assert
      expect(setHeaderSpy).toHaveBeenCalledWith(
        REQUEST_ID_HEADER,
        expect.any(String),
      );
    });

    it('logs error level for 4xx status codes', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext();
      addResponseMocks(res);

      // Act
      middleware(req, res, next);
      res.status(404);
      res.end();

      // Assert
      const loggedJson = JSON.parse(loggedMessages[0]!);
      expect(loggedJson.level).toBe('error');
    });

    it('logs error level for 5xx status codes', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext();
      addResponseMocks(res);

      // Act
      middleware(req, res, next);
      res.status(500);
      res.end();

      // Assert
      const loggedJson = JSON.parse(loggedMessages[0]!);
      expect(loggedJson.level).toBe('error');
    });

    it('logs info level for 2xx status codes', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext();
      addResponseMocks(res);

      // Act
      middleware(req, res, next);
      res.status(201);
      res.end();

      // Assert
      const loggedJson = JSON.parse(loggedMessages[0]!);
      expect(loggedJson.level).toBe('info');
    });

    it('logs info level for 3xx status codes', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext();
      addResponseMocks(res);

      // Act
      middleware(req, res, next);
      res.status(302);
      res.end();

      // Assert
      const loggedJson = JSON.parse(loggedMessages[0]!);
      expect(loggedJson.level).toBe('info');
    });

    it('includes user agent when present', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext({
        headers: { 'user-agent': 'TestAgent/1.0' },
      });
      addResponseMocks(res);

      // Act
      middleware(req, res, next);
      res.status(200);
      res.end();

      // Assert
      const loggedJson = JSON.parse(loggedMessages[0]!);
      expect(loggedJson.userAgent).toBe('TestAgent/1.0');
    });

    it('includes IP address when present', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext({
        ip: '10.0.0.1',
      });
      addResponseMocks(res);

      // Act
      middleware(req, res, next);
      res.status(200);
      res.end();

      // Assert
      const loggedJson = JSON.parse(loggedMessages[0]!);
      expect(loggedJson.ip).toBe('10.0.0.1');
    });

    it('measures duration correctly', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext();
      addResponseMocks(res);

      // Act
      middleware(req, res, next);

      // Advance time by 150ms
      vi.advanceTimersByTime(150);

      res.status(200);
      res.end();

      // Assert
      const loggedJson = JSON.parse(loggedMessages[0]!);
      expect(loggedJson.durationMs).toBe(150);
    });

    it('calls next() to continue middleware chain', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext();
      addResponseMocks(res);

      // Act
      middleware(req, res, next);

      // Assert
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('preserves original res.end behavior', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext();
      addResponseMocks(res);

      // Act
      middleware(req, res, next);
      const result = res.end('test body');

      // Assert - end should return the response object
      expect(result).toBe(res);
    });
  });

  describe('PII protection (AC12.6)', () => {
    let logOutput: ReturnType<typeof vi.fn<LogOutput>>;
    let loggedMessages: string[];

    beforeEach(() => {
      loggedMessages = [];
      logOutput = vi.fn((msg: string) => {
        loggedMessages.push(msg);
      });
    });

    it('does not include authorization header value in logs', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext({
        headers: { authorization: 'Bearer secret-token-123' },
      });
      addResponseMocks(res);

      // Act
      middleware(req, res, next);
      res.status(200);
      res.end();

      // Assert
      const loggedString = loggedMessages[0]!;
      expect(loggedString).not.toContain('secret-token-123');
      expect(loggedString).not.toContain('Bearer');
    });

    it('does not include cookie values in logs', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext({
        headers: { cookie: 'session=sensitive-session-id' },
      });
      addResponseMocks(res);

      // Act
      middleware(req, res, next);
      res.status(200);
      res.end();

      // Assert
      const loggedString = loggedMessages[0]!;
      expect(loggedString).not.toContain('sensitive-session-id');
    });

    it('does not log request body with passwords', () => {
      // The middleware intentionally does not log request bodies
      // to prevent accidental PII exposure
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext({
        body: { username: 'john', password: 'secret123' },
      });
      addResponseMocks(res);

      // Act
      middleware(req, res, next);
      res.status(200);
      res.end();

      // Assert
      const loggedString = loggedMessages[0]!;
      expect(loggedString).not.toContain('secret123');
      expect(loggedString).not.toContain('password');
    });
  });

  describe('Error handling (AC12.7)', () => {
    let logOutput: ReturnType<typeof vi.fn<LogOutput>>;
    let loggedMessages: string[];

    beforeEach(() => {
      loggedMessages = [];
      logOutput = vi.fn((msg: string) => {
        loggedMessages.push(msg);
      });
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('includes error message in separate field when error is attached', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext();
      addResponseMocks(res);

      // Act
      middleware(req, res, next);

      // Attach error to response (as error middleware would do)
      const error = new Error('Something went wrong');
      (res as unknown as { _loggingError: Error })._loggingError = error;

      res.status(500);
      res.end();

      // Assert
      const loggedJson = JSON.parse(loggedMessages[0]!);
      expect(loggedJson.error).toBeDefined();
      expect(loggedJson.error.message).toBe('Something went wrong');
    });

    it('includes stack trace in error field', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext();
      addResponseMocks(res);

      // Act
      middleware(req, res, next);

      // Attach error with stack trace
      const error = new Error('Database error');
      (res as unknown as { _loggingError: Error })._loggingError = error;

      res.status(500);
      res.end();

      // Assert
      const loggedJson = JSON.parse(loggedMessages[0]!);
      expect(loggedJson.error.stack).toBeDefined();
      expect(loggedJson.error.stack).toContain('Database error');
      expect(loggedJson.error.stack).toContain('at ');
    });

    it('keeps error in separate field from main log entry', () => {
      // Arrange
      const middleware = createLoggingMiddleware(logOutput);
      const { req, res, next } = makeRequestContext();
      addResponseMocks(res);

      // Act
      middleware(req, res, next);
      const error = new Error('Test error');
      (res as unknown as { _loggingError: Error })._loggingError = error;
      res.status(500);
      res.end();

      // Assert
      const loggedJson = JSON.parse(loggedMessages[0]!);

      // Main fields still present
      expect(loggedJson.timestamp).toBeDefined();
      expect(loggedJson.method).toBeDefined();
      expect(loggedJson.path).toBeDefined();
      expect(loggedJson.statusCode).toBe(500);
      expect(loggedJson.requestId).toBeDefined();
      expect(loggedJson.durationMs).toBeDefined();

      // Error in separate nested field
      expect(loggedJson.error).toBeTypeOf('object');
      expect(loggedJson.error.message).toBeDefined();
      expect(loggedJson.error.stack).toBeDefined();
    });
  });
});

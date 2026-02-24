import { randomUUID } from 'crypto';

import type { ErrorRequestHandler, RequestHandler } from 'express';

import { SENSITIVE_KEYS } from '@packages/backend-core';

/**
 * The header name for request IDs. If a request comes with this header,
 * the existing ID will be used; otherwise a new UUID is generated.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Structured log entry format for API requests.
 */
export type RequestLogEntry = {
  timestamp: string;
  level: 'info' | 'error';
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  userAgent?: string;
  ip?: string;
  error?: {
    message: string;
    stack?: string;
  };
};

/**
 * Redacts sensitive values from an object recursively.
 * Returns a new object with sensitive fields replaced with '[REDACTED]'.
 */
export const redactSensitiveFields = (
  obj: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();

    if (SENSITIVE_KEYS.has(lowerKey)) {
      result[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactSensitiveFields(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === 'object' && item !== null
          ? redactSensitiveFields(item as Record<string, unknown>)
          : item,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
};

/**
 * Formats a log entry as a single-line JSON string.
 * This format is suitable for log aggregators like CloudWatch, Datadog, etc.
 */
export const formatLogEntry = (entry: RequestLogEntry): string => {
  return JSON.stringify(entry);
};

/**
 * Default output function that writes to stdout.
 * Can be overridden for testing.
 */
export type LogOutput = (message: string) => void;

const defaultLogOutput: LogOutput = (message: string): void => {
  process.stdout.write(message + '\n');
};

/**
 * Creates a logging middleware that captures request details and logs
 * them on response completion.
 *
 * Features:
 * - Generates/propagates request IDs
 * - Measures request duration
 * - Logs structured JSON to stdout
 * - Redacts sensitive fields from headers
 * - Captures error stack traces in separate field
 */
export const createLoggingMiddleware = (
  output: LogOutput = defaultLogOutput,
): RequestHandler => {
  return (req, res, next): void => {
    const startTime = Date.now();

    // Generate or use existing request ID
    const requestId =
      (req.headers[REQUEST_ID_HEADER] as string | undefined) ?? randomUUID();

    // Attach request ID to response headers for tracing
    res.setHeader(REQUEST_ID_HEADER, requestId);

    // Store request ID on request object for downstream use
    (req as unknown as { requestId: string }).requestId = requestId;

    // Capture the original end method
    const originalEnd = res.end.bind(res);

    // Override end to log on completion
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.end = function (this: typeof res, ...args: any[]): typeof res {
      const durationMs = Date.now() - startTime;

      const logEntry: RequestLogEntry = {
        timestamp: new Date().toISOString(),
        level: res.statusCode >= 400 ? 'error' : 'info',
        requestId,
        method: req.method,
        path: req.path || req.url,
        statusCode: res.statusCode,
        durationMs,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      };

      // If there's an error attached to the response, include it
      const error = (res as unknown as { _loggingError?: Error })._loggingError;
      if (error) {
        logEntry.error = {
          message: error.message,
          stack: error.stack,
        };
      }

      output(formatLogEntry(logEntry));

      return originalEnd(...args);
    };

    next();
  };
};

/**
 * Error-aware logging middleware that captures error details.
 * Use this after route handlers to capture error stack traces.
 * This should be placed after all route handlers but before the final error handler.
 */
export const loggingErrorMiddleware: ErrorRequestHandler = (
  err,
  _req,
  res,
  next,
): void => {
  // Attach error to response for the logging middleware to capture
  (res as unknown as { _loggingError: Error })._loggingError = err;
  next(err);
};

/**
 * Default logging middleware instance with stdout output.
 */
export const loggingMiddleware = createLoggingMiddleware();

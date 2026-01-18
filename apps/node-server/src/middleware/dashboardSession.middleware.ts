import crypto from 'node:crypto';

import {
  type handlerInput,
  HTTP_RESPONSE,
  UserNotAuthenticatedError,
} from '@packages/backend-core';
import { Effect } from 'effect';
import type { RequestHandler } from 'express';

import {
  ApplicationLoggerService,
  LoggerService,
} from '@/services/logger.service';

const SESSION_COOKIE_NAME = 'dashboard_session';

/**
 * Validates the dashboard session token.
 * Returns true if the session is valid and not expired.
 */
const validateSessionToken = (
  token: string,
  sessionSecret: string,
  sessionExpiryHours: number,
): boolean => {
  try {
    // Token format: timestamp:signature
    const [timestampStr, signature] = token.split(':');
    if (!timestampStr || !signature) {
      return false;
    }

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
      return false;
    }

    // Check if session has expired
    const expiryMs = sessionExpiryHours * 60 * 60 * 1000;
    const now = Date.now();
    if (now - timestamp > expiryMs) {
      return false;
    }

    // Verify signature using constant-time comparison
    const expectedSignature = crypto
      .createHmac('sha256', sessionSecret)
      .update(timestampStr)
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    if (signature.length !== expectedSignature.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    );
  } catch {
    return false;
  }
};

/**
 * Creates a new session token with the current timestamp.
 */
export const createSessionToken = (sessionSecret: string): string => {
  const timestamp = Date.now().toString();
  const signature = crypto
    .createHmac('sha256', sessionSecret)
    .update(timestamp)
    .digest('hex');
  return `${timestamp}:${signature}`;
};

/**
 * Gets the session cookie options for setting/clearing the cookie.
 */
export const getSessionCookieOptions = (
  sessionExpiryHours: number,
): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  maxAge: number;
  path: string;
} => ({
  httpOnly: true,
  secure: process.env.APP_ENV !== 'development',
  sameSite: 'strict',
  maxAge: sessionExpiryHours * 60 * 60 * 1000,
  path: '/',
});

export { SESSION_COOKIE_NAME };

const dashboardSessionMiddlewareHandler = (
  input: handlerInput,
): Effect.Effect<void, UserNotAuthenticatedError> =>
  Effect.gen(function* () {
    const logger = yield* LoggerService;
    const req = yield* input;

    const sessionToken = req.cookies?.[SESSION_COOKIE_NAME];

    if (!sessionToken) {
      return yield* new UserNotAuthenticatedError({
        message: 'No session cookie found',
        cause: undefined,
      });
    }

    const sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret) {
      yield* logger.log('SESSION_SECRET environment variable not configured');
      return yield* new UserNotAuthenticatedError({
        message: 'Server configuration error',
        cause: undefined,
      });
    }

    const sessionExpiryHours = process.env.SESSION_EXPIRY_HOURS ?? 24;

    if (!validateSessionToken(sessionToken, sessionSecret, sessionExpiryHours)) {
      return yield* new UserNotAuthenticatedError({
        message: 'Invalid or expired session',
        cause: undefined,
      });
    }

    yield* logger.log('Dashboard session authenticated');
  }).pipe(Effect.provide(ApplicationLoggerService));

export const dashboardSessionMiddlewareRequestHandler: RequestHandler = async (
  req,
  res,
  next,
) => {
  await Effect.succeed(req)
    .pipe(dashboardSessionMiddlewareHandler)
    .pipe(
      Effect.catchTag('UserNotAuthenticatedError', () =>
        Effect.fail(res.status(HTTP_RESPONSE.UNAUTHORIZED).send()),
      ),
    )
    .pipe(
      Effect.tap(() => {
        next();
      }),
    )
    .pipe(Effect.runPromise);
};

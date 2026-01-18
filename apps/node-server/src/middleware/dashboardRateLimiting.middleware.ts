import {
  type handlerInput,
  HTTP_RESPONSE,
  RateLimitExceededError,
} from '@packages/backend-core';
import { Effect } from 'effect';
import type { RequestHandler } from 'express';

import {
  LoggerService,
  SecurityLoggerService,
} from '@/services/logger.service';

// Rate limiting configuration for dashboard login (AS-009)
const MAX_ATTEMPTS_PER_MINUTE = 5;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// In-memory rate limiting storage
// In production, this could be moved to Redis for distributed deployments
type RateLimitEntry = {
  attempts: number;
  windowStart: number;
  lockedUntil: number | null;
};

const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * Cleans up expired entries from the rate limit store.
 * Called periodically to prevent memory leaks.
 */
const cleanupExpiredEntries = (): void => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore.entries()) {
    // Remove entries that are past their lockout and window
    const windowExpiry = entry.windowStart + 60 * 1000;
    const lockoutExpiry = entry.lockedUntil ?? 0;
    if (now > windowExpiry && now > lockoutExpiry) {
      rateLimitStore.delete(ip);
    }
  }
};

// Clean up every 5 minutes
setInterval(cleanupExpiredEntries, 5 * 60 * 1000);

/**
 * Gets the current rate limit status for an IP.
 */
export const getRateLimitStatus = (
  ip: string,
): {
  isLocked: boolean;
  remainingAttempts: number;
  lockoutEndsAt: number | null;
} => {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry) {
    return {
      isLocked: false,
      remainingAttempts: MAX_ATTEMPTS_PER_MINUTE,
      lockoutEndsAt: null,
    };
  }

  // Check if locked out
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return {
      isLocked: true,
      remainingAttempts: 0,
      lockoutEndsAt: entry.lockedUntil,
    };
  }

  // Check if we're in a new window
  const windowExpiry = entry.windowStart + 60 * 1000;
  if (now > windowExpiry) {
    return {
      isLocked: false,
      remainingAttempts: MAX_ATTEMPTS_PER_MINUTE,
      lockoutEndsAt: null,
    };
  }

  return {
    isLocked: false,
    remainingAttempts: Math.max(0, MAX_ATTEMPTS_PER_MINUTE - entry.attempts),
    lockoutEndsAt: null,
  };
};

/**
 * Records a login attempt for rate limiting.
 * Returns true if the attempt is allowed, false if rate limited.
 */
export const recordLoginAttempt = (
  ip: string,
): { allowed: boolean; lockedUntil: number | null } => {
  const now = Date.now();
  let entry = rateLimitStore.get(ip);

  // Check if currently locked out
  if (entry?.lockedUntil && now < entry.lockedUntil) {
    return { allowed: false, lockedUntil: entry.lockedUntil };
  }

  // Start new window or reset after lockout
  if (!entry || now > entry.windowStart + 60 * 1000 || entry.lockedUntil) {
    entry = {
      attempts: 1,
      windowStart: now,
      lockedUntil: null,
    };
    rateLimitStore.set(ip, entry);
    return { allowed: true, lockedUntil: null };
  }

  // Increment attempts
  entry.attempts += 1;

  // Check if exceeded limit
  if (entry.attempts > MAX_ATTEMPTS_PER_MINUTE) {
    entry.lockedUntil = now + LOCKOUT_DURATION_MS;
    return { allowed: false, lockedUntil: entry.lockedUntil };
  }

  return { allowed: true, lockedUntil: null };
};

/**
 * Resets the rate limit for an IP (used on successful login).
 */
export const resetRateLimit = (ip: string): void => {
  rateLimitStore.delete(ip);
};

/**
 * Clears all rate limit entries (used for testing).
 */
export const clearAllRateLimits = (): void => {
  rateLimitStore.clear();
};

const dashboardRateLimitingMiddlewareHandler = (
  input: handlerInput,
): Effect.Effect<void, RateLimitExceededError> =>
  Effect.gen(function* () {
    const loggerService = yield* LoggerService;
    const req = yield* input;

    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    const { allowed, lockedUntil } = recordLoginAttempt(ip);

    if (!allowed) {
      const lockoutRemaining = lockedUntil
        ? Math.ceil((lockedUntil - Date.now()) / 1000)
        : 0;
      yield* loggerService.log(
        `[DASHBOARD_RATE_LIMIT] ${ip} - Locked out for ${lockoutRemaining}s`,
      );
      return yield* Effect.fail(
        new RateLimitExceededError({
          message: `Too many login attempts. Try again in ${Math.ceil(lockoutRemaining / 60)} minutes.`,
          cause: undefined,
        }),
      );
    }
  }).pipe(Effect.provide(SecurityLoggerService));

export const dashboardRateLimitingMiddlewareRequestHandler: RequestHandler =
  async (req, res, next) => {
    await Effect.succeed(req)
      .pipe(dashboardRateLimitingMiddlewareHandler)
      .pipe(
        Effect.catchTag('RateLimitExceededError', (error) =>
          Effect.fail(
            res.status(HTTP_RESPONSE.THROTTLED).json({ error: error.message }),
          ),
        ),
      )
      .pipe(
        Effect.tap(() => {
          next();
        }),
      )
      .pipe(Effect.runPromise);
  };

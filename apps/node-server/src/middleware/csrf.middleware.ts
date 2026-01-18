/**
 * CSRF Protection Middleware
 *
 * Implements double-submit cookie pattern for CSRF protection.
 * - Sets a CSRF token in a cookie on GET requests
 * - Validates the token from header matches cookie on state-changing requests
 */

import crypto from 'node:crypto';

import type { RequestHandler } from 'express';

const CSRF_COOKIE_NAME = 'csrf_token';
const CSRF_HEADER_NAME = 'x-csrf-token';

/**
 * Generates a cryptographically secure CSRF token.
 */
const generateCsrfToken = (): string => {
  return crypto.randomBytes(32).toString('hex');
};

/**
 * Middleware to set CSRF token cookie on GET requests.
 */
export const csrfTokenMiddleware: RequestHandler = (req, res, next) => {
  // Only set token on GET requests (or if no token exists)
  if (req.method === 'GET' || !req.cookies?.[CSRF_COOKIE_NAME]) {
    const token = generateCsrfToken();
    res.cookie(CSRF_COOKIE_NAME, token, {
      httpOnly: false, // Must be readable by JavaScript
      secure: process.env.APP_ENV !== 'development',
      sameSite: 'strict',
      path: '/',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });
  }
  next();
};

/**
 * Middleware to validate CSRF token on state-changing requests.
 * Checks that the token in the X-CSRF-Token header matches the cookie.
 */
export const csrfValidationMiddleware: RequestHandler = (req, res, next) => {
  // Skip validation for safe methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME];

  if (!cookieToken) {
    res.status(403).json({ error: 'CSRF token missing from cookie' });
    return;
  }

  if (!headerToken || typeof headerToken !== 'string') {
    res.status(403).json({ error: 'CSRF token missing from header' });
    return;
  }

  // Constant-time comparison
  if (cookieToken.length !== headerToken.length) {
    res.status(403).json({ error: 'CSRF token mismatch' });
    return;
  }

  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(cookieToken),
      Buffer.from(headerToken),
    );

    if (!valid) {
      res.status(403).json({ error: 'CSRF token mismatch' });
      return;
    }
  } catch {
    res.status(403).json({ error: 'CSRF validation failed' });
    return;
  }

  next();
};

export { CSRF_COOKIE_NAME, CSRF_HEADER_NAME };

/**
 * Route Parameter Validation Middleware (AS-004)
 *
 * Validates route parameters against a regex pattern before they reach handler logic.
 * Provides defense-in-depth even where handler-level Zod validation exists.
 */

import type { RequestHandler } from 'express';

// AC4.1: Default regex for safe route parameter values
const SAFE_ID_REGEX = /^[a-zA-Z0-9_:-]{1,128}$/;

/**
 * Creates middleware that validates a route parameter against a regex pattern.
 *
 * AC4.2: Shared middleware with configurable regex (defaults to SAFE_ID_REGEX).
 * Returns 400 with structured error on invalid params.
 *
 * @param paramName - The route parameter name to validate (e.g., 'id', 'identifier')
 * @param regex - Optional custom regex pattern (defaults to alphanumeric + _:- , max 128 chars)
 */
export const validateRouteParam = (
  paramName: string,
  regex: RegExp = SAFE_ID_REGEX,
): RequestHandler => {
  return (req, res, next) => {
    const value = req.params[paramName];
    if (!value || !regex.test(value)) {
      res.status(400).json({
        error: `Invalid ${paramName} parameter`,
      });
      return;
    }
    next();
  };
};

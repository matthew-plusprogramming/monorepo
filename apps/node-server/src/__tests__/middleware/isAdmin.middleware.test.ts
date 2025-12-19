import { HTTP_RESPONSE } from '@packages/backend-core';
import { ADMIN_ROLE, USER_ROLE } from '@packages/backend-core/auth';
import { makeRequestContext } from '@packages/backend-core/testing';
import { describe, expect, it } from 'vitest';

import { buildUserTokenPayload } from '@/__tests__/builders/user';
import { isAdminMiddlewareRequestHandler } from '@/middleware/isAdmin.middleware';

const rejectsWhenUserMissing = async (): Promise<void> => {
  // Arrange
  const { req, res, next, captured } = makeRequestContext();

  // Act
  const action = isAdminMiddlewareRequestHandler(req, res, next);

  // Assert
  await expect(action).rejects.toBeDefined();
  expect(captured.statusCode).toBe(HTTP_RESPONSE.UNAUTHORIZED);
  expect(next).not.toHaveBeenCalled();
};

const rejectsWhenRoleNotAdmin = async (): Promise<void> => {
  // Arrange
  const { req, res, next, captured } = makeRequestContext();
  req.user = buildUserTokenPayload({ role: USER_ROLE });

  // Act
  const action = isAdminMiddlewareRequestHandler(req, res, next);

  // Assert
  await expect(action).rejects.toBeDefined();
  expect(captured.statusCode).toBe(HTTP_RESPONSE.FORBIDDEN);
  expect(next).not.toHaveBeenCalled();
};

const allowsWhenRoleAdmin = async (): Promise<void> => {
  // Arrange
  const { req, res, next, captured } = makeRequestContext();
  req.user = buildUserTokenPayload({ role: ADMIN_ROLE });

  // Act
  const action = isAdminMiddlewareRequestHandler(req, res, next);

  // Assert
  await expect(action).resolves.toBeUndefined();
  expect(next).toHaveBeenCalledTimes(1);
  expect(captured.statusCode).toBeUndefined();
};

describe('isAdminMiddlewareRequestHandler', () => {
  it(
    'responds with 401 when the authenticated user context is missing',
    rejectsWhenUserMissing,
  );
  it(
    'responds with 403 when the authenticated user is not an admin',
    rejectsWhenRoleNotAdmin,
  );
  it(
    'allows the request when the authenticated user is an admin',
    allowsWhenRoleAdmin,
  );
});

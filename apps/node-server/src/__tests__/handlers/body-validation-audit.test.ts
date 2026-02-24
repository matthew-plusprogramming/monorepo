/**
 * AS-006: Zod Body Validation Audit on POST Endpoints
 *
 * Tests verify that:
 * - POST handlers validate request body via parseInput or safeParse
 * - Invalid body returns 400 with structured error
 * - Valid body proceeds to handler logic
 */
import { HTTP_RESPONSE } from '@packages/backend-core';
import {
  makeRequestContext,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import type { RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserRepoFake } from '@/__tests__/fakes/userRepo';
import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';

const userRepoModule = vi.hoisted((): { fake?: UserRepoFake } => ({}));

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('bcryptjs', () => {
  const compare = vi.fn<(password: string, hash: string) => Promise<boolean>>();
  return {
    default: { compare },
    compare,
  };
});

vi.mock('@/layers/app.layer', async () => {
  const { Layer } = await import('effect');
  const {
    createDynamoDbServiceFake,
    createEventBridgeServiceFake,
    createLoggerServiceFake,
  } = await import('@packages/backend-core/testing');
  const { createUserRepoFake } = await import('@/__tests__/fakes/userRepo');

  const dynamoFake = createDynamoDbServiceFake();
  const eventBridgeFake = createEventBridgeServiceFake();
  const loggerFake = createLoggerServiceFake();
  const userRepoFake = createUserRepoFake();
  userRepoModule.fake = userRepoFake;

  const AppLayer = Layer.mergeAll(
    dynamoFake.layer,
    loggerFake.layer,
    eventBridgeFake.layer,
    userRepoFake.layer,
  );

  return { AppLayer };
});

vi.mock('@/services/logger.service', async () => {
  const { createLoggerServiceFake } =
    await import('@packages/backend-core/testing');
  const { LoggerService } = await import('@packages/backend-core');
  const fake = createLoggerServiceFake();
  return {
    LoggerService,
    ApplicationLoggerService: fake.layer,
    SecurityLoggerService: fake.layer,
  };
});

const initializeContext = (): void => {
  vi.resetModules();
  setBundledRuntime(false);
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AS-006: Zod Body Validation Audit', () => {
  beforeEach(initializeContext);

  describe('Login endpoint body validation (AC6.1, AC6.2, AC6.3)', () => {
    it('should return 400 for missing required fields (AC6.3)', async () => {
      // Arrange
      const module = await import('@/handlers/login.handler');
      const handler: RequestHandler = module.loginRequestHandler;
      vi.stubEnv('PEPPER', 'test-pepper');
      vi.stubEnv('JWT_SECRET', 'test-jwt-secret');
      const { req, res, captured } = makeRequestContext({
        method: 'POST',
        url: '/login',
        body: {}, // Missing identifier and password
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_REQUEST);
    });

    it('should return 400 for invalid types in body (AC6.3)', async () => {
      // Arrange
      const module = await import('@/handlers/login.handler');
      const handler: RequestHandler = module.loginRequestHandler;
      vi.stubEnv('PEPPER', 'test-pepper');
      vi.stubEnv('JWT_SECRET', 'test-jwt-secret');
      const { req, res, captured } = makeRequestContext({
        method: 'POST',
        url: '/login',
        body: { identifier: 12345, password: true }, // Wrong types
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_REQUEST);
    });

    it('should return structured error messages without internal details (AC6.3)', async () => {
      // Arrange
      const module = await import('@/handlers/login.handler');
      const handler: RequestHandler = module.loginRequestHandler;
      vi.stubEnv('PEPPER', 'test-pepper');
      vi.stubEnv('JWT_SECRET', 'test-jwt-secret');
      const { req, res, captured } = makeRequestContext({
        method: 'POST',
        url: '/login',
        body: {},
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_REQUEST);
      const body = captured.sendBody ?? captured.jsonBody;
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      // Should NOT contain internal details like stack traces or file paths
      expect(bodyStr).not.toMatch(/at\s+\S+\s+\(/); // No stack traces
      expect(bodyStr).not.toContain('.ts:');
      expect(bodyStr).not.toContain('node_modules');
    });
  });

  describe('Register endpoint body validation (AC6.1, AC6.2)', () => {
    it('should return 400 for missing required fields', async () => {
      // Arrange
      const module = await import('@/handlers/register.handler');
      const handler: RequestHandler = module.registerRequestHandler;
      vi.stubEnv('PEPPER', 'test-pepper');
      vi.stubEnv('JWT_SECRET', 'test-jwt-secret');
      const { req, res, captured } = makeRequestContext({
        method: 'POST',
        url: '/register',
        body: {}, // Missing username, email, password
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_REQUEST);
    });

    it('should return 400 for invalid email format', async () => {
      // Arrange
      const module = await import('@/handlers/register.handler');
      const handler: RequestHandler = module.registerRequestHandler;
      vi.stubEnv('PEPPER', 'test-pepper');
      vi.stubEnv('JWT_SECRET', 'test-jwt-secret');
      const { req, res, captured } = makeRequestContext({
        method: 'POST',
        url: '/register',
        body: {
          username: 'testuser',
          email: 'not-an-email',
          password: 'SecurePassword123!',
        },
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_REQUEST);
    });
  });

  describe('Spec groups transition endpoint body validation (AC6.1, AC6.2)', () => {
    it('should return 400 for invalid transition body', async () => {
      // Arrange
      const module = await import('@/handlers/specGroups.handler');
      const handler: RequestHandler = module.transitionStateRequestHandler;
      const { req, res, captured } = makeRequestContext({
        method: 'POST',
        url: '/api/spec-groups/sg-123/transition',
        params: { id: 'sg-123' },
        body: {}, // Missing required transition fields
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_REQUEST);
    });
  });

  describe('Cross-cutting validation behavior (AC6.3)', () => {
    it('should not expose internal file paths or stack traces in 400 responses', async () => {
      // Arrange
      const module = await import('@/handlers/login.handler');
      const handler: RequestHandler = module.loginRequestHandler;
      vi.stubEnv('PEPPER', 'test-pepper');
      vi.stubEnv('JWT_SECRET', 'test-jwt-secret');
      const { req, res, captured } = makeRequestContext({
        method: 'POST',
        url: '/login',
        body: { identifier: null, password: null },
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_REQUEST);
      const body = captured.sendBody ?? captured.jsonBody;
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      expect(bodyStr).not.toContain('src/');
      expect(bodyStr).not.toContain('dist/');
      expect(bodyStr).not.toContain('Error:');
    });
  });
});

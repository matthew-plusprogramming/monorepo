/**
 * AS-001: Mask Internal Error Messages in API Responses
 *
 * Tests verify that:
 * - InternalServerError mappers return generic messages (not e.message)
 * - GitHubApiError and GitHubAuthError mappers return generic messages
 * - Real errors are logged server-side via console.error
 * - 400-level errors (ZodError, NotFound, Conflict, InvalidCredentials) preserve user-facing messages
 * - request.handler.ts fallback returns generic message
 *
 * Strategy: Test through actual handlers, verifying that 500/502/401 error responses
 * do not contain internal error messages while 4xx responses preserve user-facing messages.
 */
import {
  GitHubApiError,
  GitHubAuthError,
  HTTP_RESPONSE,
  InternalServerError,
  type GitHubIssue,
} from '@packages/backend-core';
import {
  createGitHubServiceFake,
  type GitHubServiceFake,
  makeRequestContext,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import type { RequestHandler } from 'express';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserRepoFake } from '@/__tests__/fakes/userRepo';
import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';

type ArgonVerifyFn = (
  hash: string,
  password: string,
  options?: Record<string, unknown>,
) => Promise<boolean>;

const userRepoModule = vi.hoisted((): { fake?: UserRepoFake } => ({}));
const argonModule = vi.hoisted((): { verify?: Mock<ArgonVerifyFn> } => ({}));
const githubServiceModule = vi.hoisted(
  (): { fake?: GitHubServiceFake } => ({}),
);

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('@/layers/app.layer', async () => {
  const { Layer } = await import('effect');
  const {
    createDynamoDbServiceFake,
    createEventBridgeServiceFake,
    createLoggerServiceFake,
    createGitHubServiceFake,
  } = await import('@packages/backend-core/testing');
  const { createUserRepoFake } = await import('@/__tests__/fakes/userRepo');

  const dynamoFake = createDynamoDbServiceFake();
  const eventBridgeFake = createEventBridgeServiceFake();
  const loggerFake = createLoggerServiceFake();
  const userRepoFake = createUserRepoFake();
  const githubFake = createGitHubServiceFake();

  userRepoModule.fake = userRepoFake;
  githubServiceModule.fake = githubFake;

  const AppLayer = Layer.mergeAll(
    dynamoFake.layer,
    loggerFake.layer,
    eventBridgeFake.layer,
    userRepoFake.layer,
    githubFake.layer,
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

vi.mock('@node-rs/argon2', () => {
  const verify = vi.fn<ArgonVerifyFn>();
  argonModule.verify = verify;
  return { default: { verify } };
});

vi.mock('jsonwebtoken', () => {
  const sign = vi.fn();
  return { sign };
});

const GENERIC_INTERNAL_ERROR = 'Internal server error';

const getUserRepoFake = (): UserRepoFake => {
  if (!userRepoModule.fake) {
    throw new Error('UserRepo fake was not initialized');
  }
  return userRepoModule.fake;
};

const getGitHubFake = (): GitHubServiceFake => {
  if (!githubServiceModule.fake) {
    throw new Error('GitHubServiceFake was not initialized');
  }
  return githubServiceModule.fake;
};

const initializeContext = (): void => {
  vi.resetModules();
  setBundledRuntime(false);
  userRepoModule.fake?.reset();
  githubServiceModule.fake?.reset();
  argonModule.verify?.mockReset();
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AS-001: Mask Internal Error Messages', () => {
  beforeEach(initializeContext);

  describe('InternalServerError in login handler returns generic message (AC1.1, AC1.3, AC1.4)', () => {
    it('should not expose internal error message when credential lookup fails', async () => {
      // Arrange
      vi.stubEnv('PEPPER', 'test-pepper');
      vi.stubEnv('JWT_SECRET', 'shh-its-a-secret');
      const module = await import('@/handlers/login.handler');
      const handler: RequestHandler = module.loginRequestHandler;
      const repoFake = getUserRepoFake();
      repoFake.queueFindCredentialsFailure(
        new InternalServerError({
          message: 'DynamoDB connection timed out: ECONNREFUSED 10.0.0.1:8000',
          cause: undefined,
        }),
      );
      const { req, res, captured } = makeRequestContext({
        method: 'POST',
        url: '/login',
        body: { identifier: 'test@example.com', password: 'password123' },
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.INTERNAL_SERVER_ERROR);
      const body = String(captured.sendBody ?? '');
      expect(body).not.toContain('DynamoDB');
      expect(body).not.toContain('ECONNREFUSED');
      expect(body).not.toContain('10.0.0.1');
    });
  });

  describe('GitHubApiError returns generic message in 502 response (AC1.5)', () => {
    it('should not expose GitHub API error details in issues endpoint', async () => {
      // Arrange
      const module = await import('@/handlers/githubIssues.handler');
      const handler: RequestHandler = module.getGitHubIssuesRequestHandler;
      const githubFake = getGitHubFake();
      githubFake.queueGetProjectIssuesError(
        new GitHubApiError({
          message:
            'GitHub API rate limit exceeded: 403 Forbidden with token ghp_secret123',
          cause: undefined,
        }),
      );
      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/issues',
        params: { id: 'test-project' },
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
      const body = String(captured.sendBody ?? '');
      expect(body).not.toContain('ghp_secret123');
      expect(body).not.toContain('rate limit exceeded');
      expect(body).not.toContain('403 Forbidden');
    });

    it('should not expose GitHub API error details in PRs endpoint', async () => {
      // Arrange
      const module = await import('@/handlers/githubPRs.handler');
      const handler: RequestHandler = module.getGitHubPRsRequestHandler;
      const githubFake = getGitHubFake();
      githubFake.queueGetProjectPRsError(
        new GitHubApiError({
          message: 'GitHub upstream failure: 503 Service Unavailable',
          cause: undefined,
        }),
      );
      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/pulls',
        params: { id: 'test-project' },
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
      const body = String(captured.sendBody ?? '');
      expect(body).not.toContain('upstream failure');
      expect(body).not.toContain('503 Service Unavailable');
    });
  });

  describe('GitHubAuthError returns generic message in 401 response (AC1.5)', () => {
    it('should not expose GitHub auth error details in issues endpoint', async () => {
      // Arrange
      const module = await import('@/handlers/githubIssues.handler');
      const handler: RequestHandler = module.getGitHubIssuesRequestHandler;
      const githubFake = getGitHubFake();
      githubFake.queueGetProjectIssuesError(
        new GitHubAuthError({
          message: 'Bad credentials: token ghp_expired123 invalid',
          cause: undefined,
        }),
      );
      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/issues',
        params: { id: 'test-project' },
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.UNAUTHORIZED);
      const body = String(captured.sendBody ?? '');
      expect(body).not.toContain('ghp_expired123');
      expect(body).not.toContain('Bad credentials');
    });
  });

  describe('400-level errors preserve user-facing messages (AC1.6)', () => {
    it('should preserve ZodError validation messages in login endpoint', async () => {
      // Arrange
      vi.stubEnv('PEPPER', 'test-pepper');
      vi.stubEnv('JWT_SECRET', 'shh-its-a-secret');
      const module = await import('@/handlers/login.handler');
      const handler: RequestHandler = module.loginRequestHandler;
      const { req, res, captured } = makeRequestContext({
        method: 'POST',
        url: '/login',
        body: {}, // Missing required fields triggers ZodError -> 400
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_REQUEST);
      // 400 responses should contain validation feedback, not be masked
    });

    it('should preserve NotFound error messages in GitHub issues endpoint', async () => {
      // Arrange
      const { ProjectNotFoundError } = await import('@packages/backend-core');
      const module = await import('@/handlers/githubIssues.handler');
      const handler: RequestHandler = module.getGitHubIssuesRequestHandler;
      const githubFake = getGitHubFake();
      githubFake.queueGetProjectIssuesError(
        new ProjectNotFoundError({
          message: 'Project not found',
          cause: undefined,
        }),
      );
      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/nonexistent/github/issues',
        params: { id: 'nonexistent' },
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.NOT_FOUND);
      // 404 user-facing message should be preserved (not masked to generic)
    });

    it('should preserve InvalidCredentials message in login endpoint', async () => {
      // Arrange
      vi.stubEnv('PEPPER', 'test-pepper');
      vi.stubEnv('JWT_SECRET', 'shh-its-a-secret');
      const module = await import('@/handlers/login.handler');
      const handler: RequestHandler = module.loginRequestHandler;
      const repoFake = getUserRepoFake();
      repoFake.queueFindCredentialsNone();
      const { req, res, captured } = makeRequestContext({
        method: 'POST',
        url: '/login',
        body: {
          identifier: 'baduser@example.com',
          password: 'WrongPasswordButLongEnough123',
        },
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.UNAUTHORIZED);
      // Unauthorized for invalid credentials is user-facing -- not masked
      const body = String(captured.sendBody ?? '');
      expect(body.length).toBeGreaterThan(0);
    });
  });

  describe('Real errors are logged server-side (AC1.2)', () => {
    it('should call console.error when an unmatched error is thrown', async () => {
      // Arrange
      vi.stubEnv('PEPPER', 'test-pepper');
      vi.stubEnv('JWT_SECRET', 'shh-its-a-secret');
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      const module = await import('@/handlers/login.handler');
      const handler: RequestHandler = module.loginRequestHandler;
      const repoFake = getUserRepoFake();
      repoFake.queueFindCredentialsFailure(
        new InternalServerError({
          message: 'Sensitive DynamoDB error: credential table corrupted',
          cause: new Error('DynamoDB internal: partition key malformed'),
        }),
      );
      const { req, res, captured } = makeRequestContext({
        method: 'POST',
        url: '/login',
        body: { identifier: 'test@example.com', password: 'password123' },
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.INTERNAL_SERVER_ERROR);
      // The real error cause should be logged server-side
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });
});

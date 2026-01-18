/**
 * GitHub Issues Handler Tests
 *
 * Tests for GitHub issues API endpoint.
 * Covers AC4.1-AC4.6 for GitHub Issues Integration (AS-004).
 */

import {
  GitHubApiError,
  GitHubAuthError,
  HTTP_RESPONSE,
  NoLinkedRepoError,
  ProjectNotFoundError,
  type GitHubIssue,
} from '@packages/backend-core';
import {
  createGitHubServiceFake,
  createMockGitHubIssue,
  makeRequestContext,
  setBundledRuntime,
  type GitHubServiceFake,
} from '@packages/backend-core/testing';
import type { RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';

const githubServiceModule = vi.hoisted(
  (): { fake?: GitHubServiceFake } => ({}),
);

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('@/layers/app.layer', async () => {
  const { createGitHubServiceFake } = await import(
    '@packages/backend-core/testing'
  );
  const fake = createGitHubServiceFake();
  githubServiceModule.fake = fake;
  return { AppLayer: fake.layer };
});

const getServiceFake = (): GitHubServiceFake => {
  if (!githubServiceModule.fake) {
    throw new Error('GitHubServiceFake was not initialized');
  }
  return githubServiceModule.fake;
};

const importHandler = async (): Promise<RequestHandler> => {
  const module = await import('@/handlers/githubIssues.handler');
  return module.getGitHubIssuesRequestHandler;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getGitHubIssuesRequestHandler', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
  });

  describe('AC4.1: GitHub panel shows Issues section with linked issues', () => {
    it('returns issues for a valid project with linked repo', async () => {
      // Arrange
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      const mockIssues: readonly GitHubIssue[] = [
        createMockGitHubIssue({
          id: 1,
          number: 1,
          title: 'First Issue',
          status: 'open',
          htmlUrl: 'https://github.com/test/repo/issues/1',
        }),
        createMockGitHubIssue({
          id: 2,
          number: 2,
          title: 'Second Issue',
          status: 'closed',
          htmlUrl: 'https://github.com/test/repo/issues/2',
        }),
      ];

      serviceFake.queueGetProjectIssuesSuccess({
        issues: mockIssues,
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/issues',
        params: { id: 'test-project' },
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
      const body = captured.sendBody as {
        issues: readonly GitHubIssue[];
        repoFullName: string;
      };
      expect(body.issues).toHaveLength(2);
      expect(body.repoFullName).toBe('test/repo');
    });
  });

  describe('AC4.2: Each issue displays title, number, and status badge', () => {
    it('returns issue with title, number, and status', async () => {
      // Arrange
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      const mockIssue = createMockGitHubIssue({
        id: 42,
        number: 42,
        title: 'Bug: Something is broken',
        status: 'open',
      });

      serviceFake.queueGetProjectIssuesSuccess({
        issues: [mockIssue],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/issues',
        params: { id: 'test-project' },
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
      const body = captured.sendBody as {
        issues: readonly GitHubIssue[];
      };
      expect(body.issues[0]?.title).toBe('Bug: Something is broken');
      expect(body.issues[0]?.number).toBe(42);
      expect(body.issues[0]?.status).toBe('open');
    });
  });

  describe('AC4.3: Issue status badges (Open green, Closed gray, In Progress blue)', () => {
    it('returns open status for open issues', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectIssuesSuccess({
        issues: [createMockGitHubIssue({ status: 'open' })],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/issues',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      const body = captured.sendBody as { issues: readonly GitHubIssue[] };
      expect(body.issues[0]?.status).toBe('open');
    });

    it('returns closed status for closed issues', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectIssuesSuccess({
        issues: [createMockGitHubIssue({ status: 'closed' })],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/issues',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      const body = captured.sendBody as { issues: readonly GitHubIssue[] };
      expect(body.issues[0]?.status).toBe('closed');
    });

    it('returns in_progress status for issues with in-progress label', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectIssuesSuccess({
        issues: [createMockGitHubIssue({ status: 'in_progress' })],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/issues',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      const body = captured.sendBody as { issues: readonly GitHubIssue[] };
      expect(body.issues[0]?.status).toBe('in_progress');
    });
  });

  describe('AC4.4: Clicking issue opens GitHub in new tab', () => {
    it('returns htmlUrl for each issue', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      const expectedUrl = 'https://github.com/owner/repo/issues/123';
      serviceFake.queueGetProjectIssuesSuccess({
        issues: [createMockGitHubIssue({ htmlUrl: expectedUrl })],
        repoFullName: 'owner/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/issues',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      const body = captured.sendBody as { issues: readonly GitHubIssue[] };
      expect(body.issues[0]?.htmlUrl).toBe(expectedUrl);
    });
  });

  describe('AC4.5: Empty state shown when no linked issues', () => {
    it('returns empty array when no issues exist', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectIssuesSuccess({
        issues: [],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/issues',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
      const body = captured.sendBody as { issues: readonly GitHubIssue[] };
      expect(body.issues).toEqual([]);
    });
  });

  describe('AC4.6: Loading state while fetching issues', () => {
    // Note: Loading state is handled by the frontend.
    // This test verifies the API responds correctly for the frontend to handle.
    it('returns 200 OK response for successful fetch', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectIssuesSuccess({
        issues: [],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/issues',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
    });
  });

  describe('Error handling', () => {
    it('returns 404 when project not found', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectIssuesError(
        new ProjectNotFoundError({
          message: 'Project not found',
          cause: undefined,
        }),
      );

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/non-existent/github/issues',
        params: { id: 'non-existent' },
      });

      await handler(req, res, vi.fn());

      expect(captured.statusCode).toBe(HTTP_RESPONSE.NOT_FOUND);
    });

    it('returns 400 when project has no linked repo', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectIssuesError(
        new NoLinkedRepoError({
          message: 'Project has no linked repository',
          cause: undefined,
        }),
      );

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/no-repo/github/issues',
        params: { id: 'no-repo' },
      });

      await handler(req, res, vi.fn());

      expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_REQUEST);
    });

    it('returns 502 when GitHub API fails', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectIssuesError(
        new GitHubApiError({
          message: 'GitHub API error',
          cause: undefined,
        }),
      );

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/issues',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
    });

    it('returns 401 when GitHub token is missing', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectIssuesError(
        new GitHubAuthError({
          message: 'GitHub token not configured',
          cause: undefined,
        }),
      );

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/issues',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      expect(captured.statusCode).toBe(HTTP_RESPONSE.UNAUTHORIZED);
    });
  });
});

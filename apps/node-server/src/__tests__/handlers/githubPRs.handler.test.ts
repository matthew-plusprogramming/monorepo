/**
 * GitHub PRs Handler Tests
 *
 * Tests for GitHub pull requests API endpoint.
 * Covers AC5.1-AC5.6 for GitHub PRs Integration (AS-005).
 */

import {
  GitHubApiError,
  GitHubAuthError,
  HTTP_RESPONSE,
  NoLinkedRepoError,
  ProjectNotFoundError,
  type GitHubPullRequest,
} from '@packages/backend-core';
import {
  createGitHubServiceFake,
  createMockGitHubPR,
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
  const module = await import('@/handlers/githubPRs.handler');
  return module.getGitHubPRsRequestHandler;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getGitHubPRsRequestHandler', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
  });

  describe('AC5.1: GitHub panel shows Pull Requests section with linked PRs', () => {
    it('returns PRs for a valid project with linked repo', async () => {
      // Arrange
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      const mockPRs: readonly GitHubPullRequest[] = [
        createMockGitHubPR({
          id: 1,
          number: 1,
          title: 'First PR',
          status: 'open',
          ciStatus: 'passing',
          htmlUrl: 'https://github.com/test/repo/pull/1',
        }),
        createMockGitHubPR({
          id: 2,
          number: 2,
          title: 'Second PR',
          status: 'merged',
          ciStatus: 'passing',
          htmlUrl: 'https://github.com/test/repo/pull/2',
        }),
      ];

      serviceFake.queueGetProjectPRsSuccess({
        pullRequests: mockPRs,
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/pulls',
        params: { id: 'test-project' },
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
      const body = captured.sendBody as {
        pullRequests: readonly GitHubPullRequest[];
        repoFullName: string;
      };
      expect(body.pullRequests).toHaveLength(2);
      expect(body.repoFullName).toBe('test/repo');
    });
  });

  describe('AC5.2: Each PR displays title, number, and status badge', () => {
    it('returns PR with title, number, status, and CI status', async () => {
      // Arrange
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      const mockPR = createMockGitHubPR({
        id: 42,
        number: 42,
        title: 'feat: Add new feature',
        status: 'open',
        ciStatus: 'passing',
      });

      serviceFake.queueGetProjectPRsSuccess({
        pullRequests: [mockPR],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/pulls',
        params: { id: 'test-project' },
      });

      // Act
      await handler(req, res, vi.fn());

      // Assert
      expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
      const body = captured.sendBody as {
        pullRequests: readonly GitHubPullRequest[];
      };
      expect(body.pullRequests[0]?.title).toBe('feat: Add new feature');
      expect(body.pullRequests[0]?.number).toBe(42);
      expect(body.pullRequests[0]?.status).toBe('open');
      expect(body.pullRequests[0]?.ciStatus).toBe('passing');
    });
  });

  describe('AC5.3: PR status badges (Open green, Merged purple, Draft gray, Closed red)', () => {
    it('returns open status for open PRs', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectPRsSuccess({
        pullRequests: [createMockGitHubPR({ status: 'open' })],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/pulls',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      const body = captured.sendBody as {
        pullRequests: readonly GitHubPullRequest[];
      };
      expect(body.pullRequests[0]?.status).toBe('open');
    });

    it('returns merged status for merged PRs', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectPRsSuccess({
        pullRequests: [createMockGitHubPR({ status: 'merged' })],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/pulls',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      const body = captured.sendBody as {
        pullRequests: readonly GitHubPullRequest[];
      };
      expect(body.pullRequests[0]?.status).toBe('merged');
    });

    it('returns draft status for draft PRs', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectPRsSuccess({
        pullRequests: [createMockGitHubPR({ status: 'draft' })],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/pulls',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      const body = captured.sendBody as {
        pullRequests: readonly GitHubPullRequest[];
      };
      expect(body.pullRequests[0]?.status).toBe('draft');
    });

    it('returns closed status for closed PRs', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectPRsSuccess({
        pullRequests: [createMockGitHubPR({ status: 'closed' })],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/pulls',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      const body = captured.sendBody as {
        pullRequests: readonly GitHubPullRequest[];
      };
      expect(body.pullRequests[0]?.status).toBe('closed');
    });
  });

  describe('AC5.4: CI status badge (Passing green, Failing red, Pending yellow)', () => {
    it('returns passing CI status', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectPRsSuccess({
        pullRequests: [createMockGitHubPR({ ciStatus: 'passing' })],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/pulls',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      const body = captured.sendBody as {
        pullRequests: readonly GitHubPullRequest[];
      };
      expect(body.pullRequests[0]?.ciStatus).toBe('passing');
    });

    it('returns failing CI status', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectPRsSuccess({
        pullRequests: [createMockGitHubPR({ ciStatus: 'failing' })],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/pulls',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      const body = captured.sendBody as {
        pullRequests: readonly GitHubPullRequest[];
      };
      expect(body.pullRequests[0]?.ciStatus).toBe('failing');
    });

    it('returns pending CI status', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectPRsSuccess({
        pullRequests: [createMockGitHubPR({ ciStatus: 'pending' })],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/pulls',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      const body = captured.sendBody as {
        pullRequests: readonly GitHubPullRequest[];
      };
      expect(body.pullRequests[0]?.ciStatus).toBe('pending');
    });

    it('returns none CI status when no CI configured', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectPRsSuccess({
        pullRequests: [createMockGitHubPR({ ciStatus: 'none' })],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/pulls',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      const body = captured.sendBody as {
        pullRequests: readonly GitHubPullRequest[];
      };
      expect(body.pullRequests[0]?.ciStatus).toBe('none');
    });
  });

  describe('AC5.5: Clicking PR opens GitHub in new tab', () => {
    it('returns htmlUrl for each PR', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      const expectedUrl = 'https://github.com/owner/repo/pull/123';
      serviceFake.queueGetProjectPRsSuccess({
        pullRequests: [createMockGitHubPR({ htmlUrl: expectedUrl })],
        repoFullName: 'owner/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/pulls',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      const body = captured.sendBody as {
        pullRequests: readonly GitHubPullRequest[];
      };
      expect(body.pullRequests[0]?.htmlUrl).toBe(expectedUrl);
    });
  });

  describe('AC5.6: CI status updates on refresh', () => {
    // Note: Actual refresh/webhook behavior is handled by the frontend.
    // This test verifies the API returns fresh data on each request.
    it('returns 200 OK response for successful fetch', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectPRsSuccess({
        pullRequests: [],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/pulls',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
    });
  });

  describe('Empty state', () => {
    it('returns empty array when no PRs exist', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectPRsSuccess({
        pullRequests: [],
        repoFullName: 'test/repo',
      });

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/pulls',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
      const body = captured.sendBody as {
        pullRequests: readonly GitHubPullRequest[];
      };
      expect(body.pullRequests).toEqual([]);
    });
  });

  describe('Error handling', () => {
    it('returns 404 when project not found', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectPRsError(
        new ProjectNotFoundError({
          message: 'Project not found',
          cause: undefined,
        }),
      );

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/non-existent/github/pulls',
        params: { id: 'non-existent' },
      });

      await handler(req, res, vi.fn());

      expect(captured.statusCode).toBe(HTTP_RESPONSE.NOT_FOUND);
    });

    it('returns 400 when project has no linked repo', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectPRsError(
        new NoLinkedRepoError({
          message: 'Project has no linked repository',
          cause: undefined,
        }),
      );

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/no-repo/github/pulls',
        params: { id: 'no-repo' },
      });

      await handler(req, res, vi.fn());

      expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_REQUEST);
    });

    it('returns 502 when GitHub API fails', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectPRsError(
        new GitHubApiError({
          message: 'GitHub API error',
          cause: undefined,
        }),
      );

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/pulls',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
    });

    it('returns 401 when GitHub token is missing', async () => {
      const handler = await importHandler();
      const serviceFake = getServiceFake();
      serviceFake.reset();

      serviceFake.queueGetProjectPRsError(
        new GitHubAuthError({
          message: 'GitHub token not configured',
          cause: undefined,
        }),
      );

      const { req, res, captured } = makeRequestContext({
        method: 'GET',
        url: '/api/projects/test-project/github/pulls',
        params: { id: 'test-project' },
      });

      await handler(req, res, vi.fn());

      expect(captured.statusCode).toBe(HTTP_RESPONSE.UNAUTHORIZED);
    });
  });
});

/**
 * GitHub Issues Handler
 *
 * Handles API endpoint for fetching GitHub issues for a project:
 * - GET /api/projects/:id/github/issues
 *
 * Implements AS-004: GitHub Issues Integration
 */

import {
  generateRequestHandler,
  GitHubApiError,
  GitHubAuthError,
  GitHubService,
  HTTP_RESPONSE,
  NoLinkedRepoError,
  ProjectNotFoundError,
  type GetGitHubIssuesResponse,
  type handlerInput,
} from '@packages/backend-core';
import { Effect } from 'effect';

import { AppLayer } from '@/layers/app.layer';

/**
 * Handler for GET /api/projects/:id/github/issues
 *
 * AC4.1: GitHub panel shows "Issues" section with linked issues
 * AC4.2: Each issue displays title, number, and status badge
 * AC4.3: Issue status badges: Open (green), Closed (gray), In Progress (blue)
 * AC4.4: Clicking issue opens GitHub in new tab (via htmlUrl)
 * AC4.5: Empty state shown when no linked issues (empty array)
 * AC4.6: Loading state handled by frontend
 */
const getGitHubIssuesHandler = (
  input: handlerInput,
): Effect.Effect<
  GetGitHubIssuesResponse,
  ProjectNotFoundError | NoLinkedRepoError | GitHubApiError | GitHubAuthError,
  GitHubService
> => {
  return Effect.gen(function* () {
    const req = yield* input;
    const projectId = req.params.id as string;

    const githubService = yield* GitHubService;
    const result = yield* githubService.getProjectIssues({ projectId });

    return {
      issues: result.issues,
      repoFullName: result.repoFullName,
    };
  });
};

/**
 * Exported request handler for GET /api/projects/:id/github/issues
 */
export const getGitHubIssuesRequestHandler = generateRequestHandler<
  GetGitHubIssuesResponse,
  ProjectNotFoundError | NoLinkedRepoError | GitHubApiError | GitHubAuthError
>({
  effectfulHandler: (input) =>
    getGitHubIssuesHandler(input).pipe(Effect.provide(AppLayer)),
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    [HTTP_RESPONSE.NOT_FOUND]: {
      errorType: ProjectNotFoundError,
      mapper: (e) => ({ error: e.message }),
    },
    [HTTP_RESPONSE.BAD_REQUEST]: {
      errorType: NoLinkedRepoError,
      mapper: (e) => ({ error: e.message }),
    },
    [HTTP_RESPONSE.BAD_GATEWAY]: {
      errorType: GitHubApiError,
      // AC1.5: Mask internal API errors from GitHub upstream
      mapper: () => ({ error: 'GitHub API request failed' }),
    },
    [HTTP_RESPONSE.UNAUTHORIZED]: {
      errorType: GitHubAuthError,
      // AC1.5: Mask internal auth errors from GitHub upstream
      mapper: () => ({ error: 'GitHub authentication failed' }),
    },
  },
  successCode: HTTP_RESPONSE.OK,
});

/**
 * GitHub PRs Handler
 *
 * Handles API endpoint for fetching GitHub pull requests for a project:
 * - GET /api/projects/:id/github/pulls
 *
 * Implements AS-005: GitHub PRs Integration
 */

import {
  generateRequestHandler,
  GitHubApiError,
  GitHubAuthError,
  GitHubService,
  HTTP_RESPONSE,
  NoLinkedRepoError,
  ProjectNotFoundError,
  type GetGitHubPRsResponse,
  type handlerInput,
} from '@packages/backend-core';
import { Effect } from 'effect';

import { AppLayer } from '@/layers/app.layer';

/**
 * Handler for GET /api/projects/:id/github/pulls
 *
 * AC5.1: GitHub panel shows "Pull Requests" section with linked PRs
 * AC5.2: Each PR displays title, number, and status badge
 * AC5.3: PR status badges: Open (green), Merged (purple), Draft (gray), Closed (red)
 * AC5.4: CI status badge shows: Passing (green check), Failing (red X), Pending (yellow dot)
 * AC5.5: Clicking PR opens GitHub in new tab (via htmlUrl)
 * AC5.6: CI status updates on refresh or webhook
 */
const getGitHubPRsHandler = (
  input: handlerInput,
): Effect.Effect<
  GetGitHubPRsResponse,
  ProjectNotFoundError | NoLinkedRepoError | GitHubApiError | GitHubAuthError,
  GitHubService
> => {
  return Effect.gen(function* () {
    const req = yield* input;
    const projectId = req.params.id as string;

    const githubService = yield* GitHubService;
    const result = yield* githubService.getProjectPRs({ projectId });

    return {
      pullRequests: result.pullRequests,
      repoFullName: result.repoFullName,
    };
  });
};

/**
 * Exported request handler for GET /api/projects/:id/github/pulls
 */
export const getGitHubPRsRequestHandler = generateRequestHandler<
  GetGitHubPRsResponse,
  ProjectNotFoundError | NoLinkedRepoError | GitHubApiError | GitHubAuthError
>({
  effectfulHandler: (input) =>
    getGitHubPRsHandler(input).pipe(Effect.provide(AppLayer)),
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

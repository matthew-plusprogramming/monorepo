/**
 * GitHub Service Implementation
 *
 * Live implementation of GitHubService that fetches data from GitHub API.
 * Uses GITHUB_API_TOKEN environment variable for authentication.
 */

import {
  GitHubApiError,
  GitHubAuthError,
  GitHubService,
  mapCIStatus,
  mapIssueStatus,
  mapPRStatus,
  NoLinkedRepoError,
  ProjectNotFoundError,
  type GetProjectIssuesInput,
  type GetProjectIssuesResult,
  type GetProjectPRsInput,
  type GetProjectPRsResult,
  type GitHubApiCheckRunsResponse,
  type GitHubApiCombinedStatus,
  type GitHubApiIssue,
  type GitHubApiPullRequest,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubServiceSchema,
} from '@packages/backend-core';
import { Effect, Layer } from 'effect';

/**
 * Project configuration with linked GitHub repo.
 * For now, this is a simple in-memory mapping.
 * In production, this would be fetched from a database.
 */
type ProjectConfig = {
  readonly repoFullName: string; // e.g., "owner/repo"
};

/**
 * Simple in-memory project configuration store.
 * In production, this would be replaced with a database lookup.
 */
const PROJECT_CONFIGS: Record<string, ProjectConfig> = {
  // Example project configuration - replace with actual project data
  'ai-eng-dashboard': { repoFullName: 'example/ai-eng-dashboard' },
};

/**
 * Gets the GitHub API token from environment variables.
 */
const getGitHubToken = (): Effect.Effect<string, GitHubAuthError> => {
  return Effect.sync(() => process.env.GITHUB_API_TOKEN).pipe(
    Effect.flatMap((token) => {
      if (!token) {
        return Effect.fail(
          new GitHubAuthError({
            message: 'GITHUB_API_TOKEN environment variable is not set',
            cause: undefined,
          }),
        );
      }
      return Effect.succeed(token);
    }),
  );
};

/**
 * Gets project configuration by project ID.
 */
const getProjectConfig = (
  projectId: string,
): Effect.Effect<ProjectConfig, ProjectNotFoundError | NoLinkedRepoError> => {
  return Effect.gen(function* () {
    const config = PROJECT_CONFIGS[projectId];
    if (!config) {
      return yield* new ProjectNotFoundError({
        message: `Project with id '${projectId}' not found`,
        cause: undefined,
      });
    }
    if (!config.repoFullName) {
      return yield* new NoLinkedRepoError({
        message: `Project '${projectId}' does not have a linked GitHub repository`,
        cause: undefined,
      });
    }
    return config;
  });
};

/**
 * Fetches issues from GitHub API.
 */
const fetchGitHubIssues = (
  repoFullName: string,
  token: string,
): Effect.Effect<readonly GitHubApiIssue[], GitHubApiError> => {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        `https://api.github.com/repos/${repoFullName}/issues?state=all&per_page=100`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `GitHub API error: ${response.status} - ${errorBody}`,
        );
      }

      return (await response.json()) as GitHubApiIssue[];
    },
    catch: (error) =>
      new GitHubApiError({
        message: error instanceof Error ? error.message : 'Unknown GitHub API error',
        cause: error,
      }),
  });
};

/**
 * Maps GitHub API issue to our GitHubIssue type.
 */
const mapApiIssueToIssue = (apiIssue: GitHubApiIssue): GitHubIssue => ({
  id: apiIssue.id,
  number: apiIssue.number,
  title: apiIssue.title,
  status: mapIssueStatus(apiIssue),
  htmlUrl: apiIssue.html_url,
  createdAt: apiIssue.created_at,
  updatedAt: apiIssue.updated_at,
});

/**
 * Fetches pull requests from GitHub API.
 */
const fetchGitHubPRs = (
  repoFullName: string,
  token: string,
): Effect.Effect<readonly GitHubApiPullRequest[], GitHubApiError> => {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        `https://api.github.com/repos/${repoFullName}/pulls?state=all&per_page=100`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${errorBody}`);
      }

      return (await response.json()) as GitHubApiPullRequest[];
    },
    catch: (error) =>
      new GitHubApiError({
        message:
          error instanceof Error ? error.message : 'Unknown GitHub API error',
        cause: error,
      }),
  });
};

/**
 * Fetches check runs for a specific commit SHA.
 */
const fetchCheckRuns = (
  repoFullName: string,
  sha: string,
  token: string,
): Effect.Effect<GitHubApiCheckRunsResponse, GitHubApiError> => {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        `https://api.github.com/repos/${repoFullName}/commits/${sha}/check-runs`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${errorBody}`);
      }

      return (await response.json()) as GitHubApiCheckRunsResponse;
    },
    catch: (error) =>
      new GitHubApiError({
        message:
          error instanceof Error ? error.message : 'Unknown GitHub API error',
        cause: error,
      }),
  });
};

/**
 * Fetches combined status for a specific commit SHA.
 */
const fetchCombinedStatus = (
  repoFullName: string,
  sha: string,
  token: string,
): Effect.Effect<GitHubApiCombinedStatus, GitHubApiError> => {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        `https://api.github.com/repos/${repoFullName}/commits/${sha}/status`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${errorBody}`);
      }

      return (await response.json()) as GitHubApiCombinedStatus;
    },
    catch: (error) =>
      new GitHubApiError({
        message:
          error instanceof Error ? error.message : 'Unknown GitHub API error',
        cause: error,
      }),
  });
};

/**
 * Maps GitHub API pull request to our GitHubPullRequest type.
 * Fetches CI status from check runs and combined status APIs.
 */
const mapApiPRToPullRequest = (
  apiPR: GitHubApiPullRequest,
  checkRuns: GitHubApiCheckRunsResponse,
  combinedStatus?: GitHubApiCombinedStatus,
): GitHubPullRequest => ({
  id: apiPR.id,
  number: apiPR.number,
  title: apiPR.title,
  status: mapPRStatus(apiPR),
  ciStatus: mapCIStatus(checkRuns, combinedStatus),
  htmlUrl: apiPR.html_url,
  createdAt: apiPR.created_at,
  updatedAt: apiPR.updated_at,
});

/**
 * Creates the live GitHub service implementation.
 */
const makeGitHubService = (): Effect.Effect<GitHubServiceSchema, never, never> => {
  return Effect.sync(() => {
    const service: GitHubServiceSchema = {
      getProjectIssues: (
        input: GetProjectIssuesInput,
      ): Effect.Effect<
        GetProjectIssuesResult,
        | ProjectNotFoundError
        | NoLinkedRepoError
        | GitHubApiError
        | GitHubAuthError,
        never
      > => {
        return Effect.gen(function* () {
          // Get project configuration
          const config = yield* getProjectConfig(input.projectId);

          // Get GitHub token
          const token = yield* getGitHubToken();

          // Fetch issues from GitHub
          const apiIssues = yield* fetchGitHubIssues(config.repoFullName, token);

          // Filter out pull requests (GitHub API returns PRs as issues too)
          const issuesOnly = apiIssues.filter(
            (issue) => !('pull_request' in issue),
          );

          // Map to our issue type
          const issues = issuesOnly.map(mapApiIssueToIssue);

          return {
            issues,
            repoFullName: config.repoFullName,
          };
        });
      },

      getProjectPRs: (
        input: GetProjectPRsInput,
      ): Effect.Effect<
        GetProjectPRsResult,
        | ProjectNotFoundError
        | NoLinkedRepoError
        | GitHubApiError
        | GitHubAuthError,
        never
      > => {
        return Effect.gen(function* () {
          // Get project configuration
          const config = yield* getProjectConfig(input.projectId);

          // Get GitHub token
          const token = yield* getGitHubToken();

          // Fetch PRs from GitHub
          const apiPRs = yield* fetchGitHubPRs(config.repoFullName, token);

          // Fetch CI status for each PR in parallel
          const pullRequests: GitHubPullRequest[] = [];
          for (const apiPR of apiPRs) {
            // Fetch check runs and combined status in parallel
            const [checkRuns, combinedStatus] = yield* Effect.all([
              fetchCheckRuns(config.repoFullName, apiPR.head.sha, token),
              fetchCombinedStatus(
                config.repoFullName,
                apiPR.head.sha,
                token,
              ).pipe(Effect.option),
            ]);

            const combinedStatusValue = combinedStatus._tag === 'Some' ? combinedStatus.value : undefined;
            pullRequests.push(mapApiPRToPullRequest(apiPR, checkRuns, combinedStatusValue));
          }

          return {
            pullRequests,
            repoFullName: config.repoFullName,
          };
        });
      },
    };

    return service;
  });
};

/**
 * Live GitHub service layer.
 */
export const LiveGitHubService = Layer.effect(
  GitHubService,
  makeGitHubService(),
);

export { GitHubService } from '@packages/backend-core';

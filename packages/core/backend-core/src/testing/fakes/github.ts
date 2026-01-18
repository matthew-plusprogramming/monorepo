/**
 * GitHub Service Fake
 *
 * Provides a fake implementation of GitHubService for testing.
 */

import { Effect, Layer } from 'effect';

import {
  GitHubApiError,
  GitHubAuthError,
  NoLinkedRepoError,
  ProjectNotFoundError,
} from '@/github/errors.js';
import {
  GitHubService,
  type GetProjectIssuesInput,
  type GetProjectIssuesResult,
  type GetProjectPRsInput,
  type GetProjectPRsResult,
  type GitHubServiceSchema,
} from '@/github/service.js';
import type { GitHubIssue, GitHubPullRequest } from '@/github/types.js';
import { InternalServerError } from '@/types/errors/http.js';

type GitHubError =
  | ProjectNotFoundError
  | NoLinkedRepoError
  | GitHubApiError
  | GitHubAuthError;

type GitHubErrorWithInternal = GitHubError | InternalServerError;

type SuccessEntry<T> = { type: 'success'; value: T };
type ErrorEntry<E> = { type: 'error'; error: E };
type ResponseEntry<T, E> = SuccessEntry<T> | ErrorEntry<E>;

type ResponseQueues = {
  readonly getProjectIssues: Array<
    ResponseEntry<GetProjectIssuesResult, GitHubErrorWithInternal>
  >;
  readonly getProjectPRs: Array<
    ResponseEntry<GetProjectPRsResult, GitHubErrorWithInternal>
  >;
};

type CallHistory = {
  readonly getProjectIssues: Array<GetProjectIssuesInput>;
  readonly getProjectPRs: Array<GetProjectPRsInput>;
};

export type GitHubServiceFake = {
  readonly service: GitHubServiceSchema;
  readonly layer: Layer.Layer<GitHubService, never, never>;
  readonly queueGetProjectIssuesSuccess: (result: GetProjectIssuesResult) => void;
  readonly queueGetProjectIssuesError: (error: GitHubError) => void;
  readonly queueGetProjectPRsSuccess: (result: GetProjectPRsResult) => void;
  readonly queueGetProjectPRsError: (error: GitHubError) => void;
  readonly calls: CallHistory;
  readonly reset: () => void;
};

const dequeue = <T, E>(
  queue: Array<ResponseEntry<T, E>>,
  operation: string,
): Effect.Effect<T, E | InternalServerError> => {
  const next = queue.shift();
  if (!next) {
    return Effect.fail(
      new InternalServerError({
        message: `No response queued for GitHubService.${operation}`,
        cause: undefined,
      }),
    );
  }

  if (next.type === 'success') {
    return Effect.succeed(next.value);
  }

  return Effect.fail(next.error);
};

export const createGitHubServiceFake = (): GitHubServiceFake => {
  const responseQueues: ResponseQueues = {
    getProjectIssues: [],
    getProjectPRs: [],
  };

  const callHistory: CallHistory = {
    getProjectIssues: [],
    getProjectPRs: [],
  };

  const service: GitHubServiceSchema = {
    getProjectIssues: (input: GetProjectIssuesInput) =>
      Effect.sync(() => {
        callHistory.getProjectIssues.push(input);
      }).pipe(
        Effect.flatMap(() =>
          dequeue(responseQueues.getProjectIssues, 'getProjectIssues') as Effect.Effect<
            GetProjectIssuesResult,
            GitHubError,
            never
          >,
        ),
      ),
    getProjectPRs: (input: GetProjectPRsInput) =>
      Effect.sync(() => {
        callHistory.getProjectPRs.push(input);
      }).pipe(
        Effect.flatMap(() =>
          dequeue(responseQueues.getProjectPRs, 'getProjectPRs') as Effect.Effect<
            GetProjectPRsResult,
            GitHubError,
            never
          >,
        ),
      ),
  };

  return {
    service,
    layer: Layer.succeed(GitHubService, service),
    queueGetProjectIssuesSuccess: (result: GetProjectIssuesResult): void => {
      responseQueues.getProjectIssues.push({ type: 'success', value: result });
    },
    queueGetProjectIssuesError: (error: GitHubError): void => {
      responseQueues.getProjectIssues.push({ type: 'error', error });
    },
    queueGetProjectPRsSuccess: (result: GetProjectPRsResult): void => {
      responseQueues.getProjectPRs.push({ type: 'success', value: result });
    },
    queueGetProjectPRsError: (error: GitHubError): void => {
      responseQueues.getProjectPRs.push({ type: 'error', error });
    },
    calls: callHistory,
    reset: (): void => {
      responseQueues.getProjectIssues.length = 0;
      responseQueues.getProjectPRs.length = 0;
      callHistory.getProjectIssues.length = 0;
      callHistory.getProjectPRs.length = 0;
    },
  };
};

/**
 * Helper to create mock GitHub issues for testing.
 */
export const createMockGitHubIssue = (
  overrides: Partial<GitHubIssue> = {},
): GitHubIssue => ({
  id: 1,
  number: 1,
  title: 'Test Issue',
  status: 'open',
  htmlUrl: 'https://github.com/test/repo/issues/1',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

/**
 * Helper to create mock GitHub pull requests for testing.
 */
export const createMockGitHubPR = (
  overrides: Partial<GitHubPullRequest> = {},
): GitHubPullRequest => ({
  id: 1,
  number: 1,
  title: 'Test PR',
  status: 'open',
  ciStatus: 'passing',
  htmlUrl: 'https://github.com/test/repo/pull/1',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

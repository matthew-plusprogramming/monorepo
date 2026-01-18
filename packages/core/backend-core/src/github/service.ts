/**
 * GitHub Service
 *
 * Service definition for GitHub API operations using Effect.
 */

import { Context, type Effect } from 'effect';

import {
  GitHubApiError,
  GitHubAuthError,
  NoLinkedRepoError,
  ProjectNotFoundError,
} from '@/github/errors.js';
import type { GitHubIssue, GitHubPullRequest } from '@/github/types.js';

/**
 * Input for fetching issues for a project.
 */
export type GetProjectIssuesInput = {
  readonly projectId: string;
};

/**
 * Result of fetching issues for a project.
 */
export type GetProjectIssuesResult = {
  readonly issues: readonly GitHubIssue[];
  readonly repoFullName: string;
};

/**
 * Input for fetching pull requests for a project.
 */
export type GetProjectPRsInput = {
  readonly projectId: string;
};

/**
 * Result of fetching pull requests for a project.
 */
export type GetProjectPRsResult = {
  readonly pullRequests: readonly GitHubPullRequest[];
  readonly repoFullName: string;
};

/**
 * GitHub service schema definition.
 */
export type GitHubServiceSchema = {
  /**
   * Fetches GitHub issues for a project.
   */
  readonly getProjectIssues: (
    input: GetProjectIssuesInput,
  ) => Effect.Effect<
    GetProjectIssuesResult,
    | ProjectNotFoundError
    | NoLinkedRepoError
    | GitHubApiError
    | GitHubAuthError,
    never
  >;

  /**
   * Fetches GitHub pull requests for a project with CI status.
   */
  readonly getProjectPRs: (
    input: GetProjectPRsInput,
  ) => Effect.Effect<
    GetProjectPRsResult,
    | ProjectNotFoundError
    | NoLinkedRepoError
    | GitHubApiError
    | GitHubAuthError,
    never
  >;
};

/**
 * GitHub service context tag.
 */
export class GitHubService extends Context.Tag('GitHubService')<
  GitHubService,
  GitHubServiceSchema
>() {}

/**
 * GitHub Types
 *
 * Type definitions for GitHub integration features.
 */

/**
 * Issue status for display in the dashboard.
 * Maps GitHub issue state + labels to our status badges.
 */
export type IssueStatus = 'open' | 'closed' | 'in_progress';

/**
 * Represents a GitHub issue as displayed in the dashboard.
 */
export type GitHubIssue = {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly status: IssueStatus;
  readonly htmlUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/**
 * Response from the GitHub issues endpoint.
 */
export type GetGitHubIssuesResponse = {
  readonly issues: readonly GitHubIssue[];
  readonly repoFullName: string;
};

/**
 * GitHub API issue response shape (subset of full API response).
 */
export type GitHubApiIssue = {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly html_url: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly labels: readonly {
    readonly name: string;
  }[];
};

/**
 * PR status for display in the dashboard.
 * Maps GitHub PR state + draft flag + merged status to our status badges.
 */
export type PRStatus = 'open' | 'merged' | 'draft' | 'closed';

/**
 * CI status for display in the dashboard.
 * Maps GitHub check runs/status to our CI status badges.
 */
export type CIStatus = 'passing' | 'failing' | 'pending' | 'none';

/**
 * Represents a GitHub pull request as displayed in the dashboard.
 */
export type GitHubPullRequest = {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly status: PRStatus;
  readonly ciStatus: CIStatus;
  readonly htmlUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/**
 * Response from the GitHub PRs endpoint.
 */
export type GetGitHubPRsResponse = {
  readonly pullRequests: readonly GitHubPullRequest[];
  readonly repoFullName: string;
};

/**
 * GitHub API pull request response shape (subset of full API response).
 */
export type GitHubApiPullRequest = {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly draft: boolean;
  readonly merged: boolean;
  readonly html_url: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly head: {
    readonly sha: string;
  };
};

/**
 * GitHub API check run response shape (subset of full API response).
 */
export type GitHubApiCheckRun = {
  readonly id: number;
  readonly name: string;
  readonly status: 'queued' | 'in_progress' | 'completed';
  readonly conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | null;
};

/**
 * GitHub API combined status response shape (subset of full API response).
 */
export type GitHubApiCombinedStatus = {
  readonly state: 'pending' | 'success' | 'failure' | 'error';
  readonly statuses: readonly {
    readonly state: 'pending' | 'success' | 'failure' | 'error';
    readonly context: string;
  }[];
};

/**
 * GitHub API check runs list response shape.
 */
export type GitHubApiCheckRunsResponse = {
  readonly total_count: number;
  readonly check_runs: readonly GitHubApiCheckRun[];
};

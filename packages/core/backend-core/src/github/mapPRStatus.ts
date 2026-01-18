/**
 * Map GitHub PR Status
 *
 * Maps GitHub PR state, draft flag, and merged status to dashboard status badges.
 * - Open (green): PR is open and not a draft
 * - Merged (purple): PR has been merged
 * - Draft (gray): PR is a draft
 * - Closed (red): PR is closed without being merged
 */

import type {
  CIStatus,
  GitHubApiCheckRunsResponse,
  GitHubApiCombinedStatus,
  GitHubApiPullRequest,
  PRStatus,
} from '@/github/types.js';

/**
 * Maps a GitHub API pull request to our PRStatus type.
 *
 * @param pr - The GitHub API pull request response
 * @returns The mapped PRStatus
 */
export const mapPRStatus = (pr: GitHubApiPullRequest): PRStatus => {
  // Merged PRs show as "merged" (purple)
  if (pr.merged) {
    return 'merged';
  }

  // Closed but not merged PRs show as "closed" (red)
  // This takes priority over draft status for closed PRs
  if (pr.state === 'closed') {
    return 'closed';
  }

  // Open draft PRs show as "draft" (gray)
  if (pr.draft) {
    return 'draft';
  }

  // Open PRs that are not drafts show as "open" (green)
  return 'open';
};

/**
 * Maps GitHub check runs and combined status to our CIStatus type.
 * Prioritizes check runs (GitHub Actions) over legacy commit statuses.
 *
 * @param checkRuns - The GitHub API check runs response
 * @param combinedStatus - The GitHub API combined status response (optional)
 * @returns The mapped CIStatus
 */
export const mapCIStatus = (
  checkRuns: GitHubApiCheckRunsResponse,
  combinedStatus?: GitHubApiCombinedStatus,
): CIStatus => {
  // First check GitHub Actions (check runs)
  if (checkRuns.total_count > 0) {
    const runs = checkRuns.check_runs;

    // If any check is failing, CI is failing
    const hasFailure = runs.some(
      (run) =>
        run.status === 'completed' &&
        (run.conclusion === 'failure' ||
          run.conclusion === 'timed_out' ||
          run.conclusion === 'action_required'),
    );
    if (hasFailure) {
      return 'failing';
    }

    // If any check is pending or in progress, CI is pending
    const hasPending = runs.some(
      (run) =>
        run.status === 'queued' ||
        run.status === 'in_progress' ||
        (run.status === 'completed' && run.conclusion === null),
    );
    if (hasPending) {
      return 'pending';
    }

    // All checks passed (success, neutral, cancelled, skipped)
    const allPassed = runs.every(
      (run) =>
        run.status === 'completed' &&
        (run.conclusion === 'success' ||
          run.conclusion === 'neutral' ||
          run.conclusion === 'cancelled' ||
          run.conclusion === 'skipped'),
    );
    if (allPassed) {
      return 'passing';
    }

    return 'pending';
  }

  // Fall back to legacy commit status API
  if (combinedStatus && combinedStatus.statuses.length > 0) {
    switch (combinedStatus.state) {
      case 'success':
        return 'passing';
      case 'failure':
      case 'error':
        return 'failing';
      case 'pending':
        return 'pending';
    }
  }

  // No CI configured
  return 'none';
};

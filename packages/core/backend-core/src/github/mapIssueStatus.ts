/**
 * Map GitHub Issue Status
 *
 * Maps GitHub issue state and labels to dashboard status badges.
 * - Open (green): Issue is open without in-progress label
 * - Closed (gray): Issue is closed
 * - In Progress (blue): Issue has "in progress" label (case-insensitive)
 */

import type { GitHubApiIssue, IssueStatus } from '@/github/types.js';

/**
 * Labels that indicate an issue is in progress.
 * Matches case-insensitively.
 */
const IN_PROGRESS_LABELS = ['in progress', 'in-progress', 'wip', 'doing'];

/**
 * Maps a GitHub API issue to our IssueStatus type.
 *
 * @param issue - The GitHub API issue response
 * @returns The mapped IssueStatus
 */
export const mapIssueStatus = (issue: GitHubApiIssue): IssueStatus => {
  // Closed issues are always "closed"
  if (issue.state === 'closed') {
    return 'closed';
  }

  // Check if any label indicates "in progress"
  const hasInProgressLabel = issue.labels.some((label) =>
    IN_PROGRESS_LABELS.includes(label.name.toLowerCase()),
  );

  if (hasInProgressLabel) {
    return 'in_progress';
  }

  // Default open issues without in-progress label
  return 'open';
};

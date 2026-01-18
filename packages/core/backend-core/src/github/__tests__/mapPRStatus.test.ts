/**
 * Map PR Status Tests
 *
 * Tests for mapPRStatus and mapCIStatus functions.
 * Covers AC5.3 (PR status badges) and AC5.4 (CI status badges).
 */

import { describe, expect, it } from 'vitest';

import { mapCIStatus, mapPRStatus } from '@/github/mapPRStatus.js';
import type {
  GitHubApiCheckRunsResponse,
  GitHubApiCombinedStatus,
  GitHubApiPullRequest,
} from '@/github/types.js';

const createMockApiPR = (
  overrides: Partial<GitHubApiPullRequest> = {},
): GitHubApiPullRequest => ({
  id: 1,
  number: 1,
  title: 'Test PR',
  state: 'open',
  draft: false,
  merged: false,
  html_url: 'https://github.com/test/repo/pull/1',
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
  head: {
    sha: 'abc123',
  },
  ...overrides,
});

const createMockCheckRuns = (
  overrides: Partial<GitHubApiCheckRunsResponse> = {},
): GitHubApiCheckRunsResponse => ({
  total_count: 0,
  check_runs: [],
  ...overrides,
});

const createMockCombinedStatus = (
  overrides: Partial<GitHubApiCombinedStatus> = {},
): GitHubApiCombinedStatus => ({
  state: 'pending',
  statuses: [],
  ...overrides,
});

describe('mapPRStatus', () => {
  describe('AC5.3: PR status badges mapping', () => {
    describe('Merged status (purple badge)', () => {
      it('returns "merged" for merged PRs', () => {
        const pr = createMockApiPR({ state: 'closed', merged: true });
        expect(mapPRStatus(pr)).toBe('merged');
      });

      it('returns "merged" even if PR is marked as draft', () => {
        const pr = createMockApiPR({ state: 'closed', merged: true, draft: true });
        expect(mapPRStatus(pr)).toBe('merged');
      });
    });

    describe('Draft status (gray badge)', () => {
      it('returns "draft" for draft PRs', () => {
        const pr = createMockApiPR({ state: 'open', draft: true });
        expect(mapPRStatus(pr)).toBe('draft');
      });
    });

    describe('Closed status (red badge)', () => {
      it('returns "closed" for closed PRs that are not merged', () => {
        const pr = createMockApiPR({ state: 'closed', merged: false });
        expect(mapPRStatus(pr)).toBe('closed');
      });

      it('returns "closed" for closed draft PRs that are not merged', () => {
        const pr = createMockApiPR({ state: 'closed', merged: false, draft: true });
        expect(mapPRStatus(pr)).toBe('closed');
      });
    });

    describe('Open status (green badge)', () => {
      it('returns "open" for open PRs that are not drafts', () => {
        const pr = createMockApiPR({ state: 'open', draft: false });
        expect(mapPRStatus(pr)).toBe('open');
      });
    });
  });
});

describe('mapCIStatus', () => {
  describe('AC5.4: CI status badges mapping', () => {
    describe('No CI configured', () => {
      it('returns "none" when no check runs and no combined status', () => {
        const checkRuns = createMockCheckRuns({ total_count: 0, check_runs: [] });
        expect(mapCIStatus(checkRuns)).toBe('none');
      });

      it('returns "none" when no check runs and combined status has no statuses', () => {
        const checkRuns = createMockCheckRuns({ total_count: 0, check_runs: [] });
        const combinedStatus = createMockCombinedStatus({ statuses: [] });
        expect(mapCIStatus(checkRuns, combinedStatus)).toBe('none');
      });
    });

    describe('GitHub Actions (check runs)', () => {
      it('returns "passing" when all checks are successful', () => {
        const checkRuns = createMockCheckRuns({
          total_count: 2,
          check_runs: [
            { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
            { id: 2, name: 'lint', status: 'completed', conclusion: 'success' },
          ],
        });
        expect(mapCIStatus(checkRuns)).toBe('passing');
      });

      it('returns "passing" when checks are neutral or skipped', () => {
        const checkRuns = createMockCheckRuns({
          total_count: 2,
          check_runs: [
            { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
            { id: 2, name: 'skip', status: 'completed', conclusion: 'skipped' },
          ],
        });
        expect(mapCIStatus(checkRuns)).toBe('passing');
      });

      it('returns "failing" when any check fails', () => {
        const checkRuns = createMockCheckRuns({
          total_count: 2,
          check_runs: [
            { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
            { id: 2, name: 'lint', status: 'completed', conclusion: 'failure' },
          ],
        });
        expect(mapCIStatus(checkRuns)).toBe('failing');
      });

      it('returns "failing" when any check times out', () => {
        const checkRuns = createMockCheckRuns({
          total_count: 1,
          check_runs: [
            { id: 1, name: 'test', status: 'completed', conclusion: 'timed_out' },
          ],
        });
        expect(mapCIStatus(checkRuns)).toBe('failing');
      });

      it('returns "failing" when any check requires action', () => {
        const checkRuns = createMockCheckRuns({
          total_count: 1,
          check_runs: [
            {
              id: 1,
              name: 'security',
              status: 'completed',
              conclusion: 'action_required',
            },
          ],
        });
        expect(mapCIStatus(checkRuns)).toBe('failing');
      });

      it('returns "pending" when any check is queued', () => {
        const checkRuns = createMockCheckRuns({
          total_count: 2,
          check_runs: [
            { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
            { id: 2, name: 'lint', status: 'queued', conclusion: null },
          ],
        });
        expect(mapCIStatus(checkRuns)).toBe('pending');
      });

      it('returns "pending" when any check is in progress', () => {
        const checkRuns = createMockCheckRuns({
          total_count: 2,
          check_runs: [
            { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
            { id: 2, name: 'lint', status: 'in_progress', conclusion: null },
          ],
        });
        expect(mapCIStatus(checkRuns)).toBe('pending');
      });
    });

    describe('Legacy commit status API fallback', () => {
      it('returns "passing" when combined status is success', () => {
        const checkRuns = createMockCheckRuns({ total_count: 0, check_runs: [] });
        const combinedStatus = createMockCombinedStatus({
          state: 'success',
          statuses: [
            { state: 'success', context: 'ci/jenkins' },
          ],
        });
        expect(mapCIStatus(checkRuns, combinedStatus)).toBe('passing');
      });

      it('returns "failing" when combined status is failure', () => {
        const checkRuns = createMockCheckRuns({ total_count: 0, check_runs: [] });
        const combinedStatus = createMockCombinedStatus({
          state: 'failure',
          statuses: [
            { state: 'failure', context: 'ci/jenkins' },
          ],
        });
        expect(mapCIStatus(checkRuns, combinedStatus)).toBe('failing');
      });

      it('returns "failing" when combined status is error', () => {
        const checkRuns = createMockCheckRuns({ total_count: 0, check_runs: [] });
        const combinedStatus = createMockCombinedStatus({
          state: 'error',
          statuses: [
            { state: 'error', context: 'ci/jenkins' },
          ],
        });
        expect(mapCIStatus(checkRuns, combinedStatus)).toBe('failing');
      });

      it('returns "pending" when combined status is pending', () => {
        const checkRuns = createMockCheckRuns({ total_count: 0, check_runs: [] });
        const combinedStatus = createMockCombinedStatus({
          state: 'pending',
          statuses: [
            { state: 'pending', context: 'ci/jenkins' },
          ],
        });
        expect(mapCIStatus(checkRuns, combinedStatus)).toBe('pending');
      });
    });

    describe('Check runs take priority over combined status', () => {
      it('uses check runs status when both are present', () => {
        const checkRuns = createMockCheckRuns({
          total_count: 1,
          check_runs: [
            { id: 1, name: 'test', status: 'completed', conclusion: 'failure' },
          ],
        });
        const combinedStatus = createMockCombinedStatus({
          state: 'success',
          statuses: [
            { state: 'success', context: 'ci/jenkins' },
          ],
        });
        // Check runs show failure, combined status shows success
        // Check runs should take priority
        expect(mapCIStatus(checkRuns, combinedStatus)).toBe('failing');
      });
    });
  });
});

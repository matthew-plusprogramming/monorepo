/**
 * Map Issue Status Tests
 *
 * Tests for mapIssueStatus function.
 * Covers AC4.3: Issue status badges mapping.
 */

import { describe, expect, it } from 'vitest';

import { mapIssueStatus } from '@/github/mapIssueStatus.js';
import type { GitHubApiIssue } from '@/github/types.js';

const createMockApiIssue = (
  overrides: Partial<GitHubApiIssue> = {},
): GitHubApiIssue => ({
  id: 1,
  number: 1,
  title: 'Test Issue',
  state: 'open',
  html_url: 'https://github.com/test/repo/issues/1',
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
  labels: [],
  ...overrides,
});

describe('mapIssueStatus', () => {
  describe('AC4.3: Issue status badges mapping', () => {
    describe('Closed status (gray badge)', () => {
      it('returns "closed" for closed issues', () => {
        const issue = createMockApiIssue({ state: 'closed' });
        expect(mapIssueStatus(issue)).toBe('closed');
      });

      it('returns "closed" for closed issues even with in-progress label', () => {
        const issue = createMockApiIssue({
          state: 'closed',
          labels: [{ name: 'in progress' }],
        });
        expect(mapIssueStatus(issue)).toBe('closed');
      });
    });

    describe('In Progress status (blue badge)', () => {
      it('returns "in_progress" for open issues with "in progress" label', () => {
        const issue = createMockApiIssue({
          state: 'open',
          labels: [{ name: 'in progress' }],
        });
        expect(mapIssueStatus(issue)).toBe('in_progress');
      });

      it('returns "in_progress" for open issues with "in-progress" label (hyphenated)', () => {
        const issue = createMockApiIssue({
          state: 'open',
          labels: [{ name: 'in-progress' }],
        });
        expect(mapIssueStatus(issue)).toBe('in_progress');
      });

      it('returns "in_progress" for open issues with "wip" label', () => {
        const issue = createMockApiIssue({
          state: 'open',
          labels: [{ name: 'wip' }],
        });
        expect(mapIssueStatus(issue)).toBe('in_progress');
      });

      it('returns "in_progress" for open issues with "doing" label', () => {
        const issue = createMockApiIssue({
          state: 'open',
          labels: [{ name: 'doing' }],
        });
        expect(mapIssueStatus(issue)).toBe('in_progress');
      });

      it('handles case-insensitive label matching', () => {
        const issue = createMockApiIssue({
          state: 'open',
          labels: [{ name: 'IN PROGRESS' }],
        });
        expect(mapIssueStatus(issue)).toBe('in_progress');
      });

      it('handles WIP in uppercase', () => {
        const issue = createMockApiIssue({
          state: 'open',
          labels: [{ name: 'WIP' }],
        });
        expect(mapIssueStatus(issue)).toBe('in_progress');
      });
    });

    describe('Open status (green badge)', () => {
      it('returns "open" for open issues without in-progress labels', () => {
        const issue = createMockApiIssue({ state: 'open' });
        expect(mapIssueStatus(issue)).toBe('open');
      });

      it('returns "open" for open issues with unrelated labels', () => {
        const issue = createMockApiIssue({
          state: 'open',
          labels: [{ name: 'bug' }, { name: 'enhancement' }],
        });
        expect(mapIssueStatus(issue)).toBe('open');
      });
    });

    describe('Multiple labels', () => {
      it('returns "in_progress" if any label matches in-progress', () => {
        const issue = createMockApiIssue({
          state: 'open',
          labels: [{ name: 'bug' }, { name: 'in progress' }, { name: 'high priority' }],
        });
        expect(mapIssueStatus(issue)).toBe('in_progress');
      });
    });
  });
});

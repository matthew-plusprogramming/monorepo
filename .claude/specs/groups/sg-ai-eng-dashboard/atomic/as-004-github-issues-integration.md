---
id: as-004-github-issues-integration
title: GitHub Issues Integration
spec_group: sg-ai-eng-dashboard
requirements_refs: [REQ-004]
status: implemented
---

# GitHub Issues Integration

## References

- **Requirements**: REQ-004
- **Parent Spec Section**: spec.md#acceptance-criteria
- **Spec Group**: sg-ai-eng-dashboard

## Description

Display linked GitHub issues for each project in the GitHub panel. Shows issue status (open, closed, in progress) with links to full GitHub context. Issues are fetched via GitHub API.

## Acceptance Criteria

- **AC4.1**: GitHub panel shows "Issues" section with linked issues
- **AC4.2**: Each issue displays title, number, and status badge
- **AC4.3**: Issue status badges: Open (green), Closed (gray), In Progress (blue)
- **AC4.4**: Clicking issue opens GitHub in new tab
- **AC4.5**: Empty state shown when no linked issues
- **AC4.6**: Loading state while fetching issues

## Test Strategy

- Unit tests for IssueCard component rendering
- Unit tests for status badge logic
- Integration test with mocked GitHub API
- Empty state and loading state tests

Test file: `apps/client-website/src/components/GitHub/__tests__/Issues.test.tsx`

## Deployment Notes

- Requires GITHUB_API_TOKEN environment variable
- Token needs repo read access
- Consider caching to reduce API calls

## Rollback Strategy

- Hide Issues section in GitHub panel
- Show "Issues temporarily unavailable" message

## Atomicity Justification

| Criterion | Justification |
|-----------|---------------|
| **Independently Testable** | Can test issue display with mocked GitHub data |
| **Independently Deployable** | Issues feature works without PRs feature |
| **Independently Reviewable** | Scope limited to issue-related components |
| **Independently Reversible** | Hide issues section without affecting other GitHub features |

## Implementation Evidence

| File | Line | Description |
|------|------|-------------|
| `packages/core/backend-core/src/github/types.ts` | 1-48 | GitHub issue and API types (GitHubIssue, IssueStatus, GitHubApiIssue) |
| `packages/core/backend-core/src/github/errors.ts` | 1-34 | GitHub-related errors (ProjectNotFoundError, NoLinkedRepoError, GitHubApiError, GitHubAuthError) |
| `packages/core/backend-core/src/github/service.ts` | 1-49 | GitHubService Effect context and schema definition |
| `packages/core/backend-core/src/github/mapIssueStatus.ts` | 1-36 | Maps GitHub API issue state/labels to IssueStatus (AC4.3) |
| `packages/core/backend-core/src/github/index.ts` | 1-11 | GitHub module exports |
| `apps/node-server/src/services/github.service.ts` | 1-212 | Live GitHub service implementation with API calls |
| `apps/node-server/src/handlers/githubIssues.handler.ts` | 1-85 | GET /api/projects/:id/github/issues endpoint handler |
| `apps/node-server/src/layers/app.layer.ts` | 5,19 | Added LiveGitHubService to AppLayer |
| `apps/node-server/src/index.ts` | 14,95-100 | Registered GitHub issues route with session middleware |
| `packages/core/backend-core/src/testing/fakes/github.ts` | 1-169 | GitHubService fake for testing |

## Test Evidence

| Test File | Test Name | ACs Covered |
|-----------|-----------|-------------|
| `apps/node-server/src/__tests__/handlers/githubIssues.handler.test.ts` | AC4.1: GitHub panel shows Issues section with linked issues | AC4.1 |
| `apps/node-server/src/__tests__/handlers/githubIssues.handler.test.ts` | AC4.2: Each issue displays title, number, and status badge | AC4.2 |
| `apps/node-server/src/__tests__/handlers/githubIssues.handler.test.ts` | AC4.3: Issue status badges (Open green, Closed gray, In Progress blue) | AC4.3 |
| `apps/node-server/src/__tests__/handlers/githubIssues.handler.test.ts` | AC4.4: Clicking issue opens GitHub in new tab | AC4.4 |
| `apps/node-server/src/__tests__/handlers/githubIssues.handler.test.ts` | AC4.5: Empty state shown when no linked issues | AC4.5 |
| `apps/node-server/src/__tests__/handlers/githubIssues.handler.test.ts` | AC4.6: Loading state while fetching issues | AC4.6 |
| `apps/node-server/src/__tests__/handlers/githubIssues.handler.test.ts` | Error handling (404, 400, 502, 401) | Error cases |
| `packages/core/backend-core/src/github/__tests__/mapIssueStatus.test.ts` | mapIssueStatus - Closed status | AC4.3 |
| `packages/core/backend-core/src/github/__tests__/mapIssueStatus.test.ts` | mapIssueStatus - In Progress status | AC4.3 |
| `packages/core/backend-core/src/github/__tests__/mapIssueStatus.test.ts` | mapIssueStatus - Open status | AC4.3 |

## Decision Log

- `2026-01-17T20:50:00Z`: Created from spec.md decomposition
- `2026-01-17T22:35:00Z`: Backend implementation complete - GitHub service, handler, and tests implemented using Effect for error handling. GitHub polling interval resolved to 2x per day when webhooks unavailable.

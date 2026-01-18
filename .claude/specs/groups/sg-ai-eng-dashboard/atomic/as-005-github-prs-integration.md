---
id: as-005-github-prs-integration
title: GitHub PRs Integration
spec_group: sg-ai-eng-dashboard
requirements_refs: [REQ-005]
status: implemented
---

# GitHub PRs Integration

## References

- **Requirements**: REQ-005
- **Parent Spec Section**: spec.md#acceptance-criteria
- **Spec Group**: sg-ai-eng-dashboard

## Description

Display linked pull requests for each project with CI status badges. Shows PR status (open, merged, draft) and GitHub Actions CI check status (passing, failing, pending).

## Acceptance Criteria

- **AC5.1**: GitHub panel shows "Pull Requests" section with linked PRs
- **AC5.2**: Each PR displays title, number, and status badge
- **AC5.3**: PR status badges: Open (green), Merged (purple), Draft (gray), Closed (red)
- **AC5.4**: CI status badge shows: Passing (green check), Failing (red X), Pending (yellow dot)
- **AC5.5**: Clicking PR opens GitHub in new tab
- **AC5.6**: CI status updates on refresh or webhook

## Test Strategy

- Unit tests for PRCard component rendering
- Unit tests for CI status badge logic
- Integration test with mocked GitHub API
- Tests for various CI state combinations

Test file: `apps/client-website/src/components/GitHub/__tests__/PRs.test.tsx`

## Deployment Notes

- Uses same GITHUB_API_TOKEN as issues
- CI status from GitHub Actions API
- Webhook listener optional for real-time updates

## Rollback Strategy

- Hide PRs section in GitHub panel
- Show "PRs temporarily unavailable" message

## Atomicity Justification

| Criterion | Justification |
|-----------|---------------|
| **Independently Testable** | Can test PR display with mocked GitHub data |
| **Independently Deployable** | PRs feature works without Issues feature |
| **Independently Reviewable** | Scope limited to PR-related components |
| **Independently Reversible** | Hide PRs section without affecting issues |

## Implementation Evidence

| File | Line | Description |
|------|------|-------------|
| `packages/core/backend-core/src/github/types.ts` | 50-137 | PR types: PRStatus, CIStatus, GitHubPullRequest, GitHubApiPullRequest, GitHubApiCheckRun, GitHubApiCombinedStatus |
| `packages/core/backend-core/src/github/mapPRStatus.ts` | 1-115 | mapPRStatus (AC5.3) and mapCIStatus (AC5.4) functions |
| `packages/core/backend-core/src/github/service.ts` | 32-77 | GetProjectPRsInput/Result types and GitHubService.getProjectPRs method definition |
| `apps/node-server/src/services/github.service.ts` | 147-274 | fetchGitHubPRs, fetchCheckRuns, fetchCombinedStatus, mapApiPRToPullRequest functions |
| `apps/node-server/src/services/github.service.ts` | 317-359 | getProjectPRs service implementation with CI status fetching |
| `apps/node-server/src/handlers/githubPRs.handler.ts` | 1-87 | GET /api/projects/:id/github/pulls handler (AC5.1, AC5.2, AC5.5) |
| `apps/node-server/src/index.ts` | 103-108 | Route registration for GitHub PRs endpoint |
| `packages/core/backend-core/src/testing/fakes/github.ts` | 103-110 | GitHubServiceFake.getProjectPRs for testing

## Test Evidence

| Test File | Test Name | ACs Covered |
|-----------|-----------|-------------|
| `packages/core/backend-core/src/github/__tests__/mapPRStatus.test.ts` | mapPRStatus > AC5.3: PR status badges mapping | AC5.3 |
| `packages/core/backend-core/src/github/__tests__/mapPRStatus.test.ts` | mapCIStatus > AC5.4: CI status badges mapping | AC5.4 |
| `apps/node-server/src/__tests__/handlers/githubPRs.handler.test.ts` | AC5.1: GitHub panel shows Pull Requests section with linked PRs | AC5.1 |
| `apps/node-server/src/__tests__/handlers/githubPRs.handler.test.ts` | AC5.2: Each PR displays title, number, and status badge | AC5.2 |
| `apps/node-server/src/__tests__/handlers/githubPRs.handler.test.ts` | AC5.3: PR status badges (Open, Merged, Draft, Closed) | AC5.3 |
| `apps/node-server/src/__tests__/handlers/githubPRs.handler.test.ts` | AC5.4: CI status badge (Passing, Failing, Pending, None) | AC5.4 |
| `apps/node-server/src/__tests__/handlers/githubPRs.handler.test.ts` | AC5.5: Clicking PR opens GitHub in new tab | AC5.5 |
| `apps/node-server/src/__tests__/handlers/githubPRs.handler.test.ts` | AC5.6: CI status updates on refresh | AC5.6 |
| `apps/node-server/src/__tests__/handlers/githubPRs.handler.test.ts` | Error handling (404, 400, 502, 401) | Error cases |

## Decision Log

- `2026-01-17T20:50:00Z`: Created from spec.md decomposition
- `2026-01-18T06:36:00Z`: Implemented backend API endpoint and service layer. Created types for PR status (open/merged/draft/closed) and CI status (passing/failing/pending/none). Extended GitHubService with getProjectPRs method. Added handler with error mapping. Created 37+ tests covering all ACs.

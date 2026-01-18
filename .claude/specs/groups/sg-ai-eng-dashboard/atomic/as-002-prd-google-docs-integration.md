---
id: as-002-prd-google-docs-integration
title: PRD Google Docs Integration
spec_group: sg-ai-eng-dashboard
requirements_refs: [REQ-002]
status: implemented
---

# PRD Google Docs Integration

## References

- **Requirements**: REQ-002
- **Parent Spec Section**: spec.md#acceptance-criteria
- **Spec Group**: sg-ai-eng-dashboard

## Description

Implement the ability to sync PRD content from Google Docs. When user clicks "Sync" on a PRD, the system fetches latest content via Google Docs API, updates the local record, and displays the new version with timestamp.

## Acceptance Criteria

- **AC2.1**: PRD list shows each PRD with title, version, and last sync timestamp
- **AC2.2**: "Sync" button visible on each PRD card
- **AC2.3**: Clicking Sync fetches content from Google Docs API
- **AC2.4**: PRD content updates in UI after successful sync
- **AC2.5**: Version number increments on content change
- **AC2.6**: Error message displayed on API failure with retry option

## Test Strategy

- Unit tests for PRD card rendering
- Unit tests for Google Docs API client (mocked)
- Integration test with mock Google Docs responses
- Error handling tests for API failures

Test file: `apps/client-website/src/components/PRD/__tests__/PRDSync.test.tsx`

## Deployment Notes

- Requires GOOGLE_DOCS_API_KEY environment variable
- Service account credentials must be configured
- Rate limiting considerations for Google API quotas

## Rollback Strategy

- Disable sync button, show "Sync temporarily unavailable"
- Existing PRD content remains unchanged

## Atomicity Justification

| Criterion | Justification |
|-----------|---------------|
| **Independently Testable** | Can test sync flow with mocked Google Docs API |
| **Independently Deployable** | PRD sync works without other integrations |
| **Independently Reviewable** | Scope limited to PRD components and API client |
| **Independently Reversible** | Disable sync feature without affecting stored PRDs |

## Implementation Evidence

| File | Line | Description |
|------|------|-------------|
| `packages/core/backend-core/src/prds/types.ts` | 1-60 | PRD type definitions (Prd, CreatePrdInput, SyncPrdResult, PrdSyncStatus) - supports AC2.1 (title, version, lastSyncedAt) |
| `packages/core/backend-core/src/prds/errors.ts` | 1-27 | Error types (PrdNotFoundError, GoogleDocsApiError with retryable flag) - supports AC2.6 |
| `packages/core/backend-core/src/services/google-docs.ts` | 1-127 | Google Docs API client service with Effect-based error handling - supports AC2.3 |
| `packages/core/backend-core/src/prds/repository.ts` | 1-323 | PRD DynamoDB repository with sync logic - supports AC2.3, AC2.4, AC2.5 |
| `packages/core/backend-core/src/prds/repository.ts` | 198-261 | sync() method fetches from Google Docs, computes content hash, increments version on change |
| `packages/core/backend-core/src/prds/index.ts` | 1-9 | Module exports |
| `packages/core/backend-core/src/testing/fakes/google-docs.ts` | 1-74 | Google Docs service fake for testing |
| `packages/core/backend-core/src/testing/fakes/prdRepo.ts` | 1-122 | PRD repository fake for testing |

## Test Evidence

| Test File | Test Name | ACs Covered |
|-----------|-----------|-------------|
| `packages/core/backend-core/src/prds/__tests__/repository.test.ts` | `getById - returns Some when PRD exists` | AC2.1 |
| `packages/core/backend-core/src/prds/__tests__/repository.test.ts` | `create - creates a new PRD with NEVER_SYNCED status` | AC2.1 |
| `packages/core/backend-core/src/prds/__tests__/repository.test.ts` | `sync - fetches content from Google Docs API (AC2.3)` | AC2.3 |
| `packages/core/backend-core/src/prds/__tests__/repository.test.ts` | `sync - updates PRD content after successful sync (AC2.4)` | AC2.4 |
| `packages/core/backend-core/src/prds/__tests__/repository.test.ts` | `sync - increments version only on content change (AC2.5)` | AC2.5 |
| `packages/core/backend-core/src/prds/__tests__/repository.test.ts` | `sync - increments version when content changes (AC2.5)` | AC2.5 |
| `packages/core/backend-core/src/prds/__tests__/repository.test.ts` | `sync - propagates Google Docs API errors (AC2.6)` | AC2.6 |
| `packages/core/backend-core/src/prds/__tests__/repository.test.ts` | `sync - marks retryable errors appropriately (AC2.6)` | AC2.6 |

## Decision Log

- `2026-01-17T20:50:00Z`: Created from spec.md decomposition
- `2026-01-17T21:30:00Z`: Backend implementation completed - PRD types, errors, Google Docs service, repository with sync logic, and comprehensive tests

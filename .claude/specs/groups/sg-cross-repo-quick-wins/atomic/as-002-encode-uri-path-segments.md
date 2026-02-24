---
id: as-002-encode-uri-path-segments
title: encodeURIComponent on dynamic URL path segments
date: 2026-02-20
spec_group: sg-cross-repo-quick-wins
requirements_refs: [REQ-002]
status: implemented
---

# encodeURIComponent on dynamic URL path segments

## Context

`apps/client-website/src/lib/api/projects.ts` interpolates IDs directly into URL paths without encoding. If an ID contains special characters (`/`, `?`, `#`, `%`), the resulting URL is malformed, enabling path traversal or URL corruption. This was fixed in the ai-eng-dashboard repo (commit `d89d2d4`).

## Goal

Ensure all dynamic path segments in client-side API calls are wrapped in `encodeURIComponent()` to prevent URL corruption and path traversal.

## Description

Wrap all dynamic values interpolated into URL paths in `encodeURIComponent()` across all files in `apps/client-website/src/lib/api/`. Currently only `projects.ts` has dynamic path segments (`fetchProject(id)` interpolates `id` into the URL). The other files (`dashboardAuth.ts`, `login.ts`, `register.ts`) use only static paths and require no changes, but the audit must confirm this.

## Requirements

- **WHEN** a client-side API function constructs a URL with a dynamic path segment
- **THEN** each dynamic segment shall be wrapped in `encodeURIComponent()`
- **AND** IDs containing special characters (`/`, `?`, `#`, `%`) shall be safely encoded

## Acceptance Criteria

- **AC2.1**: `fetchProject(id)` in `projects.ts` wraps `id` in `encodeURIComponent()` before URL interpolation
- **AC2.2**: All other files in `apps/client-website/src/lib/api/` are audited and no other dynamic path segment interpolation exists (currently `dashboardAuth.ts`, `login.ts`, and `register.ts` use static paths only)
- **AC2.3**: IDs containing special characters (`/`, `?`, `#`, `%`) are safely encoded in the URL

## Task List

- [x] T2.1: Wrap `id` parameter in `encodeURIComponent()` in `fetchProject()` in `projects.ts` (AC2.1, AC2.3)
- [x] T2.2: Audit remaining files in `apps/client-website/src/lib/api/` to confirm no other dynamic path segments (AC2.2)

## Test Strategy

- Unit test for `fetchProject('id/with/slashes')`: verify the fetch URL contains `id%2Fwith%2Fslashes`
- Unit test for `fetchProject('a?b#c%d')`: verify the fetch URL contains properly encoded characters
- Code review audit of `dashboardAuth.ts`, `login.ts`, `register.ts` confirming static-only paths

Test file: `apps/client-website/src/lib/api/__tests__/projects.test.ts`

## Deployment Notes

- No runtime behavior change for well-formed IDs (alphanumeric strings encode to themselves)
- Only affects URLs when IDs contain special characters

## Rollback Strategy

- Revert the single-line change in `projects.ts` to remove `encodeURIComponent()` wrapper
- No data changes; purely client-side URL construction

## Atomicity Justification

| Criterion                    | Justification                                                 |
| ---------------------------- | ------------------------------------------------------------- |
| **Independently Testable**   | Can test URL encoding in isolation with special-character IDs |
| **Independently Deployable** | Single file change in client API layer                        |
| **Independently Reviewable** | One-line change plus audit confirmation                       |
| **Independently Reversible** | Remove encodeURIComponent wrapper to revert                   |

## Implementation Evidence

| File                                               | Line | Description                                                          |
| -------------------------------------------------- | ---- | -------------------------------------------------------------------- |
| `apps/client-website/src/lib/api/projects.ts`      | 131  | `fetchProject(id)` wraps id in `encodeURIComponent()` (AC2.1, AC2.3) |
| `apps/client-website/src/lib/api/dashboardAuth.ts` | N/A  | Audit confirmed: static paths only (AC2.2)                           |
| `apps/client-website/src/lib/api/login.ts`         | N/A  | Audit confirmed: static paths only (AC2.2)                           |
| `apps/client-website/src/lib/api/register.ts`      | N/A  | Audit confirmed: static paths only (AC2.2)                           |

## Test Evidence

_To be filled during implementation._

| Test File | Test Name | ACs Covered |
| --------- | --------- | ----------- |

## Decision Log

- `2026-02-20T12:00:00Z`: Created from spec.md decomposition
- `2026-02-20T12:00:00Z`: Audit of API directory confirmed only `projects.ts` has dynamic path segments; `dashboardAuth.ts`, `login.ts`, `register.ts` use static paths only
- `2026-02-23T00:00:00Z`: Implementation complete - projects.ts:131 encodeURIComponent wrapping id param

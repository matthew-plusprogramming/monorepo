---
id: as-001-project-dashboard-overview
title: Project Dashboard Overview
spec_group: sg-ai-eng-dashboard
requirements_refs: [REQ-001]
status: implemented
---

# Project Dashboard Overview

## References

- **Requirements**: REQ-001
- **Parent Spec Section**: spec.md#acceptance-criteria
- **Spec Group**: sg-ai-eng-dashboard

## Description

Implement the main dashboard view that displays all projects as cards with status indicators, spec group counts, and overall health metrics. The view loads on dashboard access and updates in real-time as project states change.

## Acceptance Criteria

- **AC1.1**: Dashboard displays all projects as cards with name and status
- **AC1.2**: Each project card shows spec group count (e.g., "3 spec groups")
- **AC1.3**: Each project card shows health indicator (green/yellow/red based on convergence gates)
- **AC1.4**: Projects load within 3 seconds on initial page load
- **AC1.5**: Status indicators update in real-time without page refresh

## Test Strategy

- Unit tests for ProjectCard component rendering with various states
- Unit tests for health calculation logic
- Integration test for dashboard data fetching
- E2E test for real-time updates via WebSocket

Test file: `apps/client-website/src/components/Dashboard/__tests__/Dashboard.test.tsx`

## Deployment Notes

- Feature can be deployed incrementally (static cards first, then real-time)
- No database migration required if Projects table exists
- Can use feature flag for real-time updates

## Rollback Strategy

- Remove dashboard route, revert to placeholder page
- No data changes, purely UI rollback

## Atomicity Justification

| Criterion | Justification |
|-----------|---------------|
| **Independently Testable** | Can test card rendering and data fetching in isolation |
| **Independently Deployable** | Dashboard view ships without requiring other features |
| **Independently Reviewable** | Scope limited to ProjectCard and Dashboard components |
| **Independently Reversible** | Route change only, no data dependencies |

## Implementation Evidence

| File | Line | Description |
|------|------|-------------|
| `packages/core/backend-core/src/projects/types.ts` | 1-47 | Project and ProjectHealth types (AC1.1, AC1.3) |
| `packages/core/backend-core/src/projects/health.ts` | 1-100 | Health calculation logic (AC1.3) |
| `packages/core/backend-core/src/projects/repository.ts` | 1-240 | ProjectRepository with list/getById (AC1.1, AC1.2) |
| `apps/node-server/src/handlers/projects.handler.ts` | 1-100 | GET /api/projects endpoint (AC1.1, AC1.2, AC1.3) |
| `apps/node-server/src/index.ts` | 96-106 | Projects routes registration |
| `apps/client-website/src/lib/api/projects.ts` | 1-135 | Frontend API client for projects |
| `apps/client-website/src/hooks/useProjects.ts` | 1-90 | React Query hook with polling (AC1.4, AC1.5) |
| `apps/client-website/src/components/Dashboard/ProjectCard.tsx` | 1-140 | ProjectCard component (AC1.1, AC1.2, AC1.3) |
| `apps/client-website/src/components/Dashboard/Dashboard.tsx` | 1-180 | Dashboard component with grid layout |
| `apps/client-website/src/app/dashboard/page.tsx` | 1-35 | Dashboard page (protected route) |

## Test Evidence

| Test File | Test Name | ACs Covered |
|-----------|-----------|-------------|
| `apps/client-website/src/components/Dashboard/__tests__/ProjectCard.test.tsx` | AC1.1: Project name and status display | AC1.1 |
| `apps/client-website/src/components/Dashboard/__tests__/ProjectCard.test.tsx` | AC1.2: Spec group count display | AC1.2 |
| `apps/client-website/src/components/Dashboard/__tests__/ProjectCard.test.tsx` | AC1.3: Health indicator display | AC1.3 |
| `apps/client-website/src/components/Dashboard/__tests__/Dashboard.test.tsx` | AC1.1: Dashboard displays all projects | AC1.1 |
| `apps/client-website/src/components/Dashboard/__tests__/Dashboard.test.tsx` | AC1.2: Each project card shows spec group count | AC1.2 |
| `apps/client-website/src/components/Dashboard/__tests__/Dashboard.test.tsx` | AC1.3: Each project card shows health indicator | AC1.3 |
| `apps/client-website/src/components/Dashboard/__tests__/Dashboard.test.tsx` | AC1.4: Projects load within 3 seconds | AC1.4 |
| `apps/client-website/src/components/Dashboard/__tests__/Dashboard.test.tsx` | AC1.5: Status indicators update in real-time | AC1.5 |
| `packages/core/backend-core/src/projects/__tests__/health.test.ts` | calculateProjectHealth: AC1.3 | AC1.3 |
| `apps/node-server/src/__tests__/handlers/projects.handler.test.ts` | GET /api/projects AC1.1, AC1.2, AC1.3 | AC1.1, AC1.2, AC1.3 |

## Decision Log

- `2026-01-17T20:50:00Z`: Created from spec.md decomposition
- `2026-01-17T22:45:00Z`: Implementation completed with all acceptance criteria met:
  - AC1.1: ProjectCard displays name and status via props
  - AC1.2: Spec group count shown with proper singular/plural formatting
  - AC1.3: Health indicator with green/yellow/red based on convergence gates
  - AC1.4: React Query with staleTime optimization for fast initial load
  - AC1.5: Polling via refetchInterval (default 5s) for real-time updates
- `2026-01-17T23:18:00Z`: All tests passing (53 tests total):
  - backend-core health.test.ts: 14 tests passed
  - client-website Dashboard tests: 34 tests passed
  - node-server handler tests: 5 tests passed
  - TypeScript compilation: No errors in implemented code

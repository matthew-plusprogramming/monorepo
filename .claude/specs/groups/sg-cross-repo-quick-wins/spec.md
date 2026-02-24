---
id: task-cross-repo-quick-wins
title: Cross-Repo Quick Wins from ai-eng-dashboard
date: 2026-02-20
status: implemented
---

# Cross-Repo Quick Wins from ai-eng-dashboard

## Context

Four independently-deployable improvements were identified by analyzing the ai-eng-dashboard repository's commit history. Each addresses a concrete code quality or security issue present in this monorepo. All four are small, low-risk changes that can be implemented and reviewed independently.

## Goal

Port four quick-win improvements from the ai-eng-dashboard repo into this monorepo, improving developer experience (gitignore), security (URL encoding, ID generation), and data integrity (DynamoDB validation).

## Requirements Summary

See `requirements.md` for full EARS-format requirements.

| ID      | Title                                  | Priority  |
| ------- | -------------------------------------- | --------- |
| REQ-001 | Exclude session.json from git tracking | Must Have |
| REQ-002 | URL-encode dynamic path segments       | Must Have |
| REQ-003 | Validate DynamoDB status fields        | Must Have |
| REQ-004 | Use crypto.randomUUID() for IDs        | Must Have |

## Acceptance Criteria

### AS-001: Add session.json to .gitignore (REQ-001)

- **AC1.1**: `.claude/context/session.json` is listed in the root `.gitignore`
- **AC1.2**: Running `git status` no longer shows `session.json` as modified
- **AC1.3**: File is removed from git tracking via `git rm --cached` if currently tracked

### AS-002: encodeURIComponent on dynamic URL path segments (REQ-002)

- **AC2.1**: `fetchProject(id)` in `projects.ts` wraps `id` in `encodeURIComponent()` before URL interpolation
- **AC2.2**: All other files in `apps/client-website/src/lib/api/` are audited and no other dynamic path segment interpolation exists (currently `dashboardAuth.ts`, `login.ts`, and `register.ts` use static paths only)
- **AC2.3**: IDs containing special characters (`/`, `?`, `#`, `%`) are safely encoded in the URL

### AS-003: DynamoDB status field allowlist validation (REQ-003)

- **AC3.1**: `VALID_PROJECT_STATUSES` const array is defined and used in `packages/core/backend-core/src/projects/repository.ts` to validate `item.status?.S` before assignment
- **AC3.2**: Invalid project status values fall back to `'active'`
- **AC3.3**: The `as Project['status']` cast on line 108 of `projects/repository.ts` is replaced with runtime validation
- **AC3.4**: `VALID_SPEC_GROUP_STATES` const array is defined and used in `spec-groups/repository.ts` to validate `item.state?.S` before assignment, including decision log `fromState` (line 110) and `toState` (line 111) fields
- **AC3.5**: `VALID_AGENT_TASK_STATUSES` const array is defined and used in `agent-tasks/repository.ts` to validate `item.status?.S` before assignment
- **AC3.6**: `VALID_PRD_SYNC_STATUSES` const array is defined and used in `prds/repository.ts` to validate `item.syncStatus?.S` before assignment
- **AC3.7**: `VALID_AGENT_TASK_ACTIONS` const array is defined and used in `agent-tasks/repository.ts` to validate `item.action?.S` (line 176) before assignment
- **AC3.8**: `VALID_TASK_PHASES` const array is defined and used in `agent-tasks/repository.ts` to validate phase fields (lines 490, 587) before assignment
- **AC3.9**: `VALID_LOG_LEVELS` const array is defined and used in `agent-tasks/repository.ts` to validate log entry `level` field (line 540) before assignment
- **AC3.10**: All 11 `as` casts on status/state/phase/action/level DynamoDB fields across all four repository files are removed in favor of runtime validation

### AS-004: Use crypto.randomUUID() for ID generation (REQ-004)

- **AC4.1**: `Math.random().toString(36).substring(2, 8)` in `.claude/scripts/session-checkpoint.mjs` is replaced with `crypto.randomUUID()` using the full 36-character UUID (no substring truncation)
- **AC4.2**: `import { randomUUID } from 'node:crypto'` (or `import crypto from 'node:crypto'`) is used, not the global `crypto`
- **AC4.3**: Full audit of `apps/` and `packages/` directories confirms no other `Math.random()` ID generation patterns exist

## Design Notes

### AS-001: Gitignore Change

Straightforward `.gitignore` addition. If the file is currently tracked, run `git rm --cached .claude/context/session.json` to untrack it without deleting the local copy.

### AS-002: URL Encoding

Only `projects.ts` has dynamic path segments among the four API files:

- `fetchProject(id)` interpolates `id` into `` `${getApiUrl()}/api/projects/${id}` ``
- The fix: `` `${getApiUrl()}/api/projects/${encodeURIComponent(id)}` ``

The other three files (`dashboardAuth.ts`, `login.ts`, `register.ts`) use only static URL paths, so no changes are needed there. The audit confirms this is complete.

### AS-003: DynamoDB Validation

Four repository files need allowlist validation across 11 total `as` casts:

1. **projects/repository.ts** (2 casts):
   - Line 108: `as Project['status']` -- replace with `VALID_PROJECT_STATUSES` check
   - Line 65: `as SpecGroup['state']` -- replace with `VALID_SPEC_GROUP_STATES` check
2. **spec-groups/repository.ts** (3 casts):
   - Line 92: `as SpecGroupStateType` -- replace with `VALID_SPEC_GROUP_STATES` check
   - Line 110: `as SpecGroupStateType` (decision log fromState) -- replace with `VALID_SPEC_GROUP_STATES` check
   - Line 111: `as SpecGroupStateType` (decision log toState) -- replace with `VALID_SPEC_GROUP_STATES` check
3. **agent-tasks/repository.ts** (5 casts):
   - Line 142: `as AgentTaskStatusType` -- replace with `VALID_AGENT_TASK_STATUSES` check
   - Line 176: `as AgentTask['action']` -- replace with `VALID_AGENT_TASK_ACTIONS` check
   - Line 490: `as TaskPhaseType` -- replace with `VALID_TASK_PHASES` check
   - Line 540: `as AgentTaskLogEntry['level']` -- replace with `VALID_LOG_LEVELS` check
   - Line 587: `as TaskPhaseType` -- replace with `VALID_TASK_PHASES` check
4. **prds/repository.ts** (1 cast):
   - Line 116: `as PrdSyncStatusType` -- replace with `VALID_PRD_SYNC_STATUSES` check

Each repository already has enum/const objects for valid values (e.g., `SpecGroupState`, `AgentTaskStatus`, `PrdSyncStatus`). The allowlist arrays can be derived from these existing objects.

### AS-004: crypto.randomUUID()

Only one instance of `Math.random().toString(36)` exists in server-side code: `.claude/scripts/session-checkpoint.mjs` line 121. No instances found in `apps/` or `packages/`. The fix replaces it with `crypto.randomUUID()`.

## Task List

### AS-001 Tasks

- [x] T1.1: Add `.claude/context/session.json` to root `.gitignore` (AC1.1)
- [x] T1.2: Run `git rm --cached .claude/context/session.json` if file is tracked (AC1.2, AC1.3)

### AS-002 Tasks

- [x] T2.1: Wrap `id` parameter in `encodeURIComponent()` in `fetchProject()` in `projects.ts` (AC2.1, AC2.3)
- [x] T2.2: Audit remaining files in `apps/client-website/src/lib/api/` to confirm no other dynamic path segments (AC2.2)

### AS-003 Tasks

- [x] T3.1: Add `VALID_PROJECT_STATUSES` array and validation helper to `projects/repository.ts`, replace `as` casts on lines 108 and 65 (AC3.1, AC3.2, AC3.3)
- [x] T3.2: Add `VALID_SPEC_GROUP_STATES` array and validation to `spec-groups/repository.ts`, replace `as` casts on lines 92, 110, and 111 (AC3.4, AC3.10)
- [x] T3.3: Add `VALID_AGENT_TASK_STATUSES`, `VALID_AGENT_TASK_ACTIONS`, `VALID_TASK_PHASES`, and `VALID_LOG_LEVELS` arrays and validation to `agent-tasks/repository.ts`, replace `as` casts on lines 142, 176, 490, 540, and 587 (AC3.5, AC3.7, AC3.8, AC3.9, AC3.10)
- [x] T3.4: Add `VALID_PRD_SYNC_STATUSES` array and validation to `prds/repository.ts`, replace `as` cast on line 116 (AC3.6, AC3.10)

### AS-004 Tasks

- [x] T4.1: Replace `Math.random().toString(36).substring(2, 8)` with `crypto.randomUUID()` in `session-checkpoint.mjs` (AC4.1, AC4.2)
- [x] T4.2: Audit `apps/` and `packages/` for any other `Math.random()` ID patterns (AC4.3)
- [x] T4.3: Add `import { randomUUID } from 'node:crypto'` (or equivalent for .mjs) to the script (AC4.2)

## Test Plan

- AC1.1 -> Manual: verify `.gitignore` contains the entry
- AC1.2 -> Manual: run `git status` and confirm no session.json
- AC1.3 -> Manual: verify `git ls-files .claude/context/session.json` returns empty
- AC2.1 -> Unit test: `fetchProject('id/with/slashes')` produces correctly encoded URL
- AC2.2 -> Code review: audit confirms no other dynamic path interpolation
- AC2.3 -> Unit test: `fetchProject('a?b#c%d')` produces correctly encoded URL
- AC3.1 -> Unit test: `itemToProject` with invalid status returns `'active'` default
- AC3.2 -> Unit test: `itemToProject` with `'invalid-status'` returns `{ status: 'active' }`
- AC3.3 -> Code review: no `as Project['status']` cast remains
- AC3.4 -> Unit test: `itemToSpecGroup` with invalid state returns undefined (field required)
- AC3.5 -> Unit test: `itemToAgentTask` with invalid status returns undefined (field required)
- AC3.6 -> Unit test: `itemToPrd` with invalid syncStatus returns undefined (field required)
- AC3.7 -> Unit test: `itemToAgentTask` with invalid action returns valid default or rejects
- AC3.8 -> Unit test: `itemToAgentTask` with invalid phase returns valid default or rejects
- AC3.9 -> Unit test: agent task log entry with invalid level returns valid default or rejects
- AC3.10 -> Code review: no `as` casts on status/state/phase/action/level fields remain in repository layer (all 11 replaced)
- AC4.1 -> Unit test: generated ID matches UUID v4 format
- AC4.2 -> Code review: import uses `node:crypto` module
- AC4.3 -> Grep audit: no `Math.random()` ID patterns in `apps/` or `packages/`

## Decision & Work Log

- 2026-02-20: Spec created from cross-repo analysis of ai-eng-dashboard commits
- 2026-02-20: All four changes confirmed as independently deployable quick wins
- 2026-02-20: Codebase audit completed -- identified exact locations for all changes
- 2026-02-23: DEC-001 (INC-001 fix) -- AS-003 scope expanded from 5 to 11 `as` casts. Investigation found 6 additional casts on action, phase, and level fields in spec-groups and agent-tasks repositories. ACs expanded from 7 to 10 (added AC3.7-AC3.9 for new field types, renumbered old AC3.7 to AC3.10). Task list updated with specific line numbers.
- 2026-02-23: DEC-002 (INC-002 fix) -- AS-004 AC4.1 updated to specify full 36-character UUID. Removed "or a substring thereof" qualifier. These are ephemeral session IDs with no length constraint.

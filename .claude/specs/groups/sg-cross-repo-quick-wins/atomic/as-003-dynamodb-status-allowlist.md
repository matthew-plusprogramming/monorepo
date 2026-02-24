---
id: as-003-dynamodb-status-allowlist
title: DynamoDB status field allowlist validation
date: 2026-02-20
spec_group: sg-cross-repo-quick-wins
requirements_refs: [REQ-003]
status: implemented
---

# DynamoDB status field allowlist validation

## Context

Multiple repository files in `packages/core/backend-core/src/` use `as` type casts on raw DynamoDB string values for status/state fields (e.g., `item.status?.S as Project['status']`). This bypasses TypeScript's type safety at the data boundary, allowing arbitrary strings from DynamoDB to propagate as typed status values. This was fixed in the ai-eng-dashboard repo (commit `d89d2d4`).

## Goal

Replace all unsafe `as` type casts on DynamoDB status/state/phase/action/level fields with runtime allowlist validation, ensuring only valid values propagate through the type system.

## Description

Add `VALID_*` const arrays derived from existing enum/const objects and validate raw DynamoDB values against them before assignment. Invalid values fall back to a safe default (for optional fields) or cause the record to be skipped (for required fields). This applies to four repository files with a total of 11 `as` casts:

1. `projects/repository.ts` (2 casts):
   - Line 108: `as Project['status']` (project status)
   - Line 65: `as SpecGroup['state']` (spec group state embedded in project)
2. `spec-groups/repository.ts` (3 casts):
   - Line 92: `as SpecGroupStateType` (spec group state)
   - Line 110: `as SpecGroupStateType` (decision log fromState)
   - Line 111: `as SpecGroupStateType` (decision log toState)
3. `agent-tasks/repository.ts` (5 casts):
   - Line 142: `as AgentTaskStatusType` (task status)
   - Line 176: `as AgentTask['action']` (task action)
   - Line 490: `as TaskPhaseType` (task phase)
   - Line 540: `as AgentTaskLogEntry['level']` (log entry level)
   - Line 587: `as TaskPhaseType` (task phase in second mapping function)
4. `prds/repository.ts` (1 cast):
   - Line 116: `as PrdSyncStatusType` (PRD sync status)

## Requirements

- **WHEN** a repository function reads a status, state, phase, action, or level field from DynamoDB
- **THEN** the raw value shall be validated against a const allowlist array
- **AND** invalid values shall fall back to a safe default or cause record rejection
- **AND** the `as` type cast shall be removed in favor of runtime validation
- **AND** this applies to all 11 identified `as` casts across the four repository files

## Acceptance Criteria

- **AC3.1**: `VALID_PROJECT_STATUSES` const array is defined and used in `projects/repository.ts` to validate `item.status?.S` before assignment
- **AC3.2**: Invalid project status values fall back to `'active'`
- **AC3.3**: The `as Project['status']` cast on line 108 of `projects/repository.ts` is replaced with runtime validation
- **AC3.4**: `VALID_SPEC_GROUP_STATES` const array is defined and used in `spec-groups/repository.ts` to validate `item.state?.S` before assignment, including decision log `fromState` (line 110) and `toState` (line 111) fields
- **AC3.5**: `VALID_AGENT_TASK_STATUSES` const array is defined and used in `agent-tasks/repository.ts` to validate `item.status?.S` before assignment
- **AC3.6**: `VALID_PRD_SYNC_STATUSES` const array is defined and used in `prds/repository.ts` to validate `item.syncStatus?.S` before assignment
- **AC3.7**: `VALID_AGENT_TASK_ACTIONS` const array is defined and used in `agent-tasks/repository.ts` to validate `item.action?.S` (line 176) before assignment
- **AC3.8**: `VALID_TASK_PHASES` const array is defined and used in `agent-tasks/repository.ts` to validate phase fields (lines 490, 587) before assignment
- **AC3.9**: `VALID_LOG_LEVELS` const array is defined and used in `agent-tasks/repository.ts` to validate log entry `level` field (line 540) before assignment
- **AC3.10**: All 11 `as` casts on status/state/phase/action/level DynamoDB fields across all four repository files are removed in favor of runtime validation

## Task List

- [x] T3.1: Add `VALID_PROJECT_STATUSES` array and validation helper to `projects/repository.ts`, replace `as Project['status']` cast on line 108 and `as SpecGroup['state']` cast on line 65 (AC3.1, AC3.2, AC3.3)
- [x] T3.2: Add `VALID_SPEC_GROUP_STATES` array and validation to `spec-groups/repository.ts`, replace `as SpecGroupStateType` casts on lines 92, 110, and 111 (AC3.4, AC3.10)
- [x] T3.3: Add `VALID_AGENT_TASK_STATUSES`, `VALID_AGENT_TASK_ACTIONS`, `VALID_TASK_PHASES`, and `VALID_LOG_LEVELS` arrays and validation to `agent-tasks/repository.ts`, replace `as` casts on lines 142, 176, 490, 540, and 587 (AC3.5, AC3.7, AC3.8, AC3.9, AC3.10)
- [x] T3.4: Add `VALID_PRD_SYNC_STATUSES` array and validation to `prds/repository.ts`, replace `as` cast on line 116 (AC3.6, AC3.10)

## Test Strategy

Per repository file:

- Unit test: pass valid status/state/phase/action/level string, confirm correct typed value returned
- Unit test: pass invalid string for each field type, confirm fallback to default (for optional fields like Project status) or record rejection (for required fields like SpecGroup state)
- Unit test: pass undefined/null, confirm existing undefined-handling behavior preserved
- Unit test for agent-tasks: validate action, phase, and level fields separately with valid and invalid values
- Unit test for spec-groups: validate decision log fromState/toState fields with valid and invalid values
- Code review: confirm no `as` casts remain on status/state/phase/action/level fields across all four repository files (all 11 casts replaced)

Test files:

- `packages/core/backend-core/src/projects/__tests__/repository.test.ts`
- `packages/core/backend-core/src/spec-groups/__tests__/repository.test.ts`
- `packages/core/backend-core/src/agent-tasks/__tests__/repository.test.ts`
- `packages/core/backend-core/src/prds/__tests__/repository.test.ts`

## Deployment Notes

- No database migration required; this is a read-path validation change
- Existing valid data is unaffected (valid values pass the allowlist check)
- Invalid data that previously slipped through will now be caught and defaulted

## Rollback Strategy

- Revert the validation logic and restore `as` casts in each repository file
- No data changes; purely read-path logic

## Atomicity Justification

| Criterion                    | Justification                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| **Independently Testable**   | Each repository's validation can be tested in isolation with mock DynamoDB items   |
| **Independently Deployable** | Read-path changes only; no schema or data migration needed                         |
| **Independently Reviewable** | Pattern is consistent across files; reviewer checks one pattern applied four times |
| **Independently Reversible** | Revert to `as` casts; no persistent state changes                                  |

## Implementation Evidence

| File                                                       | Line    | Description                                                                                |
| ---------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `packages/core/backend-core/src/projects/repository.ts`    | 63-65   | `VALID_PROJECT_STATUSES` array defined (AC3.1)                                             |
| `packages/core/backend-core/src/projects/repository.ts`    | 73-77   | `VALID_SPEC_GROUP_STATES` array defined (AC3.4)                                            |
| `packages/core/backend-core/src/projects/repository.ts`    | 89-90   | SpecGroup state validated via `includes()` (AC3.4)                                         |
| `packages/core/backend-core/src/projects/repository.ts`    | 134-135 | Project status validated, falls back to `'active'` (AC3.2, AC3.3)                          |
| `packages/core/backend-core/src/spec-groups/repository.ts` | 33-39   | `VALID_SPEC_GROUP_STATES` array defined (AC3.4)                                            |
| `packages/core/backend-core/src/spec-groups/repository.ts` | 102-103 | State validated via `includes()` (AC3.4)                                                   |
| `packages/core/backend-core/src/spec-groups/repository.ts` | 122-131 | Decision log fromState/toState validated (AC3.4)                                           |
| `packages/core/backend-core/src/agent-tasks/repository.ts` | 39-68   | 4 allowlist arrays defined: statuses, actions, phases, levels (AC3.5, AC3.7, AC3.8, AC3.9) |
| `packages/core/backend-core/src/agent-tasks/repository.ts` | 186-187 | Status validated via `includes()` (AC3.5)                                                  |
| `packages/core/backend-core/src/agent-tasks/repository.ts` | 219-221 | Action validated with default (AC3.7)                                                      |
| `packages/core/backend-core/src/agent-tasks/repository.ts` | 543-547 | Phase validated in updateRealtimeStatus (AC3.8)                                            |
| `packages/core/backend-core/src/agent-tasks/repository.ts` | 599-603 | Log level validated with `'info'` default (AC3.9)                                          |
| `packages/core/backend-core/src/agent-tasks/repository.ts` | 644     | Phase validated in getRealtimeStatus (AC3.8)                                               |
| `packages/core/backend-core/src/prds/repository.ts`        | 36-41   | `VALID_PRD_SYNC_STATUSES` array defined (AC3.6)                                            |
| `packages/core/backend-core/src/prds/repository.ts`        | 135-136 | Sync status validated via `includes()` (AC3.6)                                             |

## Test Evidence

_To be filled during implementation._

| Test File | Test Name | ACs Covered |
| --------- | --------- | ----------- |

## Decision Log

- `2026-02-20T12:00:00Z`: Created from spec.md decomposition
- `2026-02-20T12:00:00Z`: Codebase audit identified 5 `as` casts across 4 repository files: projects (2), spec-groups (1), agent-tasks (1), prds (1)
- `2026-02-20T12:00:00Z`: Decision -- for Project status (optional field with ?? fallback), invalid values fall back to 'active'. For required state/status fields (SpecGroup, AgentTask, Prd), invalid values cause the record to return undefined (same as missing required fields)
- `2026-02-23T00:00:00Z`: DEC-001 (INC-001 fix) -- Investigation found 6 additional `as` casts on DynamoDB-sourced fields: spec-groups/repository.ts lines 110-111 (decision log fromState/toState), agent-tasks/repository.ts lines 176 (action), 490 (phase), 540 (level), 587 (phase). Total expanded from 5 to 11 casts. ACs expanded from 7 to 10 to cover action, phase, and level field types. Scope expanded to honor AC3.10's "all `as` casts" text.
- `2026-02-23T00:00:00Z`: Implementation complete - all 11 bare `as` casts replaced with runtime validation across 4 repository files

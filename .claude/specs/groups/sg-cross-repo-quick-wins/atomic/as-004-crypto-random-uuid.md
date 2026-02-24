---
id: as-004-crypto-random-uuid
title: Use crypto.randomUUID() for ID generation
date: 2026-02-20
spec_group: sg-cross-repo-quick-wins
requirements_refs: [REQ-004]
status: implemented
---

# Use crypto.randomUUID() for ID generation

## Context

`.claude/scripts/session-checkpoint.mjs` uses `Math.random().toString(36).substring(2, 8)` for generating IDs. `Math.random()` is not cryptographically secure and produces short (6-char), predictable values. This was fixed in the ai-eng-dashboard repo (commit `939099f`).

## Goal

Replace all `Math.random()` based ID generation in server-side code with `crypto.randomUUID()` from the `node:crypto` module.

## Description

Replace the `Math.random().toString(36).substring(2, 8)` pattern in `.claude/scripts/session-checkpoint.mjs` (line 121) with `crypto.randomUUID()`. A full audit of `apps/` and `packages/` directories confirms no other instances of this pattern exist in the codebase. Client-side code is not affected.

## Requirements

- **WHEN** server-side code generates a unique identifier
- **THEN** it shall use `randomUUID` imported from `node:crypto`
- **AND** `Math.random()` based ID generation patterns shall not exist in server-side code

## Acceptance Criteria

- **AC4.1**: `Math.random().toString(36).substring(2, 8)` in `.claude/scripts/session-checkpoint.mjs` is replaced with `crypto.randomUUID()` using the full 36-character UUID (no substring truncation)
- **AC4.2**: `import { randomUUID } from 'node:crypto'` (or `import crypto from 'node:crypto'`) is used, not the global `crypto`
- **AC4.3**: Full audit of `apps/` and `packages/` directories confirms no other `Math.random()` ID generation patterns exist

## Task List

- [x] T4.1: Replace `Math.random().toString(36).substring(2, 8)` with `crypto.randomUUID()` in `session-checkpoint.mjs` (AC4.1)
- [x] T4.2: Add `import { randomUUID } from 'node:crypto'` (or equivalent for .mjs) to the script (AC4.2)
- [x] T4.3: Audit `apps/` and `packages/` for any other `Math.random()` ID patterns and document findings (AC4.3)

## Test Strategy

- Unit test: generated ID matches UUID v4 format (`/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`)
- Code review: verify import uses `node:crypto` module, not global `crypto`
- Grep audit: `rg 'Math\.random' apps/ packages/` returns no matches for ID generation patterns

Test file: `.claude/scripts/__tests__/session-checkpoint.test.mjs` (or manual verification)

## Deployment Notes

- Generated IDs will be full 36-character UUIDs (vs previous 6-char random strings). These are ephemeral session IDs with no length constraint, so full UUID is appropriate.
- The `.claude/scripts/` directory is dev tooling only, not production code, so deployment risk is minimal.

## Rollback Strategy

- Revert the import and replace `crypto.randomUUID()` with the original `Math.random().toString(36).substring(2, 8)` pattern
- No persistent data format changes (IDs are ephemeral session identifiers)

## Atomicity Justification

| Criterion                    | Justification                                           |
| ---------------------------- | ------------------------------------------------------- |
| **Independently Testable**   | Can verify UUID format of generated IDs in isolation    |
| **Independently Deployable** | Single script file change; no cross-module dependencies |
| **Independently Reviewable** | One import addition and one line replacement            |
| **Independently Reversible** | Revert to Math.random pattern; no data migration needed |

## Implementation Evidence

| File                                     | Line | Description                                              |
| ---------------------------------------- | ---- | -------------------------------------------------------- |
| `.claude/scripts/session-checkpoint.mjs` | 29   | `import { randomUUID } from 'node:crypto'` added (AC4.2) |
| `.claude/scripts/session-checkpoint.mjs` | 121  | `generateTaskId()` uses `randomUUID()` full UUID (AC4.1) |
| `apps/`                                  | N/A  | Audit: no `Math.random()` ID patterns found (AC4.3)      |
| `packages/`                              | N/A  | Audit: no `Math.random()` ID patterns found (AC4.3)      |

## Test Evidence

_To be filled during implementation._

| Test File | Test Name | ACs Covered |
| --------- | --------- | ----------- |

## Decision Log

- `2026-02-20T12:00:00Z`: Created from spec.md decomposition
- `2026-02-20T12:00:00Z`: Grep audit confirmed only one instance of `Math.random()` ID generation in server-side code: `.claude/scripts/session-checkpoint.mjs` line 121. No instances in `apps/` or `packages/`.
- `2026-02-23T00:00:00Z`: DEC-002 (INC-002 fix) -- Use full 36-character UUID; removed "or a substring thereof" qualifier. These are ephemeral session IDs with no length constraint, so full UUID simplifies implementation and removes ambiguity.
- `2026-02-23T00:00:00Z`: Implementation complete - randomUUID import added, Math.random replaced, audit confirmed no other instances

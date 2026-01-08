---
id: task-agentic-system-restoration
title: Agentic System Restoration
date: 2026-01-07
status: complete
implementation_status: complete
---

# Agentic System Restoration

## Context

The monorepo underwent a migration from `agents/` to `.claude/` directory structure (commit 53a279d). While the new structure provides better Claude Code integration with native skills and subagents, valuable documentation and automation was lost:

- **OPERATOR-GUIDE.md**: 285-line human operator documentation with workflow decision tree and operational insights
- **Memory Bank System**: Persistent project knowledge (`project.brief.md`, `tech.context.md`, `testing.guidelines.md`, best practices library)
- **Automation Scripts**: `spec-validate.mjs`, `reset-active-context.mjs`, `load-context.mjs`, `manage-worktrees.mjs`
- **Contract Registry**: Ownership tracking for multi-workstream contracts

A recovery report with full file contents exists at `.claude/specs/active/recovery-report.md`.

## Goal

Restore the highest-value components from the old system into the new `.claude/` structure while avoiding redundancy and maintenance burden. The restored system should support frequent orchestrator workflow usage and be understandable by both Claude and human operators.

## Requirements (EARS Format)

### Condensed Operator Guide

- **WHEN** a human operator needs to understand the agentic workflow system
- **THEN** the system shall provide a condensed guide at `.claude/OPERATOR-GUIDE.md`
- **AND** the guide shall include a workflow decision tree (orchestrator vs oneoff-spec vs oneoff-vibe)
- **AND** the guide shall include all 10 "Nuances & Gotchas" operational insights
- **AND** the guide shall be under 80 lines to minimize maintenance drift

### Memory Bank System

- **WHEN** Claude or a human needs project context
- **THEN** the system shall provide a memory bank at `.claude/memory-bank/`
- **AND** the memory bank shall include `project.brief.md` with project overview
- **AND** the memory bank shall include `tech.context.md` with technical stack documentation
- **AND** the memory bank shall include `testing.guidelines.md` with testing patterns
- **AND** the memory bank shall include `best-practices/` directory with domain-specific guidance
- **AND** `CLAUDE.md` shall include a retrieval policy documenting when to load each file

### Automation Scripts

- **WHEN** a user creates a new task spec
- **THEN** `reset-active-context.mjs` shall scaffold a new spec from template
- **AND** the script shall be located at `.claude/scripts/reset-active-context.mjs`

- **WHEN** a user validates a spec
- **THEN** `spec-validate.mjs` shall check spec compliance against schemas
- **AND** the script shall be located at `.claude/scripts/spec-validate.mjs`

- **WHEN** a user needs to load context files
- **THEN** `load-context.mjs` shall load specified files with line numbers
- **AND** the script shall be located at `.claude/scripts/load-context.mjs`

- **WHEN** a user manages git worktrees for orchestrator workflow
- **THEN** `manage-worktrees.mjs` shall list, create, and cleanup worktrees
- **AND** the script shall be located at `.claude/scripts/manage-worktrees.mjs`

### Contract Registry

- **WHEN** multiple workstreams share interfaces
- **THEN** the system shall track contract ownership in `.claude/contracts/registry.yaml`
- **AND** the registry shall include contract ID, type, owner workstream, and file path
- **AND** the registry shall NOT include versioning (lightweight approach)

### Cleanup

- **WHEN** the restoration is complete
- **THEN** duplicate scripts in `agents/scripts/` shall be removed
- **AND** `sync-worktree-env-keys.mjs` shall be moved to `.claude/scripts/` or documented
- **AND** the `agents/` directory shall be removed if empty

## Acceptance Criteria

### Operator Guide (AC1)

- AC1.1: `.claude/OPERATOR-GUIDE.md` exists with workflow decision tree
- AC1.2: All 10 "Nuances & Gotchas" are included verbatim or adapted
- AC1.3: Guide is under 80 lines total
- AC1.4: Guide references skills (`/route`, `/spec`, `/implement`) not old workflow files

### Memory Bank (AC2)

- AC2.1: `.claude/memory-bank/project.brief.md` exists with project overview
- AC2.2: `.claude/memory-bank/tech.context.md` exists with tech stack (TypeScript, Effect-ts, Turborepo, CDK)
- AC2.3: `.claude/memory-bank/testing.guidelines.md` exists with testing patterns
- AC2.4: `.claude/memory-bank/best-practices/` contains at least `typescript.md` and `software-principles.md`
- AC2.5: `CLAUDE.md` includes retrieval policy section documenting when to load each memory bank file

### Automation Scripts (AC3)

- AC3.1: `.claude/scripts/reset-active-context.mjs` creates new spec from template
- AC3.2: `.claude/scripts/spec-validate.mjs` validates specs against JSON schemas
- AC3.3: `.claude/scripts/load-context.mjs` loads files with line numbers
- AC3.4: `.claude/scripts/manage-worktrees.mjs` supports list/create/cleanup operations
- AC3.5: All scripts use new `.claude/` paths (not old `agents/` paths)

### Contract Registry (AC4)

- AC4.1: `.claude/contracts/registry.yaml` exists with lightweight structure
- AC4.2: Registry includes: id, type, owner, path fields (no version field)
- AC4.3: Example contract entry is included

### Cleanup (AC5)

- AC5.1: `agents/scripts/check-*.mjs` duplicates are removed (already in `.claude/scripts/`)
- AC5.2: `agents/scripts/sync-worktree-env-keys.mjs` is moved to `.claude/scripts/`
- AC5.3: `agents/` directory is removed or only contains intentionally preserved files

## Design Notes

### File Structure After Restoration

```
.claude/
├── OPERATOR-GUIDE.md           # NEW: Condensed operator guide (~80 lines)
├── contracts/
│   └── registry.yaml           # NEW: Lightweight contract registry
├── memory-bank/                # NEW: Persistent knowledge base
│   ├── project.brief.md
│   ├── tech.context.md
│   ├── testing.guidelines.md
│   └── best-practices/
│       ├── typescript.md
│       └── software-principles.md
├── scripts/
│   ├── check-*.mjs             # EXISTING: Quality checks
│   ├── reset-active-context.mjs # NEW: Spec scaffolding
│   ├── spec-validate.mjs       # NEW: Spec validation
│   ├── load-context.mjs        # NEW: Context loading
│   ├── manage-worktrees.mjs    # NEW: Worktree management
│   └── sync-worktree-env-keys.mjs # MOVED: From agents/scripts/
├── agents/                     # EXISTING
├── skills/                     # EXISTING
├── specs/                      # EXISTING
└── templates/                  # EXISTING
```

### Script Adaptations Required

Scripts from old system need path updates:

- `agents/specs/` → `.claude/specs/`
- `agents/memory-bank/` → `.claude/memory-bank/`
- `agents/contracts/` → `.claude/contracts/`
- `agents/scripts/` → `.claude/scripts/`

### Retrieval Policy (for CLAUDE.md)

```markdown
## Memory Bank Retrieval Policy

| File                                    | Load When                                         |
| --------------------------------------- | ------------------------------------------------- |
| `project.brief.md`                      | Starting new major feature, onboarding            |
| `tech.context.md`                       | Making architectural decisions, choosing patterns |
| `testing.guidelines.md`                 | Writing tests, reviewing test coverage            |
| `best-practices/typescript.md`          | TypeScript-specific implementation questions      |
| `best-practices/software-principles.md` | Design pattern decisions                          |
```

## Task List

- [x] **T1**: Create condensed `.claude/OPERATOR-GUIDE.md` with decision tree and gotchas
- [x] **T2**: Create `.claude/memory-bank/` directory structure
- [x] **T3**: Restore `project.brief.md` adapted for current project state
- [x] **T4**: Restore `tech.context.md` with current tech stack
- [x] **T5**: Restore `testing.guidelines.md` with testing patterns
- [x] **T6**: Restore `best-practices/` directory with key files
- [x] **T7**: Add retrieval policy section to `CLAUDE.md`
- [x] **T8**: Restore and adapt `reset-active-context.mjs` to `.claude/scripts/`
- [x] **T9**: Restore and adapt `spec-validate.mjs` to `.claude/scripts/`
- [x] **T10**: Restore and adapt `load-context.mjs` to `.claude/scripts/`
- [x] **T11**: Restore and adapt `manage-worktrees.mjs` to `.claude/scripts/`
- [x] **T12**: Create `.claude/contracts/registry.yaml` with lightweight structure
- [x] **T13**: Move `sync-worktree-env-keys.mjs` from `agents/scripts/` to `.claude/scripts/`
- [x] **T14**: Remove duplicate `check-*.mjs` scripts from `agents/scripts/`
- [x] **T15**: Remove empty `agents/` directory (or document what remains)
- [x] **T16**: Run `npm run phase:check` to verify no regressions

## Test Plan

This is primarily a documentation and tooling restoration task. Verification is manual:

- AC1.1-1.4 → Manual review: OPERATOR-GUIDE.md exists, contains decision tree, contains gotchas, under 80 lines, references skills
- AC2.1-2.4 → Manual review: Memory bank files exist with expected content
- AC2.5 → Manual review: CLAUDE.md includes retrieval policy
- AC3.1 → Run: `node .claude/scripts/reset-active-context.mjs --help` succeeds
- AC3.2 → Run: `node .claude/scripts/spec-validate.mjs .claude/specs/active/*.md` succeeds
- AC3.3 → Run: `node .claude/scripts/load-context.mjs .claude/memory-bank/project.brief.md` outputs with line numbers
- AC3.4 → Run: `node .claude/scripts/manage-worktrees.mjs list` succeeds
- AC3.5 → Grep: No references to `agents/` paths in `.claude/scripts/*.mjs`
- AC4.1-4.3 → Manual review: registry.yaml exists with correct structure
- AC5.1-5.3 → Verify: `agents/` directory is removed or empty

## Decision & Work Log

- 2026-01-07: Spec created based on facilitated trade-off discussion
- 2026-01-07: Decision - Option B for OPERATOR-GUIDE (condensed, ~80 lines)
- 2026-01-07: Decision - Full restore for Memory Bank System
- 2026-01-07: Decision - Restore 4 key automation scripts (spec-validate, reset-active-context, load-context, manage-worktrees)
- 2026-01-07: Decision - Option B for Contract Registry (lightweight, no versioning)
- 2026-01-07: Decision - Do NOT restore Workflow Index (redundant with /route skill)
- 2026-01-07: Recovery report created at `.claude/specs/active/recovery-report.md`

## Execution Log

- 2026-01-07 14:45: T12 complete - Created `.claude/contracts/registry.yaml`
  - File: `/Users/matthewlin/workspace/monorepo/.claude/contracts/registry.yaml`
  - Structure: Lightweight YAML with no version field
- 2026-01-07 18:37: T2-T7 complete - Memory Bank System restored
  - T2: Created `.claude/memory-bank/` and `.claude/memory-bank/best-practices/` directories
  - T3: Created `project.brief.md` with project overview, goals, success criteria
  - T4: Created `tech.context.md` with stacks, entrypoints, codebase map, task recipes
  - T5: Created `testing.guidelines.md` with boundaries, mocking rules, AAA convention
  - T6: Created `best-practices/typescript.md` and `best-practices/software-principles.md`
  - T7: Added retrieval policy table to `CLAUDE.md` after Conventions section
  - All files adapted for `.claude/` paths (not old `agents/` paths)
  - Evidence: Files exist at expected locations with appropriate content
  - Fields: id, type, owner, path
  - Example entry: example-api-contract (api type, ws-example owner)
  - AC4.1: Registry exists with lightweight structure ✓
  - AC4.2: Registry includes id, type, owner, path fields (no version) ✓
  - AC4.3: Example contract entry included ✓
- 2026-01-08: All tasks complete - Implementation verified during PR review
  - T1: OPERATOR-GUIDE.md exists at 65 lines with decision tree and gotchas
  - T8-T11: All automation scripts restored and adapted to `.claude/scripts/`
  - T13: `sync-worktree-env-keys.mjs` moved to `.claude/scripts/`
  - T14-T15: Old `agents/` directory cleanup complete
  - T16: Phase check verified (package.json scripts updated to use `.claude/` paths)
  - All acceptance criteria verified during PR #25 review
  - Status updated to complete

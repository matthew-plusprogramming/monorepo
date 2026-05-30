---
name: implement
description: Implement code changes from approved spec.md. Work from acceptance criteria, task list, and optional spec slices; escalate when implementation reveals a spec gap.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Task
user-invocable: true
---

# Implementation Skill

## Required Context

Before beginning work, read:

- `.claude/memory-bank/best-practices/subagent-design.md`

## Pre-Flight Challenge

Before editing, check:

1. Required environment variables, services, databases, APIs, and tools exist.
2. The target test command is known and runnable.
3. The approved spec has no blocking open questions.

If any answer is unknown, surface it as a finding before implementation.

## Purpose

Implement the approved `spec.md` with traceability from requirement to acceptance criterion to code and tests.

**Key input**: `.claude/specs/groups/<spec-group-id>/spec.md`

## Usage

```text
/implement <spec-group-id>
/implement <spec-group-id> --slice <slice-id>
/implement <spec-group-id> --parallel
```

Use `--parallel` only when the spec names independent slices and their write sets do not overlap.
When the approved spec contains cross-boundary contracts, dispatch the
implementation, unit/integration test writing, and `e2e-test-writer` as a
three-way parallel stream when their write sets are independent.

## Prerequisites

Verify:

1. `.claude/specs/groups/<spec-group-id>/manifest.json` exists.
2. `manifest.json.review_state` is `APPROVED`.
3. `spec.md` exists and contains acceptance criteria plus a task list.
4. Blocking open questions are resolved or explicitly deferred.

## Process

### Step 1: Load Contract

Read `requirements.md`, `spec.md`, and `manifest.json`.

Extract:

- Acceptance criteria
- Task list
- Optional `## Spec Slices`
- Contracts and boundary definitions
- Test plan
- Open questions and decisions

### Step 2: Build Work Queue

Use the task list as the primary queue. If `## Spec Slices` exists, use it only to group independent work and dependency order.

Rules:

- Preserve dependency order.
- Keep implementation within the approved spec scope.
- Do not create decomposed spec files.
- If the spec is wrong or incomplete, propose a spec amendment before implementing the divergent behavior.

### Step 3: Implement

For each task or slice:

1. Inspect existing patterns before editing.
2. Make the smallest change that satisfies the relevant ACs.
3. Keep public contracts aligned with `spec.md`.
4. Update implementation evidence in `spec.md` when useful for review.
5. Run targeted validation as soon as a slice is complete.
6. Keep `test-writer` and `e2e-test-writer` as parallel spec-only peers; do not feed implementation details to them.

### Step 4: Report

Return:

- Files changed
- ACs implemented
- Tests or checks run
- Any spec gaps, deferred items, or residual risk

## Spec Is Contract

Implementation must conform to `spec.md`. Silent divergence is not allowed. If reality contradicts the spec, update the spec through the normal approval path before proceeding.

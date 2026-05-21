---
name: test
description: Write tests from approved spec.md. Map each acceptance criterion to deterministic tests and keep tests independent from implementation details.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: true
---

# Test Writing Skill

## Pre-Flight Challenge

Before writing tests, check:

1. The test runner and assertion library are installed.
2. Required fixtures, seed data, env vars, mock services, and ports are available or creatable.
3. The baseline test command is known.

If any answer is unknown, surface it as a finding before writing tests.

## Purpose

Write executable validation for `spec.md`. Tests verify behavior and contracts, not implementation details.

**Key input**: `.claude/specs/groups/<spec-group-id>/spec.md`

## Usage

```text
/test <spec-group-id>
/test <spec-group-id> --slice <slice-id>
/test <spec-group-id> --parallel
```

Use `--parallel` only for independent spec slices with separate test files or fixtures.

## Prerequisites

Verify:

1. `.claude/specs/groups/<spec-group-id>/manifest.json` exists.
2. `manifest.json.review_state` is `APPROVED`.
3. `spec.md` contains acceptance criteria and a test plan.
4. Blocking open questions are resolved or explicitly deferred.

## Process

### Step 1: Map ACs

Read `spec.md` and build a compact map:

```markdown
| AC | Test File | Test Case | Status |
| -- | --------- | --------- | ------ |
| AC1.1 | auth-service.test.ts | clears token on logout | planned |
```

Every AC needs at least one test unless the spec explicitly explains why it is covered by another AC or is not executable.

### Step 2: Write Tests

For each AC:

1. Prefer the existing test style and fixture pattern.
2. Use Arrange / Act / Assert structure.
3. Name tests with the AC id.
4. Cover failure paths and edge cases from the spec.
5. Avoid asserting private implementation details.

### Step 3: Validate

Run the narrowest useful test command first, then broader tests when the change affects shared behavior.

### Step 4: Report

Return:

- Test files changed
- AC coverage map
- Commands run and results
- Any ACs not covered, with reason

## Isolation

The test-writer works from specs and contracts. Do not depend on implementation internals unless the spec explicitly defines them as the observable contract.

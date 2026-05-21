---
name: unify
description: Validate spec-implementation-test convergence for a spec group. Checks spec completeness, AC coverage, implementation evidence, test evidence, contracts, and traceability.
allowed-tools: Read, Glob, Grep, Bash, Task
user-invocable: true
---

# Unify Skill

## Required Context

Before beginning work, read these files for project-specific guidelines:

- `.claude/memory-bank/best-practices/spec-authoring.md`
- `.claude/memory-bank/testing.guidelines.md`

## Purpose

Validate that implementation and tests conform to the approved `spec.md`.

## Usage

```text
/unify <spec-group-id>
/unify <spec-group-id> --quick
```

## Convergence Criteria

A spec group is converged when:

1. Requirements are complete and referenced from `spec.md`.
2. `spec.md` has acceptance criteria, task list, test plan, and decisions.
3. Each AC maps to implementation evidence or a documented non-code rationale.
4. Each AC maps to test evidence or an explicit, approved opt-out.
5. Tests pass at the appropriate scope.
6. Contracts and boundary definitions match the implementation and tests.
7. Runtime validation requirements are satisfied when `runtime_validation_required: true`.

## Process

### Step 1: Load Spec Group

Read:

- `.claude/specs/groups/<spec-group-id>/manifest.json`
- `.claude/specs/groups/<spec-group-id>/requirements.md`
- `.claude/specs/groups/<spec-group-id>/spec.md`

Verify:

- `review_state` is `APPROVED`
- `work_state` is `VERIFYING` or later
- No blocking open questions remain

### Step 2: Preflight Advisories

Run lightweight checks for:

- AC-to-test coverage
- Test-file placement
- Mock-vs-real mismatches where the spec requires real integration
- Missing implementation evidence

Advisory findings should be surfaced in the convergence report. Medium+ issues should be fixed or explicitly accepted before proceeding.

### Step 3: Traceability

Build a compact trace:

```markdown
| Requirement | AC | Implementation Evidence | Test Evidence | Status |
| ----------- | -- | ----------------------- | ------------- | ------ |
| REQ-001 | AC1.1 | src/auth.ts | auth.test.ts | pass |
```

### Step 4: Contracts

For each contract or boundary in `spec.md`, verify:

- Data shapes match implementation.
- Error behavior matches tests.
- Security and auth requirements are covered.
- Breaking changes are called out in the Decision & Work Log.

### Step 5: Result

If converged, record the unifier pass through the normal convergence path.

If not converged, return:

- Blocking findings ordered by severity
- Missing AC coverage
- Failing tests
- Required spec amendments
- Next recommended command (`/implement`, `/test`, `/spec refine`, or `/manual-test`)

## Output Shape

```markdown
## Unify Result

Status: CONVERGED | NOT CONVERGED
Spec Group: <spec-group-id>
AC Coverage: <covered>/<total>
Tests: <command + result>
Contracts: pass | fail | n/a

Findings:
- <severity>: <issue> (<evidence>)

Next Action:
- <command or none>
```

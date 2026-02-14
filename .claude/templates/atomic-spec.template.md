---
id: as-000-<slug>
title: <Atomic Spec Title>
spec_group: sg-<parent-group>
requirements_refs: [REQ-001]
status: pending

# Supersession Metadata (optional - set when this spec is superseded)
# status: superseded                        # Set to 'superseded' when replaced by newer spec
# superseded_by: <spec-group-id>            # ID of the spec group that supersedes this one
# supersession_date: <YYYY-MM-DD>           # Date when supersession occurred
# supersession_reason: "<explanation>"      # Brief explanation of why spec was superseded
---

# <Title>

## References

- **Requirements**: REQ-001, REQ-002
- **Parent Spec Section**: spec.md#<section-anchor>
- **Spec Group**: sg-<parent-group>

## Description

<Single testable behavior. One paragraph max. If you need more, this spec may need splitting.>

## Acceptance Criteria

- **AC1.1**: <Testable criterion>
- **AC1.2**: <Testable criterion>

## Test Strategy

<How this will be tested in isolation. What test file? What approach?>

## Deployment Notes

<Any considerations for deploying this unit alone. Feature flags? Migration steps?>

## Rollback Strategy

<How to reverse this change safely without affecting other atomic specs.>

## Atomicity Justification

| Criterion                    | Justification                                                |
| ---------------------------- | ------------------------------------------------------------ |
| **Independently Testable**   | <Why you can write a test for just this>                     |
| **Independently Deployable** | <Why this can ship alone>                                    |
| **Independently Reviewable** | <Why a reviewer can understand this without sibling context> |
| **Independently Reversible** | <Why you can roll back just this>                            |

## Pre-Implementation Evidence Table

_Filled by Explore subagent during DISCOVER phase, before implementation begins. This is the verified state of the codebase BEFORE edits._

| Symbol / Field | Source File | Line(s) | Casing / Shape | Verified |
| -------------- | ----------- | ------- | -------------- | -------- |
|                |             |         |                |          |

### Missing Symbols

_Symbols referenced in this spec that do not yet exist in the codebase:_

| Symbol / Field | Expected Location | Action Required |
| -------------- | ----------------- | --------------- |
|                |                   |                 |

## Contracts & Schemas

_Declare Zod schemas, OpenAPI specs, generated types this spec depends on or creates._

| Contract | Type                                              | Source / Location | Status             |
| -------- | ------------------------------------------------- | ----------------- | ------------------ |
|          | Zod schema / OpenAPI / Generated type / Interface |                   | exists / to-create |

## Dependencies

_Which other atomic specs must complete first? What contracts must already exist?_

| Dependency | Type                              | Status             | Blocking? |
| ---------- | --------------------------------- | ------------------ | --------- |
|            | atomic-spec / contract / external | pending / complete | Yes / No  |

## Implementation Evidence

_Filled by implementer agent after implementation._

| File | Line | Description |
| ---- | ---- | ----------- |
|      |      |             |

## Assumptions Made

_Populated by implementer during implementation. Reviewed during code review._

| ID  | Assumption | Confidence | Rationale | Needs Review |
| --- | ---------- | ---------- | --------- | ------------ |
|     |            |            |           |              |

## Test Evidence

_Filled by test-writer agent after tests written._

| Test File | Test Name | ACs Covered |
| --------- | --------- | ----------- |
|           |           |             |

## Decision Log

- `<timestamp>`: Created from spec.md decomposition

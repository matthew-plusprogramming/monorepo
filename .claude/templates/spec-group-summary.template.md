---
id: sg-<prd-slug>-v<version>
prd_ref: prd-<prd-id>
prd_version: v<version>
date: <YYYY-MM-DD>
review_status: draft
work_status: plan_ready
---

# Spec Group Summary: <PRD Title> (v<version>)

## Overview

**PRD Reference**: [<PRD Title>](link-to-prd)
**PRD Version**: v<version>
**Created**: <YYYY-MM-DD>
**Last Updated**: <YYYY-MM-DD>

---

## State Dimensions

### Review Dimension

| State    | Description                         | Current |
| -------- | ----------------------------------- | ------- |
| DRAFT    | Specs created, awaiting user review | ☐       |
| REVIEWED | User has approved spec summary      | ☐       |

**Current Review Status**: `DRAFT`

### Work Dimension

| State          | Description                              | Current |
| -------------- | ---------------------------------------- | ------- |
| PLAN_READY     | Specs approved, ready for implementation | ☐       |
| IMPLEMENTING   | Work in progress                         | ☐       |
| VERIFYING      | Gates running (tests, reviews)           | ☐       |
| READY_TO_MERGE | All gates passed                         | ☐       |

**Current Work Status**: `PLAN_READY`

---

## Scope Summary

**Total Atomic Specs**: <N>
**Requirements Covered**: <N>

### High-Level Changes

<1-2 paragraph summary of what this spec group accomplishes. This is what the user reviews instead of each atomic spec individually.>

### Key Behaviors

1. <Primary behavior/feature>
2. <Secondary behavior/feature>
3. <Additional behavior/feature>

---

## Atomic Specs

| ID            | Title   | Status  | Requirements     |
| ------------- | ------- | ------- | ---------------- |
| as-001-<slug> | <Title> | pending | REQ-001          |
| as-002-<slug> | <Title> | pending | REQ-002          |
| as-003-<slug> | <Title> | pending | REQ-002, REQ-003 |

---

## Requirements Coverage

| Requirement | Description         | Atomic Specs   | Coverage |
| ----------- | ------------------- | -------------- | -------- |
| REQ-001     | <Brief description> | as-001         | Full     |
| REQ-002     | <Brief description> | as-002, as-003 | Full     |
| REQ-003     | <Brief description> | as-003         | Partial  |

---

## Dependencies

### Internal Dependencies

| Spec   | Depends On | Reason           |
| ------ | ---------- | ---------------- |
| as-002 | as-001     | <Why this order> |

### External Dependencies

| Dependency             | Type     | Status      |
| ---------------------- | -------- | ----------- |
| <External service/API> | Required | Available   |
| <Feature flag>         | Optional | Not created |

---

## Risk Assessment

| Risk               | Impact       | Mitigation            | Atomic Specs Affected |
| ------------------ | ------------ | --------------------- | --------------------- |
| <Risk description> | High/Med/Low | <Mitigation strategy> | as-001, as-002        |

---

## Rollout Strategy

| Phase | Atomic Specs   | Criteria for Advancement    |
| ----- | -------------- | --------------------------- |
| 1     | as-001         | Core functionality verified |
| 2     | as-002, as-003 | Integration tests passing   |

---

## Convergence Gates

_Status of gates required for merge._

| Gate                                    | Status | Notes |
| --------------------------------------- | ------ | ----- |
| All specs approved                      | ☐      |       |
| All ACs implemented                     | ☐      |       |
| All tests passing (100% AC coverage)    | ☐      |       |
| Unifier validation: CONVERGED           | ☐      |       |
| Code review: no High/Critical           | ☐      |       |
| Security review: no Critical/High       | ☐      |       |
| Browser tests passed (if UI)            | ☐      | N/A   |
| Documentation generated (if public API) | ☐      | N/A   |

---

## State Transition Log

| Date         | From State   | To State       | Actor  | Notes                    |
| ------------ | ------------ | -------------- | ------ | ------------------------ |
| <YYYY-MM-DD> | —            | DRAFT          | System | Spec group created       |
|              | DRAFT        | REVIEWED       | User   | Summary approved         |
|              | —            | PLAN_READY     | System | Ready for implementation |
|              | PLAN_READY   | IMPLEMENTING   | System | Work started             |
|              | IMPLEMENTING | VERIFYING      | System | Implementation complete  |
|              | VERIFYING    | READY_TO_MERGE | System | All gates passed         |

---

## User Review Section

_This section is for user review. The user reviews this summary, not individual atomic specs._

### Summary for Review

<Concise summary of what will be built, key design decisions, and any tradeoffs made.>

### Questions for User

1. <Any open question requiring user input>
2. <Clarification needed>

### Approval

- [ ] I have reviewed the spec group summary
- [ ] I approve proceeding with implementation

**Approved By**: <name>
**Date**: <YYYY-MM-DD>
**Notes**: <Any approval notes or conditions>

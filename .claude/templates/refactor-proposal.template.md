---
id: refactor-<slug>
date: <YYYY-MM-DD>
status: proposed
trigger: scheduled | manual | threshold_breach
---

# Refactor Proposal: <Title>

## Overview

**Proposed**: <YYYY-MM-DD>
**Trigger**: <What triggered this proposal: scheduled scan, threshold breach, manual request>
**Priority**: High / Medium / Low

---

## Constraints (Immutable)

> **This refactor MUST NOT:**
>
> - Change product behavior
> - Modify functional requirements
> - Alter public API contracts
> - Break existing tests (tests are the contract)
>
> If any of these constraints cannot be met, this is NOT a refactor—it requires a PRD.

---

## Quality Metrics

### Current State

| Metric                      | Current Value | Threshold    | Status |
| --------------------------- | ------------- | ------------ | ------ |
| Cyclomatic Complexity (max) | <N>           | <threshold>  | ⚠️/✓   |
| Cognitive Complexity (max)  | <N>           | <threshold>  | ⚠️/✓   |
| Code Duplication (%)        | <N>%          | <threshold>% | ⚠️/✓   |
| Code Churn (30d)            | <N>%          | <threshold>% | ⚠️/✓   |

### Target State

| Metric                      | Target Value | Improvement |
| --------------------------- | ------------ | ----------- |
| Cyclomatic Complexity (max) | <N>          | -<N>        |
| Cognitive Complexity (max)  | <N>          | -<N>        |
| Code Duplication (%)        | <N>%         | -<N>%       |

---

## Problem Statement

### What Is Wrong

<Describe the quality issue: complexity, duplication, over-abstraction, poor structure>

### Why It Matters

<Impact on maintainability, readability, or future development>

### Files Affected

| File              | Issue        | Complexity Score |
| ----------------- | ------------ | ---------------- |
| <path/to/file.ts> | <Issue type> | <N>              |
| <path/to/file.ts> | <Issue type> | <N>              |

---

## Proposed Changes

### High-Level Approach

<Brief description of the refactoring strategy>

### Specific Changes

| Change            | Rationale                   | Risk    |
| ----------------- | --------------------------- | ------- |
| <Specific change> | <Why this improves quality> | Low/Med |
| <Specific change> | <Why this improves quality> | Low/Med |

### What Will NOT Change

_Explicitly state what remains unchanged to verify constraint compliance._

- <Behavior that remains identical>
- <API that remains stable>
- <Feature that is untouched>

---

## Behavior Preservation Evidence

### Test Coverage

| Test File           | Tests     | Status    |
| ------------------- | --------- | --------- |
| <test-file.test.ts> | <N> tests | ✓ Passing |
| <test-file.test.ts> | <N> tests | ✓ Passing |

**Total Tests**: <N>
**Coverage**: <N>%

### Behavior Verification Strategy

1. <How behavior preservation will be verified>
2. <Additional verification steps>
3. <Regression testing approach>

---

## Risk Assessment

| Risk               | Likelihood   | Impact       | Mitigation   |
| ------------------ | ------------ | ------------ | ------------ |
| <Risk description> | Low/Med/High | Low/Med/High | <Mitigation> |

---

## Rollback Strategy

<How to reverse this refactor if issues are discovered post-merge>

---

## Execution Plan

### Phase 1: <Phase Name>

- [ ] <Task>
- [ ] <Task>
- [ ] Verify all tests pass

### Phase 2: <Phase Name>

- [ ] <Task>
- [ ] <Task>
- [ ] Verify all tests pass

---

## Review Checklist

_Must all be checked before merge._

- [ ] No product behavior changes
- [ ] No functional requirement changes
- [ ] No public API changes
- [ ] All existing tests pass (100%)
- [ ] Complexity metrics improved
- [ ] Code review completed
- [ ] Behavior preservation verified

---

## Approval

### Refactor Approval

- [ ] Proposal reviewed
- [ ] Constraints verified
- [ ] Approved for implementation

**Approved By**: <name>
**Date**: <YYYY-MM-DD>

### Post-Implementation Verification

- [ ] All tests passing
- [ ] Metrics improved as proposed
- [ ] No behavior regressions detected

**Verified By**: <name>
**Date**: <YYYY-MM-DD>

---

## Metrics Comparison (Post-Refactor)

_Filled after refactor is complete._

| Metric                      | Before | After | Delta |
| --------------------------- | ------ | ----- | ----- |
| Cyclomatic Complexity (max) |        |       |       |
| Cognitive Complexity (max)  |        |       |       |
| Code Duplication (%)        |        |       |       |
| Test Count                  |        |       |       |
| Test Coverage (%)           |        |       |       |

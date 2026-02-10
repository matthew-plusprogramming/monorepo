---
id: integ-<prd-slug>
prd_ref: prd-<prd-id>
prd_version: v<version>
date: <YYYY-MM-DD>
status: draft
authority: blocking
---

# Integration Testing Document: <PRD Title>

## Overview

**PRD Reference**: [<PRD Title>](link-to-prd)
**PRD Version**: v<version>
**Last Updated**: <YYYY-MM-DD>

## Purpose

This document defines black-box integration tests derived from the PRD and documentation. These tests:

- Do NOT read implementation code
- Validate system behavior against documented intent
- Override developer confidence
- Can block merges or open incidents

---

## Authority Statement

> The Black-Box Integration Testing System has authority to:
>
> - Block merges when tests fail
> - Open incidents when behavior deviates from PRD
> - Override implementation confidence with empirical evidence
>
> Failures are signals of spec violations, not test bugs.

---

## Documentation Sources

| Source          | Location | Version    |
| --------------- | -------- | ---------- |
| PRD             | <link>   | v<version> |
| Public API Docs | <link>   | <version>  |
| Internal Docs   | <link>   | <version>  |

---

## Behavioral Contracts

### BC1: <Behavior Name>

**Source**: PRD Section <X.Y> / API Docs <endpoint>

**Contract**:

> <Exact expected behavior quoted or paraphrased from documentation>

**Test Cases**:

| ID    | Input        | Expected Output     | Validates         |
| ----- | ------------ | ------------------- | ----------------- |
| BC1.1 | <Input data> | <Expected response> | <Requirement ref> |
| BC1.2 | <Input data> | <Expected response> | <Requirement ref> |

---

### BC2: <Behavior Name>

**Source**: PRD Section <X.Y>

**Contract**:

> <Exact expected behavior>

**Test Cases**:

| ID    | Input        | Expected Output     | Validates         |
| ----- | ------------ | ------------------- | ----------------- |
| BC2.1 | <Input data> | <Expected response> | <Requirement ref> |

---

## Regression Detection

| Behavior               | Baseline | Threshold | Action on Violation    |
| ---------------------- | -------- | --------- | ---------------------- |
| <Response time for X>  | <N>ms    | +20%      | Open incident          |
| <Success rate for Y>   | 99.9%    | <99%      | Block merge            |
| <Data integrity for Z> | 100%     | <100%     | Block merge + incident |

---

## Test Execution Strategy

### Continuous Execution

| Schedule | Scope                        | Environment       |
| -------- | ---------------------------- | ----------------- |
| Every PR | Changed behavioral contracts | Staging           |
| Hourly   | All behavioral contracts     | Staging           |
| Daily    | Full suite + performance     | Production-mirror |

### Failure Handling

1. **Test Failure**:
   - Block merge (if PR-triggered)
   - Create issue linking to PRD section
   - Notify relevant stakeholders

2. **Regression Detection**:
   - Open incident with severity based on threshold breach
   - Link to PRD assumptions that may be violated
   - Trigger rediscovery if assumption mismatch

---

## Traceability Matrix

| Requirement | Behavioral Contract | Test IDs     | Last Verified |
| ----------- | ------------------- | ------------ | ------------- |
| REQ-001     | BC1                 | BC1.1, BC1.2 | <YYYY-MM-DD>  |
| REQ-002     | BC2                 | BC2.1        | <YYYY-MM-DD>  |

---

## Assumptions Under Test

_These assumptions from the PRD are validated by integration tests._

| Assumption        | Source          | Test Coverage | Monitoring         |
| ----------------- | --------------- | ------------- | ------------------ |
| <Assumption text> | PRD Section X   | BC1.1         | Production metrics |
| <Assumption text> | PRD Constraints | BC2.1         | Error rate         |

---

## Incidents & PRD Feedback

_Document behavior regressions and their PRD implications._

| Date | Contract | Violation | Incident | PRD Update Required |
| ---- | -------- | --------- | -------- | ------------------- |
|      |          |           |          |                     |

---

## Test Independence Verification

- [ ] No tests read implementation source code
- [ ] All tests derive from PRD/documentation only
- [ ] Tests can run against any conforming implementation
- [ ] Test logic reviewed independently from implementation

**Reviewed By**: <name>
**Date**: <YYYY-MM-DD>

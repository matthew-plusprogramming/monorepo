---
id: qa-<prd-slug>
prd_ref: prd-<prd-id>
prd_version: v<version>
date: <YYYY-MM-DD>
status: draft
---

# QA Checklist: <PRD Title>

## Overview

**PRD Reference**: [<PRD Title>](<link-to-prd>)
**PRD Version**: v<version>
**Last Updated**: <YYYY-MM-DD>

## Purpose

This checklist validates critical user paths defined in the PRD using browser-level automation. It is reserved for critical paths only—not exhaustive coverage.

---

## Critical Paths

### CP1: <Critical Path Name>

**Description**: <What this critical path validates>

**Preconditions**:
- <Required state before testing>
- <User role/permissions required>

| Step | Action | Expected Result | Status |
|------|--------|-----------------|--------|
| 1 | <User action> | <Expected outcome> | ☐ |
| 2 | <User action> | <Expected outcome> | ☐ |
| 3 | <User action> | <Expected outcome> | ☐ |

**Postconditions**:
- <Expected system state after completion>

---

### CP2: <Critical Path Name>

**Description**: <What this critical path validates>

**Preconditions**:
- <Required state before testing>

| Step | Action | Expected Result | Status |
|------|--------|-----------------|--------|
| 1 | <User action> | <Expected outcome> | ☐ |
| 2 | <User action> | <Expected outcome> | ☐ |

**Postconditions**:
- <Expected system state after completion>

---

## Edge Cases & Error Scenarios

| Scenario | Trigger | Expected Behavior | Status |
|----------|---------|-------------------|--------|
| <Error scenario> | <How to trigger> | <Expected error handling> | ☐ |
| <Edge case> | <How to trigger> | <Expected behavior> | ☐ |

---

## Environment Requirements

| Requirement | Value |
|-------------|-------|
| Browser(s) | <Chrome, Firefox, Safari, etc.> |
| Viewport | <Desktop, Mobile, Tablet> |
| Test Data | <Required fixtures or seed data> |
| Auth State | <Logged in/out, specific user> |

---

## Traceability

| Critical Path | PRD Requirement | Spec Reference |
|---------------|-----------------|----------------|
| CP1 | REQ-<id> | as-<spec-id> |
| CP2 | REQ-<id> | as-<spec-id> |

---

## Execution Log

| Date | Executor | Result | Notes |
|------|----------|--------|-------|
| <YYYY-MM-DD> | <Agent/Human> | PASS/FAIL | <Issues found> |

---

## Failures & Feedback

_Document any failures discovered during QA execution._

| Date | Critical Path | Failure Description | Issue Created | PRD Feedback |
|------|---------------|---------------------|---------------|--------------|
| | | | | |

---

## Sign-off

- [ ] All critical paths executed
- [ ] All edge cases validated
- [ ] Failures documented and issues created
- [ ] PRD feedback submitted (if applicable)

**Approved By**: <name>
**Date**: <YYYY-MM-DD>

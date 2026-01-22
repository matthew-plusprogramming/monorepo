---
id: fix-<NNN>
title: <Brief description of the fix>
date: <YYYY-MM-DD>
type: fix-report
severity: critical | high | medium | low
spec_group: <spec-group-id if applicable, null otherwise>
---

# Fix Report: <Title>

## Summary

**Date**: <YYYY-MM-DD>
**Severity**: <critical | high | medium | low>
**Time to Fix**: <duration>

---

## What Broke

<Clear description of the bug or issue that was discovered>

### Symptoms

- <Observable symptom 1>
- <Observable symptom 2>

### Discovery Context

<How was this bug discovered? During implementation, testing, production issue, etc.>

---

## Root Cause

<Technical explanation of why the bug occurred>

### Contributing Factors

- <Factor 1: e.g., missing edge case handling>
- <Factor 2: e.g., incorrect assumption about input>

---

## Fix Applied

<Description of the solution implemented>

### Approach

<Why this approach was chosen over alternatives>

### Code Changes

```typescript
// Before (problematic code)
<code snippet showing the issue>

// After (fixed code)
<code snippet showing the fix>
```

---

## Files Modified

| File              | Change Type | Description                   |
| ----------------- | ----------- | ----------------------------- |
| <path/to/file.ts> | modified    | <Brief description of change> |
| <path/to/file.ts> | added       | <Brief description of change> |

---

## Tests Added

| Test File         | Test Name   | Verifies                        |
| ----------------- | ----------- | ------------------------------- |
| <path/to/test.ts> | <test name> | <What bug behavior it prevents> |

---

## Prevention

### How to Prevent Similar Issues

- <Recommendation 1>
- <Recommendation 2>

### Related Areas to Review

- <Area 1 that might have similar issues>
- <Area 2 that might have similar issues>

---

## Verification

- [ ] Fix resolves the original issue
- [ ] No regression in related functionality
- [ ] Tests pass locally
- [ ] Build succeeds

---

## Related Artifacts

- **Commit**: <commit hash>
- **Spec Group**: <spec-group-id or "none">
- **Related Fixes**: <fix-NNN or "none">

---
id: as-003-post-logout-redirect
title: Post-Logout Redirect and Messaging
spec_group: sg-example-logout
requirements_refs: [REQ-003]
status: pending
---

# Post-Logout Redirect and Messaging

## References

- **Requirements**: REQ-003
- **Parent Spec Section**: spec.md#design-overview
- **Spec Group**: sg-example-logout

## Description

After successful token clearing, redirect the user to /login and display a confirmation message indicating they have been logged out successfully.

## Acceptance Criteria

- **AC3.1**: User redirected to /login after successful logout
- **AC3.2**: Success message "You have been logged out" displayed on login page

## Test Strategy

Unit test the redirect logic:
- Mock router
- Call post-logout handler
- Verify navigate('/login') called
- Verify success message state set

Integration test:
- Full logout flow
- Verify URL is /login
- Verify message visible in DOM

## Deployment Notes

Requires login page to support displaying logout success message. This could be via:
- Query parameter: /login?loggedOut=true
- Session flash message
- Global notification system

Choose based on existing patterns in the app. Can deploy independently if login page already handles messages.

## Rollback Strategy

Revert redirect logic. User stays on current page after logout (which may show auth errors). Low risk.

## Atomicity Justification

| Criterion | Justification |
|-----------|---------------|
| **Independently Testable** | Can test redirect without testing token clearing |
| **Independently Deployable** | Redirect logic separate from clearing logic |
| **Independently Reviewable** | Navigation concern only, clear scope |
| **Independently Reversible** | Remove redirect, user stays on page (acceptable fallback) |

## Implementation Evidence

_To be filled by implementer_

| File | Line | Description |
|------|------|-------------|
| | | |

## Test Evidence

_To be filled by test-writer_

| Test File | Test Name | ACs Covered |
|-----------|-----------|-------------|
| | | |

## Decision Log

- `2026-01-14T10:30:00Z`: Created from spec.md decomposition

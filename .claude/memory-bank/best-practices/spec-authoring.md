---
domain: specs
tags: [specs, atomicity, acceptance-criteria]
last_reviewed: 2026-02-14
---

# Spec Authoring Best Practices

## Spec is Contract

**The spec is the authoritative source of truth.**

- Implementation must conform to spec
- Tests must verify spec requirements
- Any deviation requires spec amendment first (never deviate silently)
- Unifier validates alignment before approval

## Writing Acceptance Criteria

### GIVEN-WHEN-THEN Format

Each AC should follow this structure:

```markdown
**AC1.1**: Logout clears authentication token

- **GIVEN** user is logged in
- **WHEN** user clicks logout button
- **THEN** system shall clear the authentication token from storage
- **AND** user session shall be invalidated
```

### Characteristics of Good ACs

| Characteristic  | Description                                          |
| --------------- | ---------------------------------------------------- |
| **Testable**    | Can write a test that verifies this AC               |
| **Observable**  | Behavior can be observed externally                  |
| **Independent** | Does not depend on other ACs being implemented first |
| **Complete**    | Covers the full behavior, including edge cases       |
| **Unambiguous** | Only one interpretation possible                     |

### Common AC Mistakes

| Mistake               | Example                                     | Better                                           |
| --------------------- | ------------------------------------------- | ------------------------------------------------ |
| Vague                 | "User experience should be good"            | "Page loads in under 2 seconds"                  |
| Implementation detail | "Use localStorage.removeItem()"             | "Clear authentication token from storage"        |
| Multiple behaviors    | "Clear token and redirect and show message" | Split into AC1.1, AC1.2, AC1.3                   |
| Untestable            | "System should be secure"                   | "Session expires after 30 minutes of inactivity" |

## Atomic Decomposition

### The Atomicity Principle

Each atomic spec should have **exactly one reason to fail**.

### Atomicity Criteria

1. **Single Responsibility**: One behavior per atomic spec
2. **Independent Implementation**: Can be implemented without other atomic specs
3. **Independent Testing**: Can be tested in isolation
4. **Clear Boundary**: Obviously complete or incomplete

### Decomposition Example

**Before (monolithic)**:

```markdown
## Task: Implement logout

- Add logout button
- Clear token
- Redirect to login
- Handle errors
```

**After (atomic)**:

```markdown
as-001-logout-button-ui.md
→ Single AC: Button appears in header when logged in

as-002-token-clearing.md
→ Single AC: Token cleared from storage on logout

as-003-post-logout-redirect.md
→ Single AC: User redirected to /login after successful logout

as-004-error-handling.md
→ Single AC: Error message shown if logout API fails
```

## Task List Design

### Tasks vs ACs

- **ACs**: What the system must do (requirements)
- **Tasks**: Steps to implement those requirements

### Task Granularity

Each task should be:

- Completable in one session
- Independently verifiable
- Linked to specific ACs

### Example Task List

```markdown
## Task List

1. [ ] Create LogoutButton component (AC1.1)
2. [ ] Add AuthService.logout() method (AC1.2, AC2.1)
3. [ ] Integrate button with UserMenu (AC1.1)
4. [ ] Add logout route handler (AC1.3)
5. [ ] Write unit tests for AuthService.logout (AC1.2, AC2.1)
6. [ ] Write integration test for logout flow (AC1.1, AC1.2, AC1.3)
```

## Error Handling in Specs

### Specify Error Cases Explicitly

Don't leave error handling to implementer discretion:

```markdown
## Error Handling

**AC2.1**: Network failure during logout

- **GIVEN** logout API call fails due to network error
- **WHEN** error is caught
- **THEN** display error message "Unable to connect. Please try again."
- **AND** keep user logged in (do not clear token)

**AC2.2**: Server error during logout

- **GIVEN** logout API returns 5xx error
- **WHEN** error is caught
- **THEN** display error message "Logout failed. Please try again."
- **AND** keep user logged in (do not clear token)
```

## Security Considerations

### Include Security in Spec

Don't assume security requirements:

```markdown
## Security

- Token MUST be cleared from all storage locations (localStorage, sessionStorage, cookies)
- Session invalidation MUST happen server-side before client-side token clearing
- No sensitive data shall be logged during logout process
```

## Open Questions

### Handling Unknowns

Use Open Questions section for unresolved decisions:

```markdown
## Open Questions

- Q1: Should we preserve return URL for post-login redirect? (Status: pending)
  - Options:
    - A: Simple redirect to /login
    - B: Redirect to /login?returnUrl=<current>
  - Impact: Affects AC1.3 implementation
```

**Never implement around an open question.** Resolve it first.

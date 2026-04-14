# Spec Authoring Checklist

The spec is the authoritative contract. Implementation conforms to spec. Tests verify spec. Any deviation requires spec amendment first — never deviate silently.

## Acceptance Criteria Format

Use GIVEN-WHEN-THEN for every AC:

- **GIVEN** [precondition]
- **WHEN** [action]
- **THEN** [observable outcome]
- **AND** [additional outcomes]

### Good AC Characteristics

| Characteristic  | Description                               |
| --------------- | ----------------------------------------- |
| **Testable**    | Can write a test that verifies it         |
| **Observable**  | Behavior visible externally               |
| **Independent** | No dependency on other ACs                |
| **Complete**    | Covers full behavior including edge cases |
| **Unambiguous** | Only one interpretation possible          |

### Common AC Mistakes

| Mistake               | Bad                                         | Better                                           |
| --------------------- | ------------------------------------------- | ------------------------------------------------ |
| Vague                 | "User experience should be good"            | "Page loads in under 2 seconds"                  |
| Implementation detail | "Use localStorage.removeItem()"             | "Clear authentication token from storage"        |
| Multiple behaviors    | "Clear token and redirect and show message" | Split into AC1.1, AC1.2, AC1.3                   |
| Untestable            | "System should be secure"                   | "Session expires after 30 minutes of inactivity" |

## Atomicity

Each atomic spec should have exactly one reason to fail:

- **Single Responsibility**: One behavior per atomic spec
- **Independent Implementation**: Can be implemented without other atomic specs
- **Independent Testing**: Can be tested in isolation
- **Clear Boundary**: Obviously complete or incomplete

## Error Handling

Specify error cases explicitly — don't leave to implementer discretion. Each error scenario gets its own AC with GIVEN-WHEN-THEN.

## Clean-Environment Testing (AC-3.1)

When a spec references environment-dependent behavior (e.g., `NODE_ENV`, `process.env.*`, feature flags), include a **clean-env test variant** that runs with the env var **unset** (not set to any value):

- The clean-env variant verifies features behave correctly in their **default state**
- Behavior divergence between `NODE_ENV=development` and unset `NODE_ENV` is flagged as a test failure
- This catches the class of bugs where tests pass with `NODE_ENV=development` but production runs without it set

**Pattern**: Use test runner environment overrides or a wrapper script to explicitly unset environment variables before running the test suite.

```markdown
## Testing

| AC       | Test                                                     | Type        |
| -------- | -------------------------------------------------------- | ----------- |
| AC-N.M   | Feature works with NODE_ENV=development                  | Unit        |
| AC-N.M+1 | Feature works with NODE_ENV unset (clean environment)    | Integration |
| AC-N.M+2 | No behavior divergence between development and unset env | Integration |
```

This pattern is enforced by the `spec-validate.mjs` PostToolUse hook, which emits an advisory warning when a spec references env-dependent code but has no AC for the default/unset case.

## Open Questions

Never implement around an open question. Resolve it first, or flag it as blocking.

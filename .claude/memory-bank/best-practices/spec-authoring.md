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

## Open Questions

Never implement around an open question. Resolve it first, or flag it as blocking.

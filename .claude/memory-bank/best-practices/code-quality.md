# Code Quality Checklist

Consistent conventions shape the codebase that future agents will pattern-match against — these standards compound over time.

## Error Handling

- Typed error classes with: machine-readable `error_code` (enum), `message`, `blame` (`self` | `upstream` | `client`), `retry_safe` boolean
- Never throw raw strings or generic Error
- Define error codes as enums so the set of possible errors is finite and discoverable
- Map errors at boundaries — internal errors are not API errors

## Dependency Injection

- Pass collaborators via constructor/function args, never module-level singletons
- Use factory functions for complex dependency graphs
- Tests must see exactly which dependencies to mock without tracing imports

## Constants

- No magic numbers/strings — use named constants with units: `HEARTBEAT_INTERVAL_MS`, `MAX_RETRY_COUNT`

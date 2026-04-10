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

## Express Middleware Ordering

- Routes with custom auth (e.g., static token, HMAC) must be registered **before** any generic catch-all middleware on the parent path (e.g., `app.use('/api', jwtMiddleware, ...)`)
- Express evaluates middleware in registration order — a generic `/api` handler fires before a specific `/api/calendar` handler if registered first
- This fails silently: the generic middleware rejects the request and the specific handler never runs
- Pattern: group all non-JWT route mounts above the global JWT `app.use('/api', ...)` line, with a comment block marking the boundary

## Debugging Local Dev Servers

- When code changes "don't take effect," verify the **new code is actually running** before debugging application logic
- Port conflicts and zombie processes silently serve stale code — always confirm: (1) old PID is gone, (2) port is free, (3) new process bound successfully
- LaunchAgent services with `KeepAlive` can respawn into port conflicts — stop the service, kill orphans, verify port clear, then restart
- Build systems with watch mode (vite --watch, node --watch) may rebuild from cached module graphs — a turbo/npm build doesn't guarantee the watch-mode process picks up changes

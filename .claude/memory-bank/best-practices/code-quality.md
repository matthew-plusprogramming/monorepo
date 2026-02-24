---
domain: development
tags: [code-quality, error-handling, dependency-injection, constants]
last_reviewed: 2026-02-14
---

# Code Quality Standards

Standards for how code should be written in this project. Consumed by implementers
and code-reviewers via dispatch prompts. The orchestrator does not write code -- these
standards are loaded on-demand when implementation or review work is dispatched.

AI agents pattern-match against existing code -- a codebase with consistent conventions
shapes agent behavior more effectively than prompt instructions alone.

## Error Handling

- Use a **structured error taxonomy**: typed error classes with machine-readable `error_code`, human-readable `message`, `blame` attribution (`self` | `upstream` | `client`), and `retry_safe` boolean.
- Never throw raw strings or generic `Error("something went wrong")`. An agent encountering `{ error_code: "WS_AUTH_FAILED", blame: "client", retry_safe: false }` knows immediately what to do. An agent encountering `"Error: something went wrong"` must guess.
- Define error codes as enums so the set of possible errors is finite and discoverable.
- Map errors at boundaries -- internal errors are not API errors.

## Dependency Injection

- Pass collaborators via constructor parameters or function arguments, not module-level singletons.
- An agent asked to "write tests for ServiceX" must be able to see exactly which dependencies to mock. Without DI, the agent must trace imports through the entire codebase.
- Use factory functions or a lightweight container for complex dependency graphs.

## Named Constants

- No magic numbers or strings in logic. Extract to named constants with units: `HEARTBEAT_INTERVAL_MS`, `MAX_RETRY_COUNT`, `HTTP_STATUS.OK`.

## Cross-References

- For validation at boundaries patterns (Zod, `z.infer`), see `contract-first.md`.
- For interface contract patterns (define before implement, shared types), see `contract-first.md`.
- For core software engineering principles (SoC, DRY, Fail Fast), see `software-principles.md`.
- For TypeScript-specific conventions, see `typescript.md`.

---
id: best-practices-typescript
domain: typescript
tags:
  - typescript
  - style
  - safety
last_reviewed: 2025-12-21
---

# TypeScript Best Practices

- Favor explicit types at module boundaries (public functions, exported types).
- Use narrow types and discriminated unions for state machines and reducers.
- Prefer `unknown` over `any` and narrow with type guards.
- Avoid type assertions unless you can prove invariants; document why they are safe.
- Keep shared types in dedicated modules to avoid circular dependencies.

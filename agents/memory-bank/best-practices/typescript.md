---
id: best-practices-typescript
domain: typescript
tags:
  - typescript
  - style
  - safety
last_reviewed: 2025-12-22
---

# TypeScript Best Practices

## Philosophy

- Favor type safety, clarity, and maintainability over cleverness.
- Standardized style prevents conflicts later.

## Naming and layout

- Files: `kebab-case.ts`; tests: `.test.ts`; React: `PascalCase.tsx`.
- Types/interfaces/enums: `PascalCase`.
- Variables/functions: `camelCase`.
- Constants: `SCREAMING_SNAKE_CASE` when the ecosystem demands it.
- One concept per file; keep a small public API.
- Naming: concise and descriptive; booleans use `is/has/should/can`; accessors use `get/set`; include units when relevant.

## Commits

- Subject <= 50 chars; capture the main change in a short title.
- Separate subject and body with a blank line for extended descriptions.
- Body explains what and why, not how.
- Optionally follow Conventional Commits.
- Commit frequently; you cannot have too many commits.

## Comments

- Code should explain itself.
- Comment for reasoning, assumptions, constraints, or workarounds.
- Avoid obvious or stale comments.
- Avoid excessive comments.

## Exports

- Prefer named exports for discoverability.
- Example:

```ts
export const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));
```

## Types and safety

- Favor explicit types at module boundaries (public functions, exported types).
- Use narrow types and discriminated unions for state machines and reducers.
- Prefer `unknown` over `any` internally and narrow with type guards.
- Avoid returning `any` or `unknown` to callers; validate at boundaries.
- Avoid type assertions unless you can prove invariants; document why they are safe.
- Keep shared types in dedicated modules to avoid circular dependencies.

### Prefer concrete types

- Use `unknown` only when absolutely needed and validate before use.
- Prefer validation at boundaries:
  - Generic wrapper (trusted input only).
  - Type guard parsing (lightweight runtime check).
  - Schema validation (robust; e.g., Zod).

Example generic wrapper (trusted input only):

```ts
export const parseAs = <T>(json: string): T => JSON.parse(json) as T;
```

## Type assertions

- Avoid `as T` unless invariants are proven.
- Avoid `!`; model nullability.

## Nullability

- Use `undefined` for missing.
- Prefer `foo?: T` over `T | undefined` unless semantics differ.

## Async

- Prefer `async/await`; avoid `.then` chains.
- Return concrete types (`Promise<string>` not `any`).
- No floating promises; use `void` with a comment if intentional.

## Errors

- Throw `Error` or subclasses with actionable messages.
- Narrow `catch` types for handling.
- Example:

```ts
try {
  await op();
} catch (e: unknown) {
  if (e instanceof TimeoutError) retry();
  else throw e;
}
```

## Effect + schema interop

- `Effect.forEach` and similar helpers return `ReadonlyArray`; if schema types expect `T[]` (for example, Zod `z.array` output), convert with `Array.from(...)` or align the schema to `readonly`.
- Map boundary errors to domain errors before returning to handlers (for example, `Effect.mapError` around Dynamo/S3 calls) so callers do not have to handle raw `Error`.
- When adding custom Zod issues, use `code: 'custom'` and avoid deprecated `ZodIssueCode.custom`.

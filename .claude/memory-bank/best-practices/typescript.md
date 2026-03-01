# TypeScript Project Conventions

## Naming & Layout

- Files: `kebab-case.ts`; tests: `.test.ts`; React: `PascalCase.tsx`
- Types/interfaces/enums: `PascalCase`
- Variables/functions: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Booleans: `is/has/should/can` prefix
- One concept per file; keep a small public API

## Exports

- Prefer named exports for discoverability
- Keep shared types in dedicated modules to avoid circular dependencies

## Commits

- Subject <= 50 chars; capture the main change in a short title
- Separate subject and body with a blank line
- Body explains what and why, not how
- Commit frequently; you cannot have too many commits

## Effect + Schema Interop

- `Effect.forEach` and similar helpers return `ReadonlyArray`; if schema types expect `T[]` (e.g., Zod `z.array` output), convert with `Array.from(...)` or align the schema to `readonly`
- Map boundary errors to domain errors before returning to handlers (e.g., `Effect.mapError` around Dynamo/S3 calls) so callers don't handle raw `Error`
- When adding custom Zod issues, use `code: 'custom'` and avoid deprecated `ZodIssueCode.custom`

# Plan Phase — Logger Console Simplification

## Problem Statement

- The current logger implementation still models CloudWatch log responses and requires AWS-specific types, making console usage awkward and requiring redundant metadata plumbing.
- We need a console-backed logger that accepts arbitrary inputs without downstream consumers handling AWS types.

## Acceptance Criteria (Given/When/Then)

- Given application code relies on `LoggerService.log`, When it provides any number of arguments of any type, Then the call succeeds and all arguments are forwarded to `console.info` while the effect resolves with `void`.
- Given application code relies on `LoggerService.logError`, When it is provided with error objects or other diagnostic values, Then the call forwards all arguments to `console.error` and the effect resolves with `void`.
- Given the node-server test suite, When the logger service tests execute, Then expectations align with the void-returning, console-forwarding behavior.

## Non-goals

- Replace existing console usage with structured logging or metadata capture.
- Introduce new logging transports or configuration surfaces beyond the existing Layer exports.

## Constraints, Risks, Assumptions

- Maintain existing Effect `Context.Tag` wiring so other services continue to derive the logger via dependency injection.
- Ensure async chains that previously awaited CloudWatch responses tolerate a `void` result.
- Assume no external dependencies expect CloudWatch metadata; adjust any internal fakes/tests that do.

## Impacted Components and Tests

- `packages/core/backend-core/src/services/logger.ts`
- `apps/node-server/src/services/logger.service.ts`
- `apps/node-server/src/__tests__/services/logger.service.test.ts`
- `apps/node-server/src/__tests__/fakes/logger.ts`

## Invariants & Interfaces to Respect

- `LoggerService` must remain a `Context.Tag` with the same identifier.
- Layers exported from `logger.service.ts` must continue to provide the logger service without altering consumer wiring.
- Effect return types stay `Effect<unknown, never>` with no failure channel.

## Design Notes

- Simplify the schema to accept `...args: ReadonlyArray<unknown>` for both methods and return `Effect.Effect<void, never>`.
- The concrete service will synchronously invoke `console.info`/`console.error` using the spread arguments and return `undefined`.
- Tests will assert on console invocations and the `undefined` resolution value; fakes will capture arguments without emitting metadata.

## Testing Plan

- Update existing Vitest suite to confirm console forwarding and `undefined` resolution.
- Rely on existing console spies per `testing.guidelines.md`; no additional suites are required.

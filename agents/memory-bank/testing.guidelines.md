---
last_reviewed: 2025-10-21
---

# Testing Guidelines

## Boundaries & Dependency Injection

- Boundaries to treat as external: HTTP/network clients, databases/repositories, filesystem reads/writes, clocks/timers, randomness/UUIDs, and `process.env`.
- Prefer dependency injection by passing collaborators via constructors or function parameters; avoid reaching for module singletons unless an adapter explicitly manages the boundary.
- Default strategies per boundary:
  - HTTP: Use MSW for integration slices; module-level mocks for unit tests.
  - DB/Repo: Favor in-memory fakes for service/use-case tests; swap in targeted mocks for edge cases or failure injection.
  - Filesystem: Use temporary directories or in-memory adapters (e.g., `memfs`) to avoid touching the real FS; mock only when the abstraction is too thin to fake.
  - Clock/Time: Control time with `jest.useFakeTimers()` and `jest.setSystemTime(...)`; expose clocks as injectable utilities when production code needs current time.
  - Randomness/UUID: Inject RNG/UUID generators; stub deterministic values inside tests.
  - Environment: Set and reset `process.env` keys in `beforeEach`/`afterEach` helpers to keep tests isolated.

## Reusable Utilities

- Add Test Data Builders (e.g., `UserBuilder`) under `src/**/__test__/builders.ts`; keep them close to the code under test for ergonomic imports.
- Create factory helpers such as `makeRepoMock()`, `fixedNow()`, and `withEnv()` to standardize common arrangements.
- Introduce shared in-memory fakes for frequently used repos/queues/cache interfaces when multiple suites need the same behavior.
- For CDK output dependencies, prefer `apps/node-server/src/__tests__/stubs/cdkOutputs.ts`'s `makeCdkOutputsStub()` and override only the keys a suite needs.
- Manipulate the `__BUNDLED__` runtime flag via `apps/node-server/src/__tests__/utils/runtime.ts` (`setBundledRuntime`, `clearBundledRuntime`) instead of inlining `Reflect` access.

## What to Test by Unit Type

- Pure functions: Avoid mocks; assert only on inputs and outputs.
- Adapters/clients (HTTP/DB wrappers): Mock the boundary; assert returned/throwing values and key calls (URL, payload, status handling).
- Services/use-cases: Wire fakes or focused mocks of dependencies; assert domain behavior plus the one or two critical interactions.
- Integration thin slices: Compose real modules with in-memory/fake boundaries; cover the happy path end-to-end without external network calls.

## Mocking Rules of Thumb

- Mock only true boundaries or expensive/slow dependencies.
- Prefer in-memory fakes over deep chains of mocks.
- Use spies (`jest.spyOn`) when you only need to observe a real method without replacing its implementation.
- Avoid asserting call order unless the order is part of the contract.

## Flake-Proofing

- Control time anywhere timeouts/intervals exist via fake timers.
- Inject or stub randomness to eliminate non-deterministic data or ordering.
- Reset globals, environment variables, and timers inside `afterEach` hooks.
- Skip default snapshots; use snapshots only for stable, structured artifacts (e.g., schemas, emails).

## AAA Comment Convention

- Every test case must annotate the Arrange, Act, and Assert phases with explicit `// Arrange`, `// Act`, and `// Assert` comments.
- Keep setup logic confined to the Arrange section; defer calls to the unit under test until the Act phase.
- When chaining helpers that immediately return promises (e.g., `Effect.runPromise`), capture the promise in the Act phase and perform assertions afterward to preserve structure.

## Bootstrap Testing Plan

- Start by covering 3–5 pure functions with focused assertions.
- Add one service test using an in-memory fake repository and include a failing edge case via a stubbed dependency response.
- Create one integration test that exercises the happy path using real module wiring and fake boundaries (no live network calls).

## Review Checklist

- Asserts observable behavior, not internals or private helpers.
- Each test focuses on a single concept with minimal mocking and explicitly labeled Arrange/Act/Assert comments.
- No hidden global state; timers and environment variables restored after each test; data deterministic.
- Test data flows through builders/helpers rather than large inline literals.

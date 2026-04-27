---
last_reviewed: 2026-04-18
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
- Shared test utilities (service fakes, Express request context builder, and runtime helpers) live under `@packages/backend-core/testing`; import from there instead of cloning per app.
- For CDK output dependencies, prefer `apps/node-server/src/__tests__/stubs/cdkOutputs.ts`'s `makeCdkOutputsStub()` and override only the keys a suite needs.
- Manipulate the `__BUNDLED__` runtime flag via `@packages/backend-core/testing` exports (e.g., `setBundledRuntime`, `clearBundledRuntime`, `hoistUnbundledRuntime`) instead of inlining `Reflect` access.
- When identical Arrange or helper logic appears across suites, extract it into a shared `test-helpers.ts` (local) or shared package utility so tests stay focused on the behavior under scrutiny.
- Reach for table-driven tests when scenarios differ only by data; prefer looping over a cases array that produces distinct `it` blocks to eliminate copy/paste without masking failures.
- Factor repeated assertion clusters (e.g., status/message pairs) into small helper functions to keep expectations DRY and intention-revealing.

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

- Start by covering 3-5 pure functions with focused assertions.
- Add one service test using an in-memory fake repository and include a failing edge case via a stubbed dependency response.
- Create one integration test that exercises the happy path using real module wiring and fake boundaries (no live network calls).

## Review Checklist

- Asserts observable behavior, not internals or private helpers.
- Each test focuses on a single concept with minimal mocking and explicitly labeled Arrange/Act/Assert comments.
- No hidden global state; timers and environment variables restored after each test; data deterministic.
- Test data flows through builders/helpers rather than large inline literals.

## E2E Testing

E2E tests exercise the real deployed system through its external surfaces. They complement unit and integration tests by catching wiring issues, deployment configuration errors, and cross-service contract misalignments that only manifest in a live environment.

### Philosophy: Black-Box, Never Half Measures

E2E tests are black-box by identity, not by guideline. The system under test is an opaque box. Tests interact with it through published external surfaces only (HTTP endpoints, browser UI, WebSocket connections). They never read implementation source code -- not during test generation, not during failure diagnosis.

### Tooling

- **Frontend**: Playwright for browser-based tests. Launch a real browser, navigate to pages, interact with UI elements, assert on visible outcomes. Run against the real dev server with no mocked backends.
- **Backend**: fetch or supertest for HTTP API tests. Hit the real running server with complete setup (authentication, seed data) and teardown (cleanup with verification).
- **Diagnosis**: Server logs, browser console output, network request/response traces, error messages in the UI, observability dashboards. Never implementation source code.

### Test Data Hygiene

- **Dedicated test credentials**: E2E tests use separate credentials from dev. Never share credentials with development.
- **Namespace isolation**: All test data is prefixed with a unique run ID (e.g., `e2e-run-<uuid>-<entity>`) to prevent collision during concurrent runs.
- **Mandatory cleanup verification**: After teardown, verify cleanup succeeded (e.g., GET deleted resource returns 404). Do not assume teardown worked without confirmation.

### URL Allowlisting

E2E tests may only target localhost (any port) and known preview domains. Arbitrary external URLs are prohibited to prevent data leakage and unintended side effects.

### Determinism and Isolation

- Tests must be deterministic given consistent server state. Flaky tests are treated as bugs.
- Each test sets up its own preconditions and cleans up after itself. No test-to-test ordering dependency.
- Tests must pass with randomized execution order.
- Target execution time: under 5 minutes per spec suite.

### Applicability

E2E tests apply only to specs with cross-boundary contracts (HTTP, SSE, WebSocket, database, external service boundaries). Module-to-module imports within the same process are NOT cross-boundary. Internal-only specs are exempt from E2E testing.

## Bug-Fix Hybrid Mode

Applies to the `test-writer` subagent only. The `e2e-test-writer` is explicitly outside this mode and remains strict-isolation at all times.

The default for every test-writer dispatch is strict isolation: reads are blocked outside spec, contract, template, test, and docs directories. Bug-fix hybrid mode is a narrow, TTL-bounded deviation that lets a test-writer re-read implementation files _after_ producing a first failing run on a bug-fix spec, so the test can be refined against observed behavior. The boundary is clarified via explicit positive signals (`spec_mode: bug-fix` + `test_writer_unlock` + cryptographic marker), not by relaxing defaults.

Canonical reference: [`.claude/docs/design/test-writer-unlock-state-signals.md`](../docs/design/test-writer-unlock-state-signals.md) (as-002 design doc). Owning spec: `sg-pipeline-efficiency-ws2-practice-2.4`.

### When hybrid mode activates

A spec activates hybrid eligibility only when its manifest frontmatter declares:

```yaml
spec_mode: bug-fix
```

Any other value (`feature`, `refactor`) or the field's absence pins the dispatch to fenced mode. This is the fail-closed default.

### State machine (four states)

| State    | Meaning                                                                      |
| -------- | ---------------------------------------------------------------------------- |
| Fenced   | No `test_writer_unlock[<sg-id>]` entry exists. Strict isolation. Default.    |
| Eligible | Spec has `spec_mode: bug-fix`; test-writer has produced a first failing run. |
| Unlocked | Entry exists with TTL unexpired and marker valid. Hybrid reads permitted.    |
| Expiring | Entry exists but `unlocked_until <= now()`. Next cooperative-check fails.    |

See design doc [§2 State Machine](../docs/design/test-writer-unlock-state-signals.md#2-state-machine) for edge rules.

### 5-minute TTL window

Once `session-checkpoint.mjs record-test-writer-unlock <sg-id>` is invoked and its preflight passes, the TTL is anchored exactly once at record time:

```
unlocked_until = first_failure_at + 5 minutes
```

The TTL is never recomputed on subsequent cooperative-checks (prevents clock-skew drift). A 5-minute window is deliberate: long enough to refine one failing case, short enough that an idle re-dispatch expires naturally. See design doc [§1.3 TTL invariant](../docs/design/test-writer-unlock-state-signals.md#13-ttl-invariant).

### Cooperative-check (5-step gate sequence)

Every implementation-file read during a potential unlock window runs through a PreToolUse cooperative-check with propagation SLA < 1 second:

1. Atomic-read `session.json.test_writer_unlock[<sg-id>]` (lstat + realpath + O_NOFOLLOW).
2. Check `unlocked_until > now()`.
3. Check `dispatch_id == current_dispatch_id`.
4. Verify HMAC-SHA256 marker via `crypto.timingSafeEqual`.
5. If all pass → permit; else emit `UNLOCK_REVOKED`.

On any failure: first attempt yields `UNLOCK_REVOKED`; the one permitted retry yields `TIMEOUT`; test-writer reverts to fenced mode for the remainder of the dispatch. In-flight reads already permitted are not retroactively revoked. See design doc [§5 Cooperative-check Gate Sequence](../docs/design/test-writer-unlock-state-signals.md#5-cooperative-check-gate-sequence-5-steps).

### 5 re-fence triggers

Any of the following clears `test_writer_unlock[<sg-id>]` via the sole-writer path and appends a `test_writer_unlock_refence` audit entry naming which trigger fired:

| #   | Label               | Source signal                                                                |
| --- | ------------------- | ---------------------------------------------------------------------------- |
| 1   | `spec-complete`     | `manifest.review_state` transitions to `APPROVED`                            |
| 2   | `test-pass`         | Unifier records first green test pass for the spec-group                     |
| 3   | `version-bump`      | `spec.md` `date` OR content_hash changes during a live unlock window         |
| 4   | `workstream-rotate` | Facilitator rotation hook fires for this spec-group                          |
| 5   | `session-end`       | `archive-incomplete` OR `complete-work` subcommand enters session-checkpoint |

All 5 triggers serialize through `session-checkpoint.mjs`, so the clear completes before any subsequent test-writer dispatch for the same spec-group arrives. Triggers are idempotent — firing without a pre-existing entry is a no-op. See design doc [§4 Re-fence Triggers](../docs/design/test-writer-unlock-state-signals.md#4-re-fence-triggers-5).

### Misuse heartbeat (observability, non-blocking)

If an unlock was active during a dispatch AND zero test files changed, the Stop hook emits `UNLOCK_USED_NO_TESTS` advisory warning plus a `test_writer_unlock_misuse` audit entry. The dispatch still completes; the entry still expires normally. This is pure observability — a signal that an unlock was granted but not converted into new test coverage.

### What test-writer must do in hybrid mode

- Produce the first failing run in strict mode. The unlock is never a way to skip writing a failing test first.
- After re-dispatch in hybrid mode, add or modify test cases. Reading implementation without producing new tests triggers the misuse heartbeat.
- Handle `UNLOCK_REVOKED` and `TIMEOUT` as structured errors. On `TIMEOUT`, drop back to fenced-mode behavior for the rest of the dispatch; do not retry again.
- Never write to `session.json` or the HMAC secret file. Only `session-checkpoint.mjs` mints markers and clears unlocks.

### Not covered by hybrid mode

- `e2e-test-writer` dispatches. E2E tests remain strict black-box regardless of `spec_mode`.
- Feature-mode specs (`spec_mode: feature` or field absent). Any unlock attempt against a feature-mode spec is rejected at the CLI preflight with `UNLOCK_MODE_MISMATCH`.
- Dev-tests, smoke tests, and manual probes. These remain separate from test-writer output and are unaffected by this mechanism.

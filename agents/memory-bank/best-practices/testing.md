---
id: best-practices-testing
domain: testing
tags:
  - testing
  - reliability
  - vitest
last_reviewed: 2025-12-22
---

# Testing Best Practices

- Follow `agents/memory-bank/testing.guidelines.md` for full conventions and tooling references.
- Annotate each test case with `// Arrange`, `// Act`, and `// Assert` comments.
- Control time in tests that depend on `Date.now()` or timers using fake timers (for example, `vi.useFakeTimers()` and `vi.setSystemTime(...)`).
- Make nondeterminism explicit by injecting clocks/UUIDs/randomness and resetting globals in `afterEach`.
- Extract shared setup and assertions into test helpers or builders to keep cases focused.

---
_source_spec: sg-e2e-pure-compute-check
_source_modules:
  ['scripts-lib/pure-compute-matcher', 'scripts-lib/pure-compute-scanner']
title: Pure-Compute Static-Analysis Sub-Check — Blocklist Reference
last_reviewed: 2026-04-21
---

# Pure-Compute Static-Analysis Sub-Check — Blocklist Reference

Authoritative blocklist for the pure-compute static-analysis sub-check. Any spec declaring `e2e_skip: true` + `e2e_skip_rationale: pure-compute` that imports or statically references these symbols fails Gate 5.

This document mirrors the `Blocklist` YAML block in [spec.md § Interfaces & Contracts](../specs/groups/sg-e2e-pure-compute-check/spec.md#interfaces--contracts) and the authoritative tables in `pure-compute-matcher.mjs` / `pure-compute-scanner.mjs`. The spec's `Blocklist` block is the source of truth; this doc is the human-readable surface.

For the overview and Gate 5 integration, see [PURE-COMPUTE-CHECK.md](PURE-COMPUTE-CHECK.md). For the API, see [PURE-COMPUTE-CHECK-API.md](PURE-COMPUTE-CHECK-API.md).

## Rules

- **Blocklist is authoritative**. Not extensible by spec authors. Additions require a spec amendment to `sg-e2e-pure-compute-check`.
- **Blocklist is append-only**. Adding entries is additive (non-breaking). Removing entries is a breaking change requiring a contract version bump.
- **`node:` prefix is normalized**. `node:fs` and `fs` match the same blocklist entry.
- **Type-only imports are ignored**. `import type { Socket } from 'net'` has no runtime effect; the walker filters type-only imports from the frontier.
- **Safelist is explicit**. `perf_hooks` is the single entry. Safelist matches short-circuit blocklist lookup.

## Detection Layers

The blocklist is matched at three layers of the pipeline:

| Layer              | Detected by              | Matches                                                                                               |
| ------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| **Module-level**   | `matcher.matchBlocklist` | Whole-module imports and re-exports (`import 'net'`, `export * from 'child_process'`).                |
| **Callsite-level** | `scanner.scanCallSites`  | CallExpression / NewExpression / PropertyAccessExpression matches (`fs.writeFile(...)`, `eval(...)`). |
| **Dynamic-import** | `extractor` + `matcher`  | `import(...)` call expressions; unconditional `<dynamic-import>` sentinel.                            |

## Module-Level Blocklist

Whole-module imports of these specifiers fail. Equivalent `node:`-prefixed forms are treated identically.

### Network

| Specifier | Fails |
| --------- | ----- |
| `net`     | Yes   |
| `http`    | Yes   |
| `https`   | Yes   |
| `dns`     | Yes   |
| `dgram`   | Yes   |
| `tls`     | Yes   |
| `http2`   | Yes   |

Every `node:<name>` prefix variant matches the same entry. Example failing imports:

```javascript
import net from 'net';
import http from 'node:http';
import { createServer } from 'https';
export * from 'dns';
```

### Filesystem Write (Module-Level)

Importing the write-side filesystem module fails at the module level:

| Specifier          | Fails |
| ------------------ | ----- |
| `fs/promises`      | Yes   |
| `node:fs/promises` | Yes   |

Importing `fs` itself does **not** fail at the module level. The walker relies on the callsite scanner to detect write-side calls (`fs.writeFile(...)`, etc.). A spec that imports `fs` and only uses read APIs (`fs.readFile`) passes.

### Process / Subprocess

| Specifier        | Fails |
| ---------------- | ----- |
| `child_process`  | Yes   |
| `worker_threads` | Yes   |
| `cluster`        | Yes   |

Callsite-level `process.exit()` also fails (see below). Other `process.*` accesses (e.g., `process.cwd()`) are allowed.

### Diagnostics / Introspection

| Specifier             | Fails |
| --------------------- | ----- |
| `diagnostics_channel` | Yes   |
| `inspector`           | Yes   |
| `trace_events`        | Yes   |

### Interactive

| Specifier  | Fails |
| ---------- | ----- |
| `readline` | Yes   |
| `repl`     | Yes   |

### Code Execution

| Specifier | Fails |
| --------- | ----- |
| `vm`      | Yes   |

Additional code-execution paths are detected at the callsite level (see below).

## Callsite-Level Blocklist

Call expressions and new expressions that fail even when the imported module itself is allowed.

### Filesystem Write Methods

Matched when the root binding resolves to `fs`, `node:fs`, `fs/promises`, or `node:fs/promises`. Namespace imports (`import * as ns from 'fs'`) and default imports (`import fs from 'fs'`) are tracked via binding maps; bare `fs.writeFile(...)` references are matched fail-closed even without an import record.

| Callsite                                          | Fails  | Notes                                       |
| ------------------------------------------------- | ------ | ------------------------------------------- |
| `fs.writeFile(...)`                               | Yes    | Sync and async callbacks.                   |
| `fs.writeFileSync(...)`                           | Yes    |                                             |
| `fs.appendFile(...)`                              | Yes    |                                             |
| `fs.appendFileSync(...)`                          | Yes    |                                             |
| `fs.rename(...)`                                  | Yes    |                                             |
| `fs.renameSync(...)`                              | Yes    |                                             |
| `fs.unlink(...)`                                  | Yes    |                                             |
| `fs.unlinkSync(...)`                              | Yes    |                                             |
| `fs.promises.writeFile(...)`                      | Yes    | Equivalent detection on the promises chain. |
| `fs.promises.rename(...)`                         | Yes    |                                             |
| _(all other `fs.promises._` write-side methods)\* | Yes    | Same set as above.                          |
| `fs.readFile(...)`                                | **No** | Read APIs are allowed.                      |

Namespace-binding example:

```javascript
import * as nfs from 'node:fs';
nfs.writeFile(...);     // FAILS (matched as fs.writeFile)
nfs.readFile(...);      // PASSES (read API)
```

### OS Functions

| Callsite                 | Fails  | Notes                                |
| ------------------------ | ------ | ------------------------------------ |
| `os.networkInterfaces()` | Yes    | Direct reference or namespace-bound. |
| `os.hostname()`          | **No** | Other `os.*` accesses are allowed.   |

`import os from 'os'` itself is allowed. Only the specific `networkInterfaces` call fails.

### Process Methods

| Callsite         | Fails |
| ---------------- | ----- |
| `process.exit()` | Yes   |

`process` is a global; no import is required to match the callsite.

### Direct Code Execution

| Callsite / Expression        | Fails | Notes                                         |
| ---------------------------- | ----- | --------------------------------------------- |
| `eval(arg)`                  | Yes   | Any identifier reference to `eval` as callee. |
| `globalThis.eval(arg)`       | Yes   | Indirect-eval pattern.                        |
| `Function('...')`            | Yes   | Called as regular function.                   |
| `new Function('...')`        | Yes   | Called as constructor.                        |
| `globalThis.Function(...)`   | Yes   |                                               |
| `AsyncFunction(...)`         | Yes   | Direct identifier call.                       |
| `new AsyncFunction(...)`     | Yes   |                                               |
| `GeneratorFunction(...)`     | Yes   | Direct identifier call.                       |
| `new GeneratorFunction(...)` | Yes   |                                               |

### Reflection-Obtained Constructors (SEC-014)

Defeats the bypass pattern where authors construct `AsyncFunction` or `GeneratorFunction` via prototype reflection instead of referencing them directly.

| Pattern                                                   | Fails | Symbol                             |
| --------------------------------------------------------- | ----- | ---------------------------------- |
| `Object.getPrototypeOf(async () => {}).constructor`       | Yes   | `AsyncFunction-via-reflection`     |
| `Object.getPrototypeOf(async function () {}).constructor` | Yes   | `AsyncFunction-via-reflection`     |
| `Reflect.getPrototypeOf(async () => {}).constructor`      | Yes   | `AsyncFunction-via-reflection`     |
| `Object.getPrototypeOf(function*(){}).constructor`        | Yes   | `GeneratorFunction-via-reflection` |
| `Reflect.getPrototypeOf(function*(){}).constructor`       | Yes   | `GeneratorFunction-via-reflection` |

The scanner matches the `.constructor` access whether or not it is immediately invoked — `const AF = Object.getPrototypeOf(async () => {}).constructor` fails even if `AF` is never called.

### Indirect Eval

`setTimeout` and `setInterval` accept a string first argument that is evaluated as code. These fail only when the first argument is a string-like literal.

| Pattern                   | Fails  | Notes                             |
| ------------------------- | ------ | --------------------------------- |
| `setTimeout('code', 1)`   | Yes    | String literal.                   |
| `setTimeout(\`code\`, 1)` | Yes    | No-substitution template literal. |
| `setInterval('code', 1)`  | Yes    |                                   |
| `setTimeout(() => {}, 1)` | **No** | Function argument; normal API.    |
| `setTimeout(someFn, 1)`   | **No** | Identifier reference; normal API. |

### Top-Level `fetch`

`fetch` is a Node 18+ global. Only **top-level** (module-scope) calls fail. Calls inside function bodies, arrow functions, methods, accessors, or constructors are allowed.

```javascript
// FAILS (top-level fetch)
await fetch('https://example.com');

// PASSES (fetch inside a function body)
async function callLater() {
  return fetch('https://example.com');
}
```

## Dynamic Imports

Every `import(...)` call expression produces a `<dynamic-import>` sentinel violation, regardless of the argument.

| Pattern                | Fails | Notes                                            |
| ---------------------- | ----- | ------------------------------------------------ |
| `import('./module')`   | Yes   | Static string argument; walker does not resolve. |
| `import(someVariable)` | Yes   | Dynamic argument; cannot be statically analyzed. |

Rationale: dynamic `import()` opts out of static-analysis soundness. Authors who need dynamic imports cannot claim pure-compute.

## Safelist

The safelist contains exactly one entry:

| Specifier         | Safe |
| ----------------- | ---- |
| `perf_hooks`      | Yes  |
| `node:perf_hooks` | Yes  |

Safelist matches short-circuit blocklist lookup — even if a symbol appeared on both, the safelist wins.

```javascript
import { performance } from 'perf_hooks'; // PASSES
import { performance } from 'node:perf_hooks'; // PASSES
```

## Sentinel Symbols

Four sentinel `symbol` values never appear on the direct blocklist but are emitted by the walker / matcher to mark structural failure modes. All four produce `verdict: 'fail'` when present in the violation list.

| Sentinel               | When emitted                                                                           | Produced by                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `<dynamic-import>`     | Any `import(...)` call expression.                                                     | Extractor records; matcher emits.                                                                 |
| `<resolution-failed>`  | Resolver returns null: missing file, unresolvable alias, or path escapes project root. | `makeResolutionFailedViolation` in matcher.                                                       |
| `<parse-error>`        | Extractor reports syntactic diagnostic OR file cannot be read.                         | `makeParseErrorViolation` in matcher.                                                             |
| `<entry-point-escape>` | Spec-declared entry point escapes tsconfig-declared containment root.                  | Walker emits via `makeResolutionFailedViolation` with entry as both `file` and `importSpecifier`. |

`<entry-point-escape>` is not a distinct symbol constant; it reuses `<resolution-failed>` to avoid leaking the canonicalized realpath in the diagnostic. The _context_ distinguishes it: `file` and `importSpecifier` both point to the unresolved entry, and `pathToEntry` is a single-element array.

See [PURE-COMPUTE-CHECK.md § The Four Sentinels](PURE-COMPUTE-CHECK.md#the-four-sentinels) for fail-closed semantics.

## Fixtures & Test Coverage

Each blocklist category has positive (FAIL) and negative (PASS) fixtures under `.claude/scripts/__tests__/pure-compute-check/`:

| Category                  | Fixture directory                               | Atomic spec |
| ------------------------- | ----------------------------------------------- | ----------- |
| Network                   | `network/`                                      | as-008      |
| fs-write + process        | `fs-write/`, `process/`                         | as-009      |
| Diagnostics + interactive | `diagnostics/`, `interactive/`                  | as-010      |
| Code-exec + eval          | `code-exec/`                                    | as-011      |
| Dynamic + top-level + os  | `dynamic/`, `top-level-fetch/`, `os-functions/` | as-012      |
| Resolver integration      | `resolver/`                                     | as-013      |

Shared parameterized driver: `blocklist-fixtures.test.mjs` reads each fixture directory, invokes `checkPureCompute`, and asserts against a co-located `expected.json`.

Safe-path regression fixtures (`perf_hooks`, `fs.readFile`, `os.hostname`, `setTimeout(() => {}, 1)`) are part of the MUST-PASS coverage listed in AC-005.

## What Happens When a Blocklist Entry Changes

The blocklist is a frozen contract. Any change requires:

1. **Addition** (additive, non-breaking): Update the spec's `Blocklist` YAML block, the `MODULE_BLOCKLIST` constant in `pure-compute-matcher.mjs` (or the appropriate scanner table for callsite entries), and add a positive fixture under the relevant `__tests__/pure-compute-check/<category>/` directory.
2. **Removal** (breaking): Bump the contract version on `contract-pure-compute-sub-check-api`, update consumers, and run the full convergence loop.

Do not rely on blocklist stability without pinning to a specific spec-group version.

## See Also

- [PURE-COMPUTE-CHECK.md](PURE-COMPUTE-CHECK.md) — Overview, Gate 5 integration, sentinel semantics
- [PURE-COMPUTE-CHECK-API.md](PURE-COMPUTE-CHECK-API.md) — Module-by-module API reference
- Spec: [`.claude/specs/groups/sg-e2e-pure-compute-check/spec.md`](../specs/groups/sg-e2e-pure-compute-check/spec.md) § Interfaces & Contracts (canonical Blocklist YAML)
- Matcher source: [`.claude/scripts/lib/pure-compute-matcher.mjs`](../scripts/lib/pure-compute-matcher.mjs)
- Scanner source: [`.claude/scripts/lib/pure-compute-scanner.mjs`](../scripts/lib/pure-compute-scanner.mjs)

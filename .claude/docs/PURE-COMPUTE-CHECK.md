---
_source_spec: sg-e2e-pure-compute-check
_source_modules:
  [
    'scripts-lib/pure-compute-static-check',
    'scripts-lib/pure-compute-walker',
    'scripts-lib/pure-compute-resolver',
    'scripts-lib/pure-compute-extractor',
    'scripts-lib/pure-compute-scanner',
    'scripts-lib/pure-compute-matcher',
    'scripts-lib/pure-compute-formatter',
    'scripts-lib/path-containment',
  ]
title: Pure-Compute Static-Analysis Sub-Check
last_reviewed: 2026-04-21
---

# Pure-Compute Static-Analysis Sub-Check

Static import-graph walker that validates the `e2e_skip: true` + `e2e_skip_rationale: pure-compute` opt-out against the REQ-F-011 authoritative blocklist. Hosted inside the completion-verifier's Gate 5 pipeline (step 4 of 9). Closes the **SEC-F3 author-honesty gap**: a spec author declaring `pure-compute` can no longer silently import `child_process`, call `fs.writeFile`, or `eval(...)` without failing the opt-out.

Source-of-truth spec group: [`.claude/specs/groups/sg-e2e-pure-compute-check/`](../specs/groups/sg-e2e-pure-compute-check/spec.md).

## What It Does

Given a spec's declared entry points, the sub-check performs a depth-first walk of the transitive import graph and fails the opt-out if **any** blocklisted symbol is reachable. The walker:

- Follows static `import` declarations and `export ... from` re-exports
- Resolves TypeScript `tsconfig.json#compilerOptions.paths` aliases
- Normalizes `node:` prefixes (`node:fs` === `fs`)
- Detects cycles via a two-state visited set (`in-progress` / `finalized`)
- Folds cycle members into an equivalence class (any disallowed import fails every cycle node)
- Treats `perf_hooks` as the sole explicit safelist entry
- Scans call-expressions for reflection-obtained `AsyncFunction` / `GeneratorFunction` (SEC-014)
- Rejects dynamic `import(...)` unconditionally

It does **not** perform runtime call detection or behavioral analysis — any _import_ or _static reference_ of a blocklisted symbol fails, even if dead code. The runtime caller (Gate 5's runtime-connectivity tests for non-opted-out specs) remains responsible for actual runtime isolation.

## Why It Exists (Threat Model)

| Gap               | Description                                                                                                                    | Mitigation                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| SEC-F3            | Author declares `e2e_skip: true` + `rationale: pure-compute` while implementation imports network/fs-write/process modules.    | Full REQ-F-011 blocklist enforcement against the transitive import graph.                     |
| SEC-003           | Without verification, the `pure-compute` rationale relies entirely on author honesty.                                          | Walker fails the opt-out if any blocklisted symbol is reachable. Gate 5 blocks the spec.      |
| SEC-009           | Transitive paths through re-exports, cycles, and alias chains could hide disallowed imports.                                   | DFS with alias resolution, re-export following, cycle-class folding — no path missed.         |
| SEC-014           | Reflection-obtained `AsyncFunction` / `GeneratorFunction` constructors bypass direct `eval` / `Function` checks.               | Scanner matches `Object.getPrototypeOf(async () => {}).constructor` and reflection patterns.  |
| SEC-TRAVERSAL-001 | Malicious entry point or tsconfig alias escapes project root via `../` traversal or wildcard-capture, reading arbitrary files. | Path-containment gate (realpath + strict-prefix) on every resolver candidate and entry point. |

## Gate 5 Integration

The sub-check is a **library**, not a standalone hook. Per design decision D-035, it is co-located inside completion-verifier Gate 5 to avoid hook sprawl (DEC-009) and share the spec-file + frontmatter + import-graph reads Gate 5 already performs.

```
completion-verifier Gate 5 (9-step pipeline)
  1. enforcement-mode resolution
  2. crosses_boundary scope determination
  3. e2e_skip_rationale enum validation
  4. ── pure-compute sub-check ──  checkPureCompute({specId, entryPoints, tsconfigPath})
  5–9. remaining Gate 5 steps
```

Invocation contract: [`contract-pure-compute-sub-check-api`](../specs/groups/sg-e2e-pure-compute-check/spec.md#contract-pure-compute-sub-check-api-owner---this-workstream). Input fields: `specId`, `entryPoints`, `tsconfigPath`. Output fields: `verdict` (`'pass' | 'fail'`), `violations` (array of the 4-field canonical `Violation` record).

## Fail-Closed Semantics

**Verdict derivation is deterministic**: `verdict === 'fail'` iff `violations.length > 0`. The walker runs to completion (no short-circuit) so authors receive the full violation list in one pass.

### The Four Sentinels

When the walker cannot _directly_ match a blocklist entry but encounters a condition that must not silently pass, it emits a **sentinel violation** with a structured symbol. Each sentinel has fail-closed semantics — the surrounding verdict becomes `'fail'`.

| Sentinel symbol        | When emitted                                                                           | Where produced                                                                                        | Rationale                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<dynamic-import>`     | Any `import(...)` call expression encountered in the AST.                              | Extractor records it; matcher emits violation.                                                        | Dynamic `import()` opts out of static-analysis soundness. Authors needing it cannot claim pure-compute.                                                                             |
| `<resolution-failed>`  | Resolver returns null: missing file, unresolvable alias, or path escapes project root. | `makeResolutionFailedViolation` in matcher; emitted by walker + resolver.                             | Prevents typos and traversal attempts from being silent bypasses. SEC-TRAVERSAL-001 defense.                                                                                        |
| `<parse-error>`        | Extractor reports a syntactic diagnostic OR the file cannot be read.                   | `makeParseErrorViolation` in matcher; emitted by walker.                                              | A file we cannot parse may hide imports we cannot see — treat as failure.                                                                                                           |
| `<entry-point-escape>` | Spec-declared entry point escapes the tsconfig-declared containment root.              | Walker emits via `makeResolutionFailedViolation` with the entry as both `file` and `importSpecifier`. | SEC-TRAVERSAL-001 defense against out-of-tree entry points paired with tsconfig declaration. The sentinel reuses `<resolution-failed>` to avoid leaking the canonicalized realpath. |

All four paths explicitly **reject** silent-warn-and-continue. This is enforced at AC5.10–5.12 (matcher), AC6.12–6.14 (walker), and AC2.7–2.8 (resolver graceful-degradation envelope).

### What Happens on Verdict = 'fail'

Gate 5 blocks the spec with a diagnostic message naming:

- The file where the violation was found (`violation.file`)
- The raw import specifier / expression (`violation.importSpecifier`)
- The canonical blocklisted symbol or sentinel (`violation.symbol`)
- The path through the import graph from entry to violation site (`violation.pathToEntry`)

The `formatViolation()` helper produces a human-readable one-line diagnostic per violation. See [PURE-COMPUTE-CHECK-API.md](PURE-COMPUTE-CHECK-API.md#diagnostic-formatter-pure-compute-formattermjs) for the format.

## Module Surface

The library ships as seven `.mjs` modules plus a shared path-containment utility. All live under `.claude/scripts/lib/`.

| Module                            | Purpose                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pure-compute-static-check.mjs`   | Public entry point. Exports `checkPureCompute({specId, entryPoints, tsconfigPath})` and error classes.                |
| `pure-compute-resolver.mjs`       | tsconfig loader + specifier → absolute-path resolver with path-containment gate.                                      |
| `pure-compute-extractor.mjs`      | TypeScript AST extractor: static imports, re-exports, dynamic imports, type-only filtering.                           |
| `pure-compute-scanner.mjs`        | Callsite scanner: `fs.writeFile`, top-level `fetch`, `eval`, `Function`, reflection patterns, `os.networkInterfaces`. |
| `pure-compute-matcher.mjs`        | Blocklist match engine + safelist + sentinel factories (`makeResolutionFailedViolation`, etc.).                       |
| `pure-compute-walker.mjs`         | DFS walker with cycle detection + canonical 4-field `Violation` aggregation.                                          |
| `pure-compute-formatter.mjs`      | Human-readable diagnostic renderer (no ANSI, no mutation of input).                                                   |
| `path-containment.mjs` _(shared)_ | `assertContainment()` realpath + strict-prefix gate.                                                                  |

For each module's exported symbols, parameter shapes, and error classes, see [PURE-COMPUTE-CHECK-API.md](PURE-COMPUTE-CHECK-API.md). For the authoritative blocklist (categories, symbols, safelist, examples), see [PURE-COMPUTE-CHECK-BLOCKLIST.md](PURE-COMPUTE-CHECK-BLOCKLIST.md).

## Authoring a `pure-compute` Spec

To opt a spec out of runtime-connectivity testing with `pure-compute`:

1. **Add frontmatter fields** to your WorkstreamSpec or AtomicSpec:

   ```yaml
   e2e_skip: true
   e2e_skip_rationale: pure-compute
   pure_compute_entry_points:
     - src/my-feature/index.ts
     - src/my-feature/helpers.ts
   ```

   `pure_compute_entry_points` is required (non-empty) when `e2e_skip_rationale: pure-compute`. See [SPEC-FRONTMATTER.md](SPEC-FRONTMATTER.md) for the field definition.

2. **Keep the transitive import graph clean**. Do not import:
   - Network modules (`net`, `http`, `https`, `dns`, `dgram`, `tls`, `http2`)
   - Process / subprocess (`child_process`, `worker_threads`, `cluster`)
   - Diagnostics / interactive (`diagnostics_channel`, `inspector`, `trace_events`, `readline`, `repl`)
   - `vm` or use `eval` / `new Function(...)` / reflection-obtained constructors
   - Any `fs.writeFile*`, `fs.appendFile*`, `fs.rename*`, `fs.unlink*` (read APIs are fine)
   - Top-level `fetch(...)` or `os.networkInterfaces()`

3. **Use `perf_hooks` freely**. It is the single explicit safelist entry; both `perf_hooks` and `node:perf_hooks` forms pass.

4. **Expect immediate feedback**. Gate 5 runs the sub-check at completion time. Violations name the exact file, specifier, symbol, and entry-to-violation path.

If your spec legitimately _needs_ one of the blocklisted symbols (e.g., a test infrastructure spec), use a different `e2e_skip_rationale` (e.g., `test-infra`) or do not set `e2e_skip` at all.

## Determinism & Performance

The sub-check is a pure function of `(input file contents, tsconfig, entry points)`. No network, no subprocess, no wall-clock dependency. Identical inputs yield byte-identical outputs (AC6.11, contract `determinism` clause).

Performance budget: 30 seconds total per spec (matches REQ-NFR-001). Terminates on any finite file graph via the two-state visited set. In practice the check completes in tens of milliseconds for typical specs.

## Test Coverage

202 tests pass across 9 test files under `.claude/scripts/__tests__/pure-compute-check/`:

- 168 unit + fixture tests covering all 14 atomic specs (`as-001` .. `as-014`)
- 34 regression tests (path-traversal containment + API contract black-box)

All 13 rows of the AC-005 parameterization matrix are bound to specific test fixtures. See the spec's [Testing section](../specs/groups/sg-e2e-pure-compute-check/spec.md#ac-005-coverage-matrix) for the binding table.

## Known Limitations

- **String-composition bypass**: `globalThis["f" + "s"]` evades the scanner. The manual-review backstop catches this; static analysis cannot.
- **Native addons**: `process.dlopen` or `require('node:module')._load` bypass static detection. Out of scope — `process` is blocklisted at the module level, so indirect paths via `process` still fail.
- **`exports` field in `package.json`**: Resolver honors `main` only (matches `ts-analyzer.mjs` default). Conditional `exports` resolution is deferred; see Q-PCC-3 in spec.

## See Also

- [PURE-COMPUTE-CHECK-API.md](PURE-COMPUTE-CHECK-API.md) — Module-by-module API reference
- [PURE-COMPUTE-CHECK-BLOCKLIST.md](PURE-COMPUTE-CHECK-BLOCKLIST.md) — Authoritative blocklist reference
- [SPEC-FRONTMATTER.md](SPEC-FRONTMATTER.md) — `pure_compute_entry_points` and `e2e_skip_rationale: pure-compute` enum
- [HOOKS.md](HOOKS.md) — Gate 5 hook integration surface
- Spec group: [`.claude/specs/groups/sg-e2e-pure-compute-check/spec.md`](../specs/groups/sg-e2e-pure-compute-check/spec.md)
- Parent MasterSpec: [`.claude/specs/groups/sg-e2e-runtime-connectivity/spec.md`](../specs/groups/sg-e2e-runtime-connectivity/spec.md)

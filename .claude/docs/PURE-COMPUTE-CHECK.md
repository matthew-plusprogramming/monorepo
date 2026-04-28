---
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
last_reviewed: 2026-04-27
---

# Pure-Compute Static-Analysis Sub-Check

Pure-compute validation is the static proof behind
`e2e_skip: true` plus `e2e_skip_rationale: pure-compute`. It runs inside
completion-verifier Gate 5 and fails the opt-out when declared entry points can
reach network, subprocess, filesystem-write, dynamic-code, dynamic-import, or
other disallowed runtime behavior.

The check is a library, not a live hook. It avoids hook sprawl and reuses the
spec/frontmatter context Gate 5 already reads.

## Runtime Contract

Input:

```js
checkPureCompute({
  specId: 'sg-example',
  entryPoints: ['src/example/index.ts'],
  tsconfigPath: 'tsconfig.json',
});
```

Output:

```js
{
  verdict: 'pass' | 'fail',
  violations: [
    {file, importSpecifier, symbol, pathToEntry}
  ]
}
```

`verdict` is `fail` exactly when `violations.length > 0`. Invalid input throws
a Zod validation error. Analysis failures do not throw; they become sentinel
violations.

## What It Checks

The walker starts from `pure_compute_entry_points` and follows the transitive
import graph:

- Static imports and re-exports.
- TypeScript `compilerOptions.paths` aliases.
- `node:` prefix normalization.
- Cycles through a two-state visited set.
- Type-only import filtering.
- Path containment through realpath plus strict-prefix checks.
- Callsite patterns that cannot be found from module specifiers alone.

It is intentionally conservative. Dead code can fail if it imports or
statically references a blocked symbol.

## Fail-Closed Sentinels

| Symbol | Trigger |
| --- | --- |
| `<dynamic-import>` | Any `import(...)` expression. |
| `<resolution-failed>` | Missing file, unresolvable alias, or containment escape. |
| `<parse-error>` | Syntax error or unreadable source file. |

Entry-point containment escapes also use `<resolution-failed>` so diagnostics
do not expose canonical filesystem paths.

## Modules

| Module | Role |
| --- | --- |
| `pure-compute-static-check.mjs` | Public entry point, input schema, result shape, error classes. |
| `pure-compute-walker.mjs` | DFS traversal, cycle handling, sentinel emission, canonical violation shape. |
| `pure-compute-resolver.mjs` | Relative, absolute, and tsconfig-path resolution with containment. |
| `pure-compute-extractor.mjs` | TypeScript AST extraction for imports, re-exports, dynamic imports, and parse errors. |
| `pure-compute-scanner.mjs` | Callsite scanner for fs writes, eval/function constructors, top-level fetch, timers, process exit, and OS network interfaces. |
| `pure-compute-matcher.mjs` | Blocklist, safelist, and sentinel factories. |
| `pure-compute-formatter.mjs` | Plain-text diagnostic formatting. |
| `path-containment.mjs` | Shared realpath containment helper. |

## Authoring Contract

For a pure-compute opt-out:

```yaml
e2e_skip: true
e2e_skip_rationale: pure-compute
pure_compute_entry_points:
  - src/my-feature/index.ts
```

Entry points are required for `pure-compute`. Use another rationale, or keep
runtime-connectivity tests enabled, when the implementation needs network,
subprocess, filesystem side effects, dynamic import, dynamic code execution, or
external state mutation.

Allowed examples:

- `fs.readFile(...)`
- `os.hostname()`
- `perf_hooks` or `node:perf_hooks`
- `fetch(...)` inside a function body
- `setTimeout(() => {}, 1)`

Blocked examples:

- `net`, `http`, `https`, `dns`, `dgram`, `tls`, `http2`
- `child_process`, `worker_threads`, `cluster`
- `diagnostics_channel`, `inspector`, `trace_events`, `readline`, `repl`
- `vm`, `eval(...)`, `Function(...)`, reflected function constructors
- `fs.writeFile(...)`, `fs.rename(...)`, `fs.unlink(...)`, and promises variants
- Top-level `fetch(...)`
- `os.networkInterfaces()`
- Any `import(...)`

See [PURE-COMPUTE-CHECK-BLOCKLIST.md](PURE-COMPUTE-CHECK-BLOCKLIST.md) for the
full blocklist and [PURE-COMPUTE-CHECK-API.md](PURE-COMPUTE-CHECK-API.md) for
exports and return shapes.

## Determinism

The check is a pure function of source files, tsconfig, and entry points. It
does not use network, subprocesses, wall-clock reads, or runtime execution.
Sibling edges are sorted before traversal so identical inputs produce stable
results.

## Tests

Focused tests:

- `.claude/scripts/__tests__/pure-compute-check/*.test.mjs`
- `.claude/scripts/__tests__/pure-compute-api-contract.test.mjs`

They cover API shape, tsconfig resolution, AST extraction, callsite scanning,
blocklist matching, DFS/cycles, diagnostics, path containment, fixtures, and
the Gate 5 API seam.

## See Also

- [PURE-COMPUTE-CHECK-API.md](PURE-COMPUTE-CHECK-API.md)
- [PURE-COMPUTE-CHECK-BLOCKLIST.md](PURE-COMPUTE-CHECK-BLOCKLIST.md)
- [SPEC-FRONTMATTER.md](SPEC-FRONTMATTER.md)
- [RUNTIME-CONNECTIVITY-AUTHORING.md](RUNTIME-CONNECTIVITY-AUTHORING.md)

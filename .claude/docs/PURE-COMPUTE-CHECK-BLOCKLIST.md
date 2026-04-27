---
_source_spec: sg-e2e-pure-compute-check
_source_modules:
  ['scripts-lib/pure-compute-matcher', 'scripts-lib/pure-compute-scanner']
title: Pure-Compute Static-Analysis Blocklist
last_reviewed: 2026-04-27
---

# Pure-Compute Static-Analysis Blocklist

This is the human-readable blocklist for specs using
`e2e_skip_rationale: pure-compute`. A match fails completion-verifier Gate 5.
The executable sources are `pure-compute-matcher.mjs` and
`pure-compute-scanner.mjs`.

## Rules

- `node:` prefixes are normalized before matching.
- Type-only imports are ignored by traversal.
- `perf_hooks` is the only safelisted module.
- Dynamic imports always fail.
- Structural failures use sentinel symbols and fail the verdict.
- Spec authors cannot extend or narrow this list locally.

## Module-Level Blocklist

Whole-module imports and re-exports fail for these specifiers.

| Category | Specifiers |
| --- | --- |
| Network | `net`, `http`, `https`, `dns`, `dgram`, `tls`, `http2` |
| Filesystem write path | `fs/promises` |
| Process and subprocess | `child_process`, `worker_threads`, `cluster` |
| Diagnostics | `diagnostics_channel`, `inspector`, `trace_events` |
| Interactive | `readline`, `repl` |
| Code execution | `vm` |

`node:fs/promises`, `node:http`, and similar prefixed forms match the same
entries.

`fs` by itself is not module-blocked. Read APIs can pass; write APIs are caught
by the scanner.

## Callsite-Level Blocklist

These expressions fail even when the containing module import is otherwise
allowed.

| Category | Patterns |
| --- | --- |
| Filesystem writes | `fs.writeFile`, `fs.writeFileSync`, `fs.appendFile`, `fs.appendFileSync`, `fs.rename`, `fs.renameSync`, `fs.unlink`, `fs.unlinkSync` |
| Filesystem promises writes | `fs.promises.writeFile`, `fs.promises.appendFile`, `fs.promises.rename`, `fs.promises.unlink`, including sync-name variants in the table |
| OS network inspection | `os.networkInterfaces()` |
| Process exit | `process.exit()` |
| Direct code execution | `eval`, `globalThis.eval`, `Function`, `new Function`, `globalThis.Function` |
| Async/generator constructors | `AsyncFunction`, `GeneratorFunction`, and `new` forms |
| Reflected constructors | `Object.getPrototypeOf(async () => {}).constructor`, `Reflect.getPrototypeOf(function*(){}).constructor`, and equivalent async/generator forms |
| Indirect eval timers | `setTimeout` or `setInterval` when the first argument is a string literal or no-substitution template |
| Top-level network call | Module-scope `fetch(...)` |

Allowed nearby patterns:

| Pattern | Reason |
| --- | --- |
| `fs.readFile(...)` | Filesystem reads are allowed. |
| `os.hostname()` | Only `os.networkInterfaces()` is blocked. |
| `setTimeout(() => {}, 1)` | Function callback is normal timer use. |
| `fetch(...)` inside a function | Only module-scope fetch is blocked. |

Namespace/default bindings are tracked for `fs`, `fs/promises`, and `os`, so
`import * as nfs from 'node:fs'; nfs.writeFile(...)` fails.

## Dynamic Imports

Every `import(...)` expression emits `<dynamic-import>`, regardless of whether
the argument is a static string or computed expression.

## Safelist

| Specifier | Result |
| --- | --- |
| `perf_hooks` | Pass |
| `node:perf_hooks` | Pass |

The safelist short-circuits module-level blocklist lookup. It does not hide
unrelated callsite violations in the same file.

## Sentinels

Sentinels are not direct blocklist entries, but they produce `verdict: 'fail'`.

| Symbol | Trigger |
| --- | --- |
| `<dynamic-import>` | Any dynamic import expression. |
| `<resolution-failed>` | Missing file, unresolved relative/absolute path, unresolved alias, containment escape, or entry-point escape. |
| `<parse-error>` | Syntax error or unreadable file. |

Entry-point escapes are reported as `<resolution-failed>` with the entry path
as both `file` and `importSpecifier`, avoiding disclosure of canonicalized
realpaths.

## Tests

Focused coverage lives under:

```text
.claude/scripts/__tests__/pure-compute-check/
.claude/scripts/__tests__/pure-compute-api-contract.test.mjs
```

Fixture directories cover network, filesystem writes, process, diagnostics,
interactive modules, code execution, dynamic import, top-level fetch, OS
functions, resolver behavior, and safe-path regressions.

## Change Policy

Additions are compatible when matcher/scanner tables and positive fixtures are
updated together. Removals are breaking because they weaken the proof behind
`pure-compute`.

## See Also

- [PURE-COMPUTE-CHECK.md](PURE-COMPUTE-CHECK.md)
- [PURE-COMPUTE-CHECK-API.md](PURE-COMPUTE-CHECK-API.md)

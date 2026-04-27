---
_source_modules: ['docs-scripts', 'trace-scripts']
---

# Trace System

The trace system is generated structural metadata for `.claude` source: module
membership, imports, exports, event patterns, call graph data, and cross-module
dependencies. It is an advisory navigation aid, not an authority over source.
Critical decisions must still be checked against current files.

## Current Policy

| Surface | Policy |
| --- | --- |
| `.claude/traces/trace.config.json` | committed source of module ids and file globs |
| `.claude/traces/high-level.json` | committed cross-module dependency graph |
| `.claude/traces/high-level.md` | committed human-readable routing/dispatch overview |
| `.claude/traces/low-level/*.json` | generated local module sidecars, gitignored |
| `.claude/traces/low-level/*.summary.json` | generated compact module sidecars, gitignored |
| `.claude/traces/low-level/*.calls.json` | generated call graph sidecars, gitignored and tool-only |
| `.claude/traces/low-level/*.md` | generated local module views, gitignored |
| `.claude/traces/staleness.json` | generated local incremental state, gitignored |

Normal agent context should start with `high-level.md`. Subagents may read
relevant low-level `.json` or `.summary.json` sidecars when they need
module/export context. Do not read `.calls.json` directly; use
`trace-query.mjs` for call-graph detail.

## Commands

| Command | Purpose |
| --- | --- |
| `node .claude/scripts/trace-generate.mjs` | Regenerate every trace output. |
| `node .claude/scripts/trace-generate.mjs --incremental` | Re-analyze changed files/modules using `staleness.json`. |
| `node .claude/scripts/trace-generate.mjs --full` | Force full regeneration. |
| `node .claude/scripts/trace-generate.mjs <module-id>` | Regenerate one module and refresh high-level traces. |
| `node .claude/scripts/trace-generate.mjs --low-level-only` | Skip high-level output. |
| `node .claude/scripts/trace-generate.mjs --bootstrap` | Create `trace.config.json` when absent. |
| `node .claude/scripts/trace-query.mjs --module <id>` | Show dependencies and dependents. |
| `node .claude/scripts/trace-query.mjs --module <id> --detail` | Include exports, imports, events, and sidecar-loaded calls. |
| `node .claude/scripts/trace-query.mjs --impact <file-path>` | Resolve the owning module and downstream impact. |
| `node .claude/scripts/trace-query.mjs --calls <name>` | Search callers/callees through sidecar calls data. |
| `node .claude/scripts/trace-diff.mjs --base main` | Produce a PR-level architectural diff. |
| `node .claude/scripts/trace-sync.mjs --dry-run` | Preview markdown-to-JSON sync. |
| `node .claude/scripts/trace-docs-sync.mjs` | Compare traces with structured docs. |

## Directory Layout

```text
.claude/traces/
  trace.config.json
  high-level.json
  high-level.md
  staleness.json
  low-level/
    <module-id>.json
    <module-id>.summary.json
    <module-id>.calls.json
    <module-id>.md
```

Current `.gitignore` keeps generated trace data local:

```gitignore
.claude/traces/staleness.json
.claude/traces/low-level/*.json
.claude/traces/low-level/*.calls.json
.claude/traces/low-level/*.md
!.claude/traces/trace.config.json
!.claude/traces/high-level.json
!.claude/traces/high-level.md
```

After cloning or after source changes, run `trace-generate.mjs` to refresh local
low-level sidecars.

## Configuration Contract

`trace.config.json` defines traceable modules.

```json
{
  "version": 1,
  "projectRoot": ".",
  "fileExtensions": [".mjs", ".js"],
  "globalExcludes": ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
  "modules": [
    {
      "id": "scripts-lib",
      "name": "Scripts Library",
      "description": "Shared utility library",
      "fileGlobs": [".claude/scripts/lib/**"]
    }
  ]
}
```

Required top-level fields: `version`, `projectRoot`, and `modules`.
`fileExtensions` defaults to `[".mjs", ".js"]`. `globalExcludes` defaults to
test globs only when omitted; an explicit empty array disables global excludes.

Each module needs:

| Field | Contract |
| --- | --- |
| `id` | unique lowercase id matching `^[a-z0-9-]+$` |
| `name` | human-readable label |
| `description` | optional module description |
| `fileGlobs` | relative glob patterns for files in the module |

`globalExcludes` entries must be relative strings. Absolute paths and `..`
path traversal are rejected. Exclusion wins when a file matches both
`fileGlobs` and `globalExcludes`; excluding nearly all files in a module emits
a warning.

## Generation Output

`trace-generate.mjs` uses `.claude/scripts/lib/ts-analyzer.mjs` by default. The
analyzer uses the TypeScript compiler API for JS/TS-family files, imports,
re-exports, nested calls, signatures, and line numbers. A regex analyzer is
still available through `analyzeFile(..., { parser: 'regex' })`.

Per-file trace entries record:

- `filePath`
- `exports[]`
- `imports[]`
- `events[]`

Calls are produced by analysis but stored outside the main module JSON in
`<module-id>.calls.json`.

Event detection covers string-literal event names for `.emit(`, `.dispatch(`,
`.trigger(`, `.on(`, `.addEventListener(`, `.subscribe(`, `.once(`, and
`.addListener(`.

## Sidecar Calls Contract

Main low-level JSON references the call sidecar through `callsFile`.

```json
{
  "moduleId": "trace-scripts",
  "version": 10,
  "callsFile": "trace-scripts.calls.json",
  "files": [
    {
      "filePath": ".claude/scripts/trace-generate.mjs",
      "exports": [],
      "imports": [],
      "events": []
    }
  ]
}
```

The sidecar is keyed by source file path:

```json
{
  ".claude/scripts/trace-generate.mjs": [
    {
      "callerFile": ".claude/scripts/trace-generate.mjs",
      "callerLine": 40,
      "calleeName": "loadTraceConfig",
      "calleeFile": ".claude/scripts/lib/trace-utils.mjs",
      "calleeLine": 200
    }
  ]
}
```

Current-format main JSON does not include per-file `calls[]`. Empty call data
is `{}`. `trace-query.mjs` and `trace-diff.mjs` load `callsFile` when present
and fall back to legacy inline `file.calls` for old traces. Missing or corrupt
sidecars return empty calls with a stderr warning.

Sidecars are written through temp-file plus rename. Startup cleanup removes old
`.tmp.*` files. Rename failures log the OS error, clean up best-effort, and do
not block unrelated module generation. Sidecars over 10 MB warn but generation
continues.

## Staleness and Integrity

`staleness.json` stores file hashes, last-traced timestamps, module export
signature hashes, and `externalRefs` for cross-module propagation. Export
signature hashes include export name, kind, and parameter names; they ignore
comments, whitespace, and function bodies.

Incremental generation marks a module stale when its file hash changes. Export
signature changes also mark dependent modules stale through `externalRefs`;
propagation stops at depth 3 with a warning.

If `staleness.json` is missing or invalid, generation falls back to full mode
and rewrites the file. Trace files are written before `staleness.json`, so an
interrupted run only causes safe redundant regeneration later.

`validateTraceIntegrity()` requires generated metadata, a plausible
`lastGenerated`, no future timestamp beyond allowed skew, and age not older
than the long-term freshness ceiling. Invalid traces are unavailable to
consumers.

## Query, Sync, and Diff

`trace-query.mjs` reads trace data for operators and scripts. `--impact`
validates file paths stay inside the project root.

`trace-sync.mjs` parses structured markdown sections and updates JSON. Calls
are written to sidecars, not reintroduced inline. Supported sections:
Dependencies, Dependents, Exports, Imports, Function Calls, and Events.
Sections marked "(not synced)" are freeform. `--auto-merge` accepts additions;
deletions and modifications require manual resolution.

`trace-diff.mjs` compares current trace data with a validated base ref loaded
through `git show`. `.calls.json` files are skipped as primary inputs to avoid
double-counting sidecars; call data is loaded through the owning main trace.

## Trace-to-Docs Bridge

| Script | Trace use |
| --- | --- |
| `docs-validate.mjs` | Compares `architecture.yaml` module refs with traced modules. Missing docs/traces are warnings or info. |
| `docs-scaffold.mjs` | Pre-populates TODO placeholders from trace exports, dependencies, and descriptions. |
| `trace-docs-sync.mjs` | Reports divergence between trace data and structured docs without modifying docs. |

`trace-docs-sync.mjs` is diagnostic only. Human review remains required before
structured docs are changed.

## Consumer: Flow-Verifier Diff-Scope

Flow-verifier (`/flow-verify`) uses trace data to limit impl-verify and
post-impl verification to files changed in the current branch diff. The
dispatch-side contract is in [FLOW-VERIFIER.md § Diff-Scope Mode](FLOW-VERIFIER.md#diff-scope-mode).

### fileGlobs -> Module ID Mapping

`trace.config.json` `modules[].fileGlobs` is the authoritative changed-file to
module-id mapping:

```text
git diff --name-only <base>..HEAD
for each changed file:
  for each module in trace.config.json:
    if minimatch(file, module.fileGlobs):
      affected_modules.add(module.id)
```

Helper entry point:
`.claude/scripts/lib/flow-verify-diff-scope.mjs` exports
`resolveDiffScope({ base, stage })`, returning
`{ scope, changed_files, affected_modules, fallback }`.

### Trace Sidecar Consumption

For each affected module, flow-verifier may read the base low-level trace
sidecar (`low-level/<module-id>.json`) under the root trace contract. It does
not read `.calls.json` directly; call-graph detail goes through
`trace-query.mjs`.

| Sidecar | Flow-verifier use |
| --- | --- |
| `low-level/<module-id>.json` | exports, imports, events per file |
| `low-level/<module-id>.summary.json` | optional compact structural overview |
| `low-level/<module-id>.calls.json` | not read directly; tool-only |

### Staleness and Fallback

When a module trace is stale, flow-verifier may still consume it as advisory
context, but it verifies critical assumptions against source before blocking or
passing an irreversible gate. Output records partial coverage with
`stale_modules`.

When no trace data exists for a changed file, flow-verifier falls back to
Grep/Glob source analysis, records partial coverage, and reports
`unchecked_files`.

| Scenario | Diff-scope outcome |
| --- | --- |
| empty diff | trivial pass; no trace reads |
| non-empty diff, no `fileGlobs` match | trivial pass with structured log noting no affected modules |
| new boundary-crossing symbols | degrade to full scope and read all module sidecars |

## Validation and Safety

| Check | Behavior |
| --- | --- |
| low-level trace schema | validates metadata, files, exports, imports, events, optional `callsFile`, and legacy inline calls |
| path traversal | `trace-query.mjs` rejects paths outside the project root |
| git ref validation | `trace-diff.mjs` rejects refs with shell metacharacters |
| main JSON size > 500 KB | warn |
| main JSON size > 1 MB | warn and flag module for split |
| sidecar size > 10 MB | warn |

File size warnings do not block generation.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Module id not found | Inspect `.claude/traces/trace.config.json`. |
| High-level trace missing | Run `node .claude/scripts/trace-generate.mjs`. |
| Low-level traces missing after clone | Regenerate; low-level traces and `staleness.json` are local generated state. |
| Sidecar missing or corrupt | Use `trace-query.mjs`; it warns and returns empty calls. Regenerate if call data matters. |
| `staleness.json` corrupt | Regenerate; the system falls back to full mode. |
| Analysis warning for a file | Treat as advisory; binary, permission, or syntax-problem files receive empty arrays. |
| Incremental run not faster | Confirm `--incremental` is used and `staleness.json` exists. |
| `globalExcludes` rejected | Use relative patterns only; remove absolute paths and `..`. |

## Scripts Reference

| Script | Purpose |
| --- | --- |
| `trace-generate.mjs` | generate high-level and low-level trace outputs |
| `trace-query.mjs` | query dependencies, impact, and call graphs |
| `trace-sync.mjs` | sync trace markdown edits back to JSON/sidecars |
| `trace-diff.mjs` | summarize architectural changes versus a git ref |
| `trace-docs-sync.mjs` | compare traces against structured docs |
| `lib/trace-utils.mjs` | config loading, staleness, hashing, validation |
| `lib/ts-analyzer.mjs` | TypeScript compiler-based analysis |
| `lib/high-level-trace.mjs` | high-level trace generation |

## See Also

- [STRUCTURED-DOCS.md](STRUCTURED-DOCS.md) - structured docs and trace bridge
- [HOOKS.md](HOOKS.md) - live hook inventory and hook placement
- [SYNC-SYSTEM.md](SYNC-SYSTEM.md) - registry sync for trace scripts/docs
- [FLOW-VERIFIER.md](FLOW-VERIFIER.md) - diff-scope consumer of `fileGlobs`

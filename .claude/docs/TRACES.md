---
_source_modules: ['docs-scripts', 'trace-scripts']
---

# Trace System

Automated structural analysis of the codebase. Generates module-level and file-level traces with import/export maps, call graphs, event patterns, and cross-module dependency tracking.

---

## Overview

The trace system consists of:

- **Configuration**: `trace.config.json` defines modules, file globs, and global exclusion patterns
- **Generation**: `trace-generate.mjs` analyzes source files and produces trace data with sidecar calls files
- **Query**: `trace-query.mjs` provides dependency, impact, and call graph queries (transparently reads sidecar files)
- **Sync**: `trace-sync.mjs` syncs markdown edits back to JSON (writes calls to sidecar files)
- **Diff**: `trace-diff.mjs` generates PR-level architectural change summaries (reads calls from sidecar files)
- **Staleness**: `staleness.json` tracks file-level hashes for incremental regeneration
- **Docs Bridge**: `trace-docs-sync.mjs` compares trace data against structured docs

All trace files live under `.claude/traces/`. Low-level traces are per-module; high-level traces aggregate cross-module dependencies. Regenerable trace files are excluded from git via `.gitignore`; only `trace.config.json`, `high-level.json`, `high-level.md`, and documentation are committed.

---

## Quick Start

```bash
# Generate all traces (full mode)
node .claude/scripts/trace-generate.mjs

# Generate traces for a single module
node .claude/scripts/trace-generate.mjs <module-id>

# Bootstrap: auto-detect modules and create trace.config.json
node .claude/scripts/trace-generate.mjs --bootstrap

# Query a module's dependencies
node .claude/scripts/trace-query.mjs --module <id>

# Analyze impact of changing a file
node .claude/scripts/trace-query.mjs --impact <file-path>

# Query callers/callees of a function
node .claude/scripts/trace-query.mjs --calls <functionName>

# Generate PR architectural diff
node .claude/scripts/trace-diff.mjs --base main
```

---

## Directory Structure

```
.claude/traces/
  trace.config.json              # Module definitions and file globs (committed)
  staleness.json                 # Per-file hashes for incremental generation (gitignored)
  high-level.json                # Cross-module dependency graph (committed)
  high-level.md                  # Human-readable dependency view (committed)
  low-level/
    <module-id>.json             # Per-module structural data (gitignored)
    <module-id>.calls.json       # Per-module calls data sidecar (gitignored)
    <module-id>.md               # Human-readable module view (gitignored)
```

### Git Tracking

Regenerable trace files are excluded from git to reduce repository size and accidental read surface. The `.gitignore` rules:

```gitignore
.claude/traces/staleness.json
.claude/traces/low-level/*.json
.claude/traces/low-level/*.calls.json
.claude/traces/low-level/*.md
!.claude/traces/trace.config.json
!.claude/traces/high-level.json
!.claude/traces/high-level.md
```

After cloning, run `node .claude/scripts/trace-generate.mjs` to regenerate local trace files.

---

## Configuration

### trace.config.json

Defines which modules exist, which files belong to each module, and which files to exclude globally.

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
      "description": "Shared utility library for trace and docs scripts",
      "fileGlobs": [".claude/scripts/lib/**"]
    }
  ]
}
```

| Field          | Type     | Required | Description                                              |
| -------------- | -------- | -------- | -------------------------------------------------------- |
| version        | number   | Yes      | Config schema version (current: 1)                       |
| projectRoot    | string   | Yes      | Project root path (usually ".")                          |
| fileExtensions | string[] | No       | File extensions to trace (default: `[".mjs", ".js"]`)    |
| globalExcludes | string[] | No       | Glob patterns for files excluded from all module tracing |
| modules        | array    | Yes      | List of module definitions                               |

Each module requires:

| Field       | Type     | Required | Description                                 |
| ----------- | -------- | -------- | ------------------------------------------- |
| id          | string   | Yes      | Unique identifier (pattern: `^[a-z0-9-]+$`) |
| name        | string   | Yes      | Human-readable name                         |
| description | string   | No       | Module description                          |
| fileGlobs   | string[] | Yes      | Glob patterns matching module files         |

### globalExcludes

Controls which files are excluded from tracing across all modules.

| Scenario                                           | Behavior                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| Field omitted                                      | Defaults applied: `["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"]` |
| Explicit patterns (e.g., `["**/*.stories.ts"]`)    | Only specified patterns applied; defaults not merged                    |
| Explicit empty array `[]`                          | No files excluded (overrides defaults)                                  |
| File matches both `fileGlobs` and `globalExcludes` | File is excluded (exclusion takes precedence)                           |
| Pattern matches >90% of a module's files           | Warning logged identifying the pattern and module                       |
| All files in a module excluded                     | Empty `files` array produced; warning logged                            |

**Validation rules**:

- Patterns containing `..` (path traversal) are rejected with an error
- Patterns starting with `/` (absolute paths) are rejected with an error
- Each element must be a string

---

## Trace Generation

| Command | Effect |
| --- | --- |
| `node .claude/scripts/trace-generate.mjs` | Full generation for every module. Writes low-level JSON/markdown, sidecar calls files, high-level JSON/markdown, and `staleness.json`. |
| `node .claude/scripts/trace-generate.mjs --incremental` | Uses `staleness.json` hashes to re-analyze changed files and modules affected by export-signature changes. |
| `node .claude/scripts/trace-generate.mjs --full` | Forces full regeneration regardless of staleness state. |
| `node .claude/scripts/trace-generate.mjs <module-id>` | Regenerates one module's low-level trace and updates the high-level trace. |
| `node .claude/scripts/trace-generate.mjs --low-level-only` | Skips high-level trace generation. |
| `node .claude/scripts/trace-generate.mjs --bootstrap` | Creates `trace.config.json` from detected `apps/`, `packages/`, `.claude/scripts/`, and `src/` directories when config is absent. |

Per-module output: `low-level/<module-id>.json`, `low-level/<module-id>.calls.json`, and `low-level/<module-id>.md`. Project output: `high-level.json`, `high-level.md`, and `staleness.json`.

---

## Sidecar Calls Files

Calls data is stored in `low-level/<module-id>.calls.json` sidecars instead of inline in the main trace JSON. Main trace files reference sidecars through top-level `callsFile`.

### Format

Each sidecar file is a JSON object keyed by source file path:

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
  ],
  ".claude/scripts/trace-query.mjs": []
}
```

### Main Trace JSON Reference

The main trace JSON references its sidecar file via a top-level `callsFile` field:

```json
{
  "moduleId": "trace-scripts",
  "version": 10,
  "callsFile": "trace-scripts.calls.json",
  "files": [
    {
      "filePath": "...",
      "exports": [],
      "imports": [],
      "events": []
    }
  ]
}
```

File entries in main JSON do not carry `calls[]` in the current format. When no calls exist, the sidecar is `{}`.

### Atomic Write Safety

Sidecars use write-to-temp plus rename. Temp filenames include the process id; startup deletes stale `.tmp.*` files older than 1 hour. Rename failure logs the OS error, cleans temp best-effort, and continues other modules. Sidecar files over 10 MB warn but do not block generation.

### Backward Compatibility

`trace-query.mjs` reads `callsFile` when present and falls back to inline `file.calls` for old traces. Missing or corrupt sidecars return empty calls with a stderr warning.

---

## Analysis Engine

### TypeScript Compiler API (Default)

The default analyzer is `.claude/scripts/lib/ts-analyzer.mjs`. It uses the TypeScript compiler API for imports/re-exports, nested calls, signatures, and JS/TS-family files.

### Regex Fallback

A regex analyzer remains available through `analyzeFile(filePath, projectRoot, { parser: 'regex' })`.

### Configurable File Extensions

File extensions come from `trace.config.json` or default to `[".mjs", ".js"]`.

---

## File Analysis Output

Each file entry records `filePath`, `exports[]`, `imports[]`, and `events[]`. Calls are produced by analysis but persisted in the sidecar file referenced by `callsFile`.

### Call Graph (calls[])

Calls resolve against imported symbols and the cross-module export index. External packages and unresolved local functions use `calleeFile: null` and `calleeLine: null`.

### Event Patterns (events[])

Detected patterns:

| Pattern              | Type      |
| -------------------- | --------- |
| `.emit(`             | emit      |
| `.dispatch(`         | emit      |
| `.trigger(`          | emit      |
| `.on(`               | subscribe |
| `.addEventListener(` | subscribe |
| `.subscribe(`        | subscribe |
| `.once(`             | subscribe |
| `.addListener(`      | subscribe |

Only string-literal event names are captured.

---

## Staleness and Incremental Generation

### staleness.json

`.claude/traces/staleness.json` tracks per-file hashes, last-traced timestamps, module export signature hashes, and `externalRefs` for cross-module propagation.

```json
{
  "version": 1,
  "modules": {
    "scripts-lib": {
      "exportSignatureHash": "f7e8d9c0b1a2...",
      "files": {
        ".claude/scripts/lib/trace-utils.mjs": {
          "hash": "a1b2c3d4e5f6...",
          "lastTraced": "2026-03-20T10:00:00Z",
          "externalRefs": {
            "trace-scripts": ["loadTraceConfig", "findFilesMatchingGlobs"]
          }
        }
      }
    }
  }
}
```

### Export Signature Hashing

Export signature hashes cover export name, kind, and parameter names. They ignore comments, whitespace, and function bodies. A signature change marks dependent modules stale through `externalRefs`.

### Cross-Module Staleness Propagation

Propagation follows export-signature changes through `externalRefs` and stops at depth 3 with a warning.

### Integrity Validation

`staleness.json` is validated against its schema on load. If corrupt or malformed:

1. A warning is logged to stderr
2. The system falls back to `--full` regeneration
3. `staleness.json` is recreated from scratch

### Write Ordering

Trace files are written before `staleness.json`. If interrupted between writes, the stale metadata causes a safe redundant re-trace on the next run.

---

## Trace Query

| Command | Purpose |
| --- | --- |
| `node .claude/scripts/trace-query.mjs --module <id>` | Show upstream dependencies and downstream dependents. |
| `node .claude/scripts/trace-query.mjs --module <id> --detail` | Include file exports, imports, events, and call data loaded through sidecars. |
| `node .claude/scripts/trace-query.mjs --impact <file-path>` | Resolve owning module and affected downstream modules. Rejects paths outside project root. |
| `node .claude/scripts/trace-query.mjs --calls <functionName>` | Search callers/callees using sidecar calls data or legacy inline calls. |

---

## Trace Sync (Markdown to JSON)

```bash
node .claude/scripts/trace-sync.mjs              # Normal sync with conflict detection
node .claude/scripts/trace-sync.mjs --force       # Force sync (markdown wins)
node .claude/scripts/trace-sync.mjs --dry-run     # Preview changes
node .claude/scripts/trace-sync.mjs --auto-merge  # Auto-merge additions; flag deletions
```

Parses structured markdown trace sections and updates JSON. Calls are written to sidecar files, not inline main JSON. Synced sections: Dependencies, Dependents, Exports, Imports, Function Calls, and Events. Sections marked "(not synced)" are freeform. `--auto-merge` accepts additions; deletions and modifications require manual resolution.

---

## PR Trace Diff

```bash
node .claude/scripts/trace-diff.mjs              # Compare against main
node .claude/scripts/trace-diff.mjs --base <ref>  # Compare against specific branch
```

Compares current trace data with a base ref and reports module/export/dependency/call/event changes. Base traces are loaded with `git show`; ref names are validated before use. `.calls.json` files are skipped as main trace inputs to avoid double-counting sidecars.

---

## Trace-Informed Routing

`/route` may read `high-level.json` to identify affected modules and enrich dispatch prompts with relevant low-level trace files. Missing or invalid traces are advisory only; routing proceeds from source/task context.

---

## Trace Integrity Validation

`validateTraceIntegrity()` requires `generatedBy`, plausible `lastGenerated`, no future timestamp beyond 60-second skew, and age <= 1 year. Failures make trace data unavailable to consumers.

---

## Trace File Size Thresholds

| Threshold            | Behavior                                             |
| -------------------- | ---------------------------------------------------- |
| 500 KB (main JSON)   | Warning logged to stderr                             |
| 1 MB (main JSON)     | Warning promoted to stderr; module flagged for split |
| 10 MB (sidecar file) | Warning logged with file path and actual size        |

Generation is never blocked by file size.

---

## Trace Validation

### Low-Level Trace Schema

`validateLowLevelTrace()` checks required top-level metadata, `files[]`, optional `callsFile`, file exports/imports/events, legacy inline `calls[]` when present, and event/call entry shapes.

### Path Traversal Protection

`validateFilePath()` in `trace-query.mjs` resolves file path inputs via `path.resolve()` and validates they stay within the project root. Paths that escape the project boundary are rejected with an error.

`validateGitRef()` in `trace-diff.mjs` validates git ref names against a pattern that rejects shell metacharacters.

---

## Trace-to-Docs Bridge

| Script | Trace use |
| --- | --- |
| `docs-validate.mjs` | Compares `architecture.yaml` module references with traced modules. Missing docs/traces are warnings or info; no architecture file skips silently. |
| `docs-scaffold.mjs` | Pre-populates TODO placeholders from trace exports, dependencies, and module descriptions; human review remains required. |
| `trace-docs-sync.mjs` | Reports divergence between trace data and structured docs without modifying docs. |

```bash
node .claude/scripts/trace-docs-sync.mjs
```

`trace-docs-sync.mjs` report example:

```
Trace-Docs Sync Report
======================

Module: scripts-lib
  New exports not in docs: parseCallGraph, parseEventPatterns
  Removed exports still in docs: (none)
  Changed dependencies: +trace-scripts (new)

Summary: 1 module(s) with divergence, 2 new export(s), 0 removed export(s)
```


---

## Scripts Reference

| Script                     | Purpose                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `trace-generate.mjs`       | Generate trace files with sidecar calls separation                |
| `trace-query.mjs`          | Query dependencies, impact, and call graphs                       |
| `trace-sync.mjs`           | Sync markdown edits back to JSON and sidecar files                |
| `trace-diff.mjs`           | Generate PR-level architectural change diff                       |
| `trace-docs-sync.mjs`      | Compare traces against architecture.yaml                          |
| `lib/trace-utils.mjs`      | Shared utilities (config loading, staleness, hashing, validation) |
| `lib/ts-analyzer.mjs`      | TypeScript compiler-based source analyzer                         |
| `lib/high-level-trace.mjs` | High-level trace generation                                       |

---

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Module not found in `trace.config.json` | Inspect `.claude/traces/trace.config.json` module ids. |
| High-level trace missing | Run `node .claude/scripts/trace-generate.mjs`. |
| Low-level traces missing after clone | Regenerate; low-level JSON, markdown, calls sidecars, and `staleness.json` are gitignored. |
| Sidecar missing or corrupt | Calls queries return empty calls with warnings; regenerate traces. |
| `staleness.json` corrupt | The system falls back to full regeneration and rewrites it. |
| Trace analysis failed for a file | Warning only; binary, permission, or syntax-problem files get empty trace arrays. |
| Incremental generation not reducing time | Use `--incremental`; default generation is full. |
| `globalExcludes` rejected | Use relative patterns only; `..` and absolute paths are rejected. |

---

## Consumer: Flow-Verifier Diff-Scope

Flow-verifier (`/flow-verify`) consumes trace data to scope impl-verify and post-impl verification to files changed in the current branch diff. See [FLOW-VERIFIER.md § Diff-Scope Mode](FLOW-VERIFIER.md#diff-scope-mode) for the dispatch-side contract.

### fileGlobs -> Module ID Mapping

The `trace.config.json` `modules[].fileGlobs` field is the authoritative mapping used by the flow-verifier to resolve changed files to affected modules. Pipeline:

```
git diff --name-only <base>..HEAD     ->  changed-files list
for each changed file:
  for each module in trace.config.json:
    if minimatch(file, module.fileGlobs):
      affected_modules.add(module.id)
```

Helper entry point: `.claude/scripts/lib/flow-verify-diff-scope.mjs` exports `resolveDiffScope({ base, stage })` returning `{ scope, changed_files, affected_modules, fallback }`.

### Trace Sidecar Consumption

For each affected module, the flow-verifier reads the base low-level trace sidecar (`low-level/<module-id>.json`) per the agent-readable-sidecar rule in CLAUDE.md § Trace Context for Subagents. The `.calls.json` sidecar is NOT read directly by the flow-verifier -- it uses the offline `trace-query.mjs` tool when call-graph data is required.

| Sidecar                              | Flow-Verifier Reads? | Purpose                                          |
| ------------------------------------ | -------------------- | ------------------------------------------------ |
| `low-level/<module-id>.json`         | Yes                  | Exports, imports, events per file                |
| `low-level/<module-id>.summary.json` | Yes (optional)       | Compact structural overview (file/export counts) |
| `low-level/<module-id>.calls.json`   | No                   | Reserved for `trace-query.mjs` offline tooling   |

### Staleness and Fallback

When a module's trace is stale (mtime older than staleness threshold per `isTraceStale()` in `lib/trace-utils.mjs`), the flow-verifier:

1. Still consumes the stale sidecar (advisory per agent-side trace contract)
2. Verifies critical assumptions (file existence, export availability) against source before irreversible gate decisions
3. Records `coverage: "partial"` in the output with `stale_modules: [...]`

When no trace data exists for a changed file (new module not yet in `trace.config.json`, or file outside all module `fileGlobs`), the flow-verifier degrades to Grep/Glob source analysis capped at 500 files and 120 seconds, returning `coverage: "partial"` and an `unchecked_files` array. See [FLOW-VERIFIER.md § Fallback Behavior](FLOW-VERIFIER.md#fallback-behavior).

### Empty-Diff and New-Symbol Degradation

| Scenario                                       | Diff-Scope Outcome                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `git diff --name-only` returns zero files      | Trivial-pass; no trace reads performed                                              |
| Non-empty diff, no files match any `fileGlobs` | Trivial-pass; structured log records `changed_files > 0` with `affected_modules: 0` |
| Diff introduces new boundary-crossing symbols  | Degrade to full-scope (NFR-10); read all module sidecars                            |

Cross-reference: [ws-3 spec Flow 1 sequence diagram](../specs/groups/sg-pipeline-efficiency-ws3-orchestrator-hygiene/spec.md#flow-verify-diff-scope-dispatch).

---

## See Also

- [Structured Documentation System](STRUCTURED-DOCS.md) -- YAML documentation with trace bridge integration
- [Hooks System](HOOKS.md) -- live hook inventory and hook placement reference
- [Sync System](SYNC-SYSTEM.md) -- Registry sync for distributing trace scripts
- [Flow Verifier](FLOW-VERIFIER.md) -- Consumer of `trace.config.json` fileGlobs for diff-scope mode

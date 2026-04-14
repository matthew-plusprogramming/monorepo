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

All trace files live under `.claude/traces/`. Low-level traces are per-module; high-level traces aggregate cross-module dependencies. Regenerable trace JSON files (low-level traces and sidecar files) are excluded from git via `.gitignore`; only `trace.config.json`, `high-level.json`, and `high-level.md` are committed.

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
  staleness.json                 # Per-file hashes for incremental generation
  high-level.json                # Cross-module dependency graph (committed)
  high-level.md                  # Human-readable dependency view (committed)
  low-level/
    <module-id>.json             # Per-module structural data (gitignored)
    <module-id>.calls.json       # Per-module calls data sidecar (gitignored)
    <module-id>.md               # Human-readable module view (gitignored)
```

### Git Tracking

Regenerable trace JSON is excluded from git to reduce repository size. The `.gitignore` rules:

```gitignore
.claude/traces/low-level/*.json
.claude/traces/low-level/*.calls.json
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

### Full Generation

Default mode. Analyzes all files in all modules (after applying `globalExcludes` filters) and regenerates all traces.

```bash
node .claude/scripts/trace-generate.mjs
```

Output per module:

- `low-level/<module-id>.json` -- canonical structural data (calls externalized to sidecar)
- `low-level/<module-id>.calls.json` -- sidecar file containing per-file calls data
- `low-level/<module-id>.md` -- human-readable markdown view

Output for the project:

- `high-level.json` -- cross-module dependency graph
- `high-level.md` -- human-readable dependency view
- `staleness.json` -- per-file hashes (rebuilt from scratch)

### Incremental Generation

When `staleness.json` exists and the `--incremental` flag is passed (typically by the commit-staleness hook), only files whose content hash has changed are re-analyzed.

Incremental generation:

1. Loads `staleness.json` and computes SHA-256 hash of each source file
2. Compares against stored hashes; files with matching hashes are skipped
3. Regenerates modules that contain stale files
4. Computes new export signature hashes; if a module's export signature changes, dependent modules' files are marked stale via `externalRefs`
5. Updates `staleness.json` after all trace files are written

```bash
# Force full regeneration (escape hatch)
node .claude/scripts/trace-generate.mjs --full
```

The `--full` flag forces complete regeneration regardless of staleness state. It recomputes all hashes in `staleness.json` from source content.

### Single Module

```bash
node .claude/scripts/trace-generate.mjs <module-id>
```

Regenerates only the specified module's low-level trace, then updates the high-level trace.

### Low-Level Only

```bash
node .claude/scripts/trace-generate.mjs --low-level-only
```

Skips high-level trace generation.

### Bootstrap

```bash
node .claude/scripts/trace-generate.mjs --bootstrap
```

Auto-detects modules from the project structure and creates `trace.config.json`. Scans `apps/`, `packages/`, `.claude/scripts/`, and `src/` directories. Only runs when `trace.config.json` does not already exist.

---

## Sidecar Calls Files

Calls data (function call sites) is stored in separate sidecar files rather than inline in the main trace JSON. This reduces main trace file sizes by 60-80%, bringing total committed trace data from ~20MB to under 5MB.

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

**Naming convention**: `low-level/<module-id>.calls.json`

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

File entries in the main JSON no longer contain a `calls` array. When no calls data exists for a module, `callsFile` is set to the sidecar path and the sidecar contains an empty object `{}`.

### Atomic Write Safety

Sidecar files are written using an atomic write-then-rename pattern:

1. Write to temporary file: `<module-id>.calls.json.tmp.<process-pid>`
2. Rename to final path: `<module-id>.calls.json`

If `rename()` fails (e.g., permissions error), the error is logged with the OS error code, the temp file is cleaned up (best-effort), and generation continues for remaining modules.

### Concurrent Safety

Multiple `trace-generate.mjs` processes use PID-based temp filenames, preventing write collisions. Last-writer-wins on the final rename without corruption.

### Stale Temp File Cleanup

On startup, `trace-generate.mjs` scans `low-level/` for `.tmp.*` files older than 1 hour and deletes them. These accumulate from crashed or interrupted generation processes.

### Size Warnings

When a sidecar file exceeds 10MB, a warning is logged with the file path and actual size. Generation completes normally.

### Backward Compatibility

- **Old trace-query reading new format**: An older `trace-query.mjs` that does not support sidecar reads will find no inline `calls` array and return empty results for calls queries. No crash occurs.
- **New trace-query reading old format**: When no `callsFile` reference exists, the query falls back to reading inline `file.calls` if present.
- **Missing sidecar**: Returns empty calls array with a warning logged to stderr.
- **Corrupt sidecar (parse error)**: Returns empty calls array with a warning identifying the file and parse error.

---

## Analysis Engine

### TypeScript Compiler API (Default)

The trace system uses the TypeScript compiler API (`ts-analyzer.mjs`) by default for source analysis. This provides AST-based accuracy for:

- Destructured imports and re-exports
- Nested function calls and method chains
- Complex function signatures
- Correct handling of `.mjs`, `.js`, `.ts`, `.tsx`, `.jsx`, `.cjs` files

The analyzer uses `allowJs` and `checkJs` settings to handle JavaScript files natively.

### Regex Fallback

A legacy regex-based analyzer is available as a fallback:

```javascript
import { analyzeFile } from '.claude/scripts/trace-generate.mjs';

// Use regex analyzer explicitly
const result = analyzeFile(filePath, projectRoot, { parser: 'regex' });
```

### Configurable File Extensions

The analyzer accepts configurable file extensions via the `config` parameter. Default: `['.mjs', '.js']`.

```javascript
const result = analyzeFile(filePath, projectRoot, {
  fileExtensions: ['.mjs', '.js', '.ts'],
});
```

---

## File Analysis Output

Each file analyzed by `analyzeFile()` produces:

```javascript
{
  filePath: ".claude/scripts/trace-generate.mjs",
  exports: [
    {
      symbol: "parseCallGraph",
      type: "function",            // function | class | interface | type | const | enum | default
      lineNumber: 554,
      signature: "(source, importMap, knownExports, filePath)",
      signatureRaw: "(source, importMap, knownExports, filePath)"
    }
  ],
  imports: [
    { source: "./lib/trace-utils.mjs", symbols: ["loadTraceConfig", "findFilesMatchingGlobs"] }
  ],
  calls: [
    {
      callerFile: ".claude/scripts/trace-generate.mjs",
      callerLine: 801,
      calleeName: "parseCallGraph",
      calleeFile: ".claude/scripts/trace-generate.mjs",  // null if unresolved
      calleeLine: 554                                      // null if unresolved
    }
  ],
  events: [
    {
      file: ".claude/scripts/lib/sdlc-events.mjs",
      line: 42,
      eventName: "task:complete",
      type: "emit"    // "emit" or "subscribe"
    }
  ]
}
```

Note: In the persisted main trace JSON, the `calls` array is moved to the sidecar file. The analysis output above shows the full structure before sidecar separation.

### Call Graph (calls[])

Populated by detecting `identifier(` patterns in source code. Each call is resolved against:

1. Imported symbols (from the file's import statements)
2. Known exports (cross-module export index built from all traced modules)

Unresolved callees (external packages, local-only functions) have `calleeFile: null` and `calleeLine: null`.

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

Only string literal event names are captured (template literals and variables are excluded).

---

## Staleness and Incremental Generation

### staleness.json

Located at `.claude/traces/staleness.json`. Tracks per-file content hashes and cross-module dependency references.

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

| Field                 | Description                                               |
| --------------------- | --------------------------------------------------------- |
| `version`             | Schema version (current: 1)                               |
| `modules.<id>.files`  | Per-file hash and last-traced timestamp                   |
| `exportSignatureHash` | Hash of module's export signatures (name + kind + params) |
| `externalRefs`        | Which symbols this file imports from which other modules  |

### Export Signature Hashing

The export signature hash covers export name, kind (function/const/class/type), and parameter names. It excludes JSDoc comments, whitespace, and function bodies. A parameter addition or rename changes the hash; a body-only edit does not.

When a module's export signature hash changes, files in dependent modules that have `externalRefs` pointing to the changed module are marked stale.

### Cross-Module Staleness Propagation

Propagation is gated by export signature hash comparison and capped at depth 3:

1. Module A's export signature hash changes
2. Files in Module B with `externalRefs` to Module A are marked stale
3. If Module B is then regenerated and its export signature changes, propagation continues to Module C
4. Propagation stops at depth 3 with a warning

### Integrity Validation

`staleness.json` is validated against its schema on load. If corrupt or malformed:

1. A warning is logged to stderr
2. The system falls back to `--full` regeneration
3. `staleness.json` is recreated from scratch

### Write Ordering

All trace and staleness writes use atomic write-rename (write to `.tmp`, then rename). Write ordering: trace file first, then `staleness.json`. If interrupted between the two, `staleness.json` lags behind, causing a safe redundant re-trace on next run (self-healing).

---

## Trace Query

### Module Dependencies

```bash
node .claude/scripts/trace-query.mjs --module <id>
node .claude/scripts/trace-query.mjs --module <id> --detail
```

Shows a module's upstream dependencies (what it depends on) and downstream dependents (what depends on it). The `--detail` flag includes file-level exports, imports, calls, and events. In detail mode, calls data is loaded from the sidecar file when available.

### Impact Analysis

```bash
node .claude/scripts/trace-query.mjs --impact <file-path>
```

Determines which module owns the file and reports all downstream modules that would be affected by changes. Validates the file path stays within the project root (path traversal protection).

### Call Graph Query

```bash
node .claude/scripts/trace-query.mjs --calls <functionName>
```

Searches all low-level trace data for the given function name. Calls data is loaded from sidecar files (when `callsFile` references are present) or from inline `file.calls` arrays (for backward compatibility with older trace formats). Returns:

- **Callers**: All files across all modules that call the function
- **Callees**: All functions called from files that export the queried function

Output follows existing CLI conventions:

```
Callers of isTraceStale:
  trace-scripts / .claude/scripts/trace-commit-staleness.mjs:28

Callees of isTraceStale:
  scripts-lib / .claude/scripts/lib/trace-utils.mjs:307 - loadStalenessMetadata -> .claude/scripts/lib/trace-utils.mjs:682
```

---

## Trace Sync (Markdown to JSON)

```bash
node .claude/scripts/trace-sync.mjs              # Normal sync with conflict detection
node .claude/scripts/trace-sync.mjs --force       # Force sync (markdown wins)
node .claude/scripts/trace-sync.mjs --dry-run     # Preview changes
node .claude/scripts/trace-sync.mjs --auto-merge  # Auto-merge additions; flag deletions
```

Parses structured sections from markdown trace files and updates the corresponding JSON files. When updating calls data, changes are written to sidecar files (not inline in main JSON) to maintain the sidecar architecture.

### Synced Sections

| Section        | Columns                                                    |
| -------------- | ---------------------------------------------------------- |
| Dependencies   | target, relationship-type, description                     |
| Dependents     | target, relationship-type, description                     |
| Exports        | symbol, type, line, signature                              |
| Imports        | source, symbols                                            |
| Function Calls | callerFile, callerLine, calleeName, calleeFile, calleeLine |
| Events         | file, line, eventName, type                                |

Sections with "(not synced)" in the heading are ignored (freeform content).

### Conflict Detection

When JSON and markdown have been modified independently (different `lastGenerated` timestamps), the sync detects conflicts. Both the JSON value and the markdown value are reported for each conflict.

### Auto-Merge

With `--auto-merge`, the sync classifies each conflict:

- **Additions** (entry in markdown but not JSON): auto-merged
- **Deletions** (entry in JSON but not markdown): requires manual resolution
- **Modifications** (entry differs between JSON and markdown): requires manual resolution

A dry-run log shows what was merged and what requires manual attention.

---

## PR Trace Diff

```bash
node .claude/scripts/trace-diff.mjs              # Compare against main
node .claude/scripts/trace-diff.mjs --base <ref>  # Compare against specific branch
```

Generates a human-readable architectural change summary by comparing trace data between the current branch and a base branch. Shows:

- New/removed modules
- New/removed exports per module
- Changed dependencies
- New/removed call graph edges
- New/removed event patterns

Call graph data is loaded from sidecar files when the trace format includes a `callsFile` reference. The diff tool filters out `.calls.json` files when loading main trace data to avoid double-counting.

When no trace changes are detected, outputs: "No architectural changes detected."

The base branch's traces are loaded via `git show` without checking out the branch. Git ref names are validated to reject shell metacharacters (defense-in-depth alongside `execFileSync`).

---

## Trace-Informed Routing

The `/route` skill uses trace data for impact-aware routing decisions:

1. Reads `high-level.json` directly (via Read tool, not CLI)
2. Validates trace integrity (`generatedBy` and `lastGenerated` must be present and plausible)
3. Parses module dependencies to identify affected modules
4. Uses affected module count to inform workflow complexity (e.g., 3+ modules suggests oneoff-spec)
5. Enriches dispatch prompts with which low-level traces the implementer should read

If trace data is missing or invalid, routing proceeds without trace input (conservative fallback).

---

## Trace Integrity Validation

Before consuming trace data for routing or enforcement decisions, `validateTraceIntegrity()` checks:

- `generatedBy` is a non-empty string
- `lastGenerated` is a valid ISO 8601 timestamp
- Timestamp is not in the future (with 60-second clock skew tolerance)
- Timestamp is not older than 1 year

On validation failure, consumers fall back to safe defaults (no trace data available).

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

`validateLowLevelTrace()` validates:

- Top-level fields: `moduleId` (non-empty string), `version` (integer), `lastGenerated` (valid ISO 8601), `generatedBy` (non-empty string), `files` (array)
- Optional top-level field: `callsFile` (string or null) -- references the sidecar calls file
- Each file entry: `filePath`, `exports[]`, `imports[]`, `events[]` with correct types
- Each file entry's `calls[]`: accepted as either an array or absent/undefined when `callsFile` is present at the trace root (sidecar format)
- Each `calls[]` entry (when present) conforms to CallEntry schema: `callerFile` (string), `callerLine` (integer), `calleeName` (string), `calleeFile` (string or null), `calleeLine` (integer or null)
- Each `events[]` entry conforms to EventEntry schema: `file` (string), `line` (integer), `eventName` (string), `type` ("emit" or "subscribe")

### Path Traversal Protection

`validateFilePath()` in `trace-query.mjs` resolves file path inputs via `path.resolve()` and validates they stay within the project root. Paths that escape the project boundary are rejected with an error.

`validateGitRef()` in `trace-diff.mjs` validates git ref names against a pattern that rejects shell metacharacters.

---

## Trace-to-Docs Bridge

### Cross-Reference Validation

`docs-validate.mjs` compares module references in `architecture.yaml` against traced modules:

- Modules referenced in docs but not in traces: reported as warnings
- Traced modules not referenced in docs: reported as informational notes
- Projects without `architecture.yaml` skip silently

```bash
node .claude/scripts/docs-validate.mjs
```

### Scaffold Population

`docs-scaffold.mjs` pre-populates architecture.yaml TODO placeholders with trace data when available:

- Export names from low-level traces
- Dependency lists from high-level traces
- Module descriptions from trace metadata

Entries remain marked as TODO for human review. Without trace data, the scaffolder generates empty placeholders as before.

### Sync Report

```bash
node .claude/scripts/trace-docs-sync.mjs
```

Compares trace data (exports, dependencies) against architecture.yaml and produces a human-readable divergence report:

```
Trace-Docs Sync Report
======================

Module: scripts-lib
  New exports not in docs: parseCallGraph, parseEventPatterns
  Removed exports still in docs: (none)
  Changed dependencies: +trace-scripts (new)

Summary: 1 module(s) with divergence, 2 new export(s), 0 removed export(s)
```

The report is informational only; no docs files are modified.

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

### "Module not found in trace.config.json"

The specified module ID does not match any module in `trace.config.json`. Check available modules with:

```bash
cat .claude/traces/trace.config.json | grep '"id"'
```

### "High-level trace not found"

Run `node .claude/scripts/trace-generate.mjs` to generate traces.

### Low-level traces missing after clone

Low-level trace JSON and sidecar files are gitignored. Run trace generation after cloning:

```bash
node .claude/scripts/trace-generate.mjs
```

### Sidecar file not found warning

The sidecar `.calls.json` file for a module is missing. This occurs when traces have not been regenerated after the sidecar separation change. Regenerate traces to create sidecar files. Calls queries return empty results until the sidecar is generated.

### Corrupt sidecar file

If a sidecar file contains invalid JSON (from a truncated write or disk-full condition), a warning is logged with the file path and parse error, and calls queries return empty results. Regenerate traces to recreate the sidecar file.

### Staleness.json corrupt or invalid

The system automatically falls back to `--full` regeneration and recreates `staleness.json` from scratch. A warning is logged to stderr.

### Trace analysis failed for a file

Binary files, permission issues, or syntax errors in source files cause analysis warnings (logged to stderr) but do not block trace generation. The file's entry in the trace has empty arrays.

### Incremental generation not reducing time

Incremental mode is only active when explicitly requested via `--incremental` (used by the commit-staleness hook). The CLI defaults to full generation for backward compatibility.

### globalExcludes pattern rejected

Patterns containing `..` (path traversal) or starting with `/` (absolute paths) are rejected with an error. Use relative glob patterns only.

---

## See Also

- [Trace Regeneration Performance Fixes](../docs/trace-regeneration-performance-fixes.md) -- Worker threads, caching, incremental mode
- [Structured Documentation System](STRUCTURED-DOCS.md) -- YAML documentation with trace bridge integration
- [Hooks System](HOOKS.md) -- PostToolUse hook architecture including commit-staleness
- [Sync System](SYNC-SYSTEM.md) -- Registry sync for distributing trace scripts

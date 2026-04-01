# Architecture Trace System

The trace system provides a hierarchical two-level dependency map of the project's architecture:

- **High-level traces** (`high-level.json` / `high-level.md`): Service/module boundaries, cross-module dependency graphs, and skipped file diagnostics.
- **Low-level traces** (`low-level/<module-id>.json` / `low-level/<module-id>.md`): File-level relationships within each module, including imports, exports (with function signatures and line numbers), function calls, and events.

Traces are stored as JSON (canonical source of truth) with generated markdown views. Agents consult traces before editing code, enforced by hooks.

## File Format

- **JSON files** (`.json`): Machine-readable canonical data. Do not edit directly -- use `trace generate` or `trace sync`.
- **Markdown files** (`.md`): Human-readable views generated from JSON. Structured sections (Dependencies, Dependents, Exports, Imports) can be edited and synced back to JSON via `trace sync`. Freeform "Notes (not synced)" sections are ignored by sync.
- **trace.config.json**: Module definitions (IDs, names, file globs). This is the configuration file that maps files to modules.

## Directory Structure

```
.claude/traces/
  trace.config.json              # Module definitions
  high-level.json                # High-level trace data (module dependencies)
  high-level.md                  # Generated markdown view
  low-level/
    <module-id>.json             # Per-module low-level trace (file/function)
    <module-id>.md               # Generated markdown view
```

## Commands

### Generate Traces

```bash
# Generate traces incrementally (default: only regenerates stale modules)
node .claude/scripts/trace-generate.mjs

# Force full regeneration of all traces
node .claude/scripts/trace-generate.mjs --full

# Generate traces for a single module
node .claude/scripts/trace-generate.mjs <module-id>

# Control parallelism (default: auto, 0 = sequential)
node .claude/scripts/trace-generate.mjs --parallel 4
node .claude/scripts/trace-generate.mjs --parallel 0

# Bootstrap: auto-detect modules and create initial config (first-run)
node .claude/scripts/trace-generate.mjs --bootstrap
```

### Query Traces

```bash
# Show a module's upstream/downstream dependencies
node .claude/scripts/trace-query.mjs --module <module-id>

# Show detailed file-level information for a module
node .claude/scripts/trace-query.mjs --module <module-id> --detail

# Show what modules are affected by changing a specific file
node .claude/scripts/trace-query.mjs --impact <file-path>
```

### Sync Markdown Edits Back to JSON

```bash
# Sync structured edits from markdown files back to JSON
node .claude/scripts/trace-sync.mjs
```

## Data Formats

### Low-Level Trace Export Entry

Each export in a low-level trace file includes the following fields:

| Field          | Type   | Required | Description                                                                                                                                            |
| -------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `symbol`       | string | Yes      | Exported symbol name                                                                                                                                   |
| `type`         | string | Yes      | Export kind: `function`, `class`, `interface`, `type`, `const`, `enum`, `default`                                                                      |
| `lineNumber`   | number | No       | 1-indexed source line number of the export declaration                                                                                                 |
| `signature`    | string | No       | Display-facing function signature, truncated at 200 chars with `...` suffix. Empty string for non-function exports.                                    |
| `signatureRaw` | string | No       | Extended signature capture, hard cap at 500 chars with `...` suffix. Stores unparsed text when multi-line signature cannot be balanced within 5 lines. |

Example low-level export entry (JSON):

```json
{
  "symbol": "parseExports",
  "type": "function",
  "lineNumber": 363,
  "signature": "(source: string): Array<{ symbol: string, type: string, lineNumber: number, signature: string, signatureRaw: string }>",
  "signatureRaw": "(source: string): Array<{ symbol: string, type: string, lineNumber: number, signature: string, signatureRaw: string }>"
}
```

Non-function exports have empty `signature` and `signatureRaw`:

```json
{
  "symbol": "SIGNATURE_DISPLAY_MAX_LENGTH",
  "type": "const",
  "lineNumber": 200,
  "signature": "",
  "signatureRaw": ""
}
```

The `lineNumber`, `signature`, and `signatureRaw` fields are additive optional properties. Existing consumers that do not read these fields continue to work without modification.

### Low-Level Markdown Export Table

The markdown view renders exports with line numbers and signatures:

```
symbol | type | line | signature
--- | --- | --- | ---
parseExports | function | 363 | (source: string): Array<...>
```

Symbol names and signatures in markdown output are sanitized -- CommonMark special characters (`\`, `` ` ``, `*`, `_`, `{`, `}`, `[`, `]`, `(`, `)`, `#`, `+`, `-`, `.`, `!`, `|`) are backslash-escaped. JSON files store raw unescaped values.

### High-Level Trace Dependencies

Each module in `high-level.json` includes:

| Field          | Type       | Description                                       |
| -------------- | ---------- | ------------------------------------------------- |
| `dependencies` | `string[]` | Module IDs that this module imports from (sorted) |
| `dependents`   | `string[]` | Module IDs that import from this module (sorted)  |

Dependency arrays contain plain string module IDs, auto-populated from cross-module import analysis:

```json
{
  "id": "trace-scripts",
  "name": "Trace Scripts",
  "dependencies": ["trace-hooks", "trace-utils"],
  "dependents": ["trace-tests"]
}
```

Circular dependencies are represented bidirectionally: if module A imports from module B and B imports from A, both A and B appear in each other's `dependencies[]` and `dependents[]`.

### Skipped Files

When a file's import path matches multiple modules' `fileGlobs` (a configuration ambiguity), the file is skipped from dependency resolution. These are recorded at the root of `high-level.json`:

```json
{
  "skippedFiles": [
    {
      "path": "src/shared/utils.ts",
      "matchedModules": ["mod-a", "mod-b"]
    }
  ]
}
```

A warning is also emitted to stderr during generation. Skipped files indicate overlapping `fileGlobs` in `trace.config.json` that should be corrected.

In the markdown view, skipped files appear in a dedicated "Skipped Files" section.

## Dependency Resolution

The trace system resolves cross-module dependencies through these steps:

1. After all low-level traces are generated, `aggregateDependencies()` iterates each module's files' imports.
2. Each relative import path (starting with `./` or `../`) is resolved against the importing file's directory. Bare module specifiers (package names like `node:fs`, `lodash`) are skipped.
3. If the import has no file extension, common extensions are tried: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, plus `/index.ts`, `/index.tsx`, `/index.js`, `/index.mjs`.
4. The resolved path is matched against all modules' `fileGlobs` using all-match semantics via `fileToModules()`.
5. **Exactly one match**: the target module is recorded as a dependency.
6. **Multiple matches**: the file is skipped and recorded in `skippedFiles[]`.
7. **No matches**: the import is skipped silently (external or untracked).
8. Self-references (imports within the same module) are excluded.
9. Barrel re-exports (`export { foo } from './internal'`) are attributed to the re-exporting module.
10. Dynamic imports (`import()` expressions) are excluded -- only static imports are processed.

## Signature Capture

Function signatures are captured via regex-based parsing (no AST required):

- **Single-line**: The text from the opening `(` through the balanced closing `)`, plus any return type annotation (`: ReturnType`), is extracted and whitespace-collapsed.
- **Multi-line**: If the opening `(` is unbalanced on the declaration line, subsequent lines are buffered (up to 5 additional lines) until parentheses balance. The buffered text is joined and whitespace-collapsed into a single-line signature.
- **Unparseable**: If 5 additional lines are buffered without achieving balance, the assembled text is stored in `signatureRaw` and `signature` is set to empty string. Trace generation does not fail.
- **Overloaded functions**: Each overload declaration (ending with `;`) produces a separate export entry with its own signature.
- **Non-function exports**: Constants, types, interfaces, classes, and enums have empty `signature` and `signatureRaw`.
- **Truncation**: `signature` is capped at 200 characters; `signatureRaw` at 500 characters. Both use `...` suffix when truncated.

## API Reference

### trace-generate.mjs

#### `captureSignature(line, allLines, lineIndex)`

Extracts function signature from an export declaration line and subsequent lines.

| Parameter   | Type     | Description                           |
| ----------- | -------- | ------------------------------------- |
| `line`      | string   | The export declaration line (trimmed) |
| `allLines`  | string[] | All source lines (trimmed)            |
| `lineIndex` | number   | Index of the current line in allLines |

Returns `{ signature: string, signatureRaw: string, linesConsumed: number }`.

Parenthesis-balancing buffers up to `MULTI_LINE_SIGNATURE_BUFFER_LIMIT` (5) additional lines. If balance is not achieved, `signature` is empty and `signatureRaw` contains the assembled text.

#### `aggregateDependencies(lowLevelTraces, config)`

Aggregates cross-module dependencies from low-level trace import data.

| Parameter        | Type   | Description                                                       |
| ---------------- | ------ | ----------------------------------------------------------------- |
| `lowLevelTraces` | Array  | Array of low-level trace objects (with `moduleId` and `files`)    |
| `config`         | Object | Trace config with `modules` array (each having `id`, `fileGlobs`) |

Returns `{ dependencyData: Object, skippedFiles: Array }`.

`dependencyData` is keyed by module ID, each value containing `{ dependencies: string[], dependents: string[] }`. `skippedFiles` contains `{ path, matchedModules }` entries for ambiguous glob matches.

#### `resolveImportPath(fromDir, importPath)`

Resolves a relative import path against an importing directory. Internal function (not exported).

| Parameter    | Type   | Description                                                |
| ------------ | ------ | ---------------------------------------------------------- |
| `fromDir`    | string | Directory of the importing file (relative to project root) |
| `importPath` | string | The import specifier (e.g., `../utils` or `./helper`)      |

Returns a resolved path (string) relative to the project root, or `null` if resolution produces an empty path.

### lib/trace-utils.mjs

#### `sanitizeMarkdown(text)`

Backslash-escapes CommonMark special characters in text for `.md` output.

| Parameter | Type   | Description          |
| --------- | ------ | -------------------- |
| `text`    | string | Raw text to sanitize |

Returns the text with CommonMark special characters (`\`, `` ` ``, `*`, `_`, `{`, `}`, `[`, `]`, `(`, `)`, `#`, `+`, `-`, `.`, `!`, `|`) backslash-escaped. Escapes `\` first to prevent double-escaping. Returns the input unchanged if falsy.

Applied to symbol names and signatures in `.md` trace files. JSON files store raw unescaped values.

#### `fileToModules(filePath, config)`

Maps a file path to all matching modules (all-match semantics).

| Parameter  | Type   | Description                                     |
| ---------- | ------ | ----------------------------------------------- |
| `filePath` | string | File path to resolve (relative to project root) |
| `config`   | Object | Trace config with `modules` array               |

Returns an array of matching module objects. May be empty (no matches), contain one entry (unambiguous), or multiple entries (ambiguous glob configuration).

Unlike `fileToModule()` (singular, first-match-wins), this function returns all modules whose `fileGlobs` match the path. It is used by `aggregateDependencies()` to detect ambiguous file glob configurations.

### lib/high-level-trace.mjs

#### `generateHighLevelTraceJSON(options)`

Generates the high-level trace JSON object. Accepts an `options` object:

| Option           | Type   | Description                                                       |
| ---------------- | ------ | ----------------------------------------------------------------- |
| `projectRoot`    | string | Project root override                                             |
| `generatedBy`    | string | Generator identifier (default: `"trace generate"`)                |
| `existingTrace`  | Object | Existing trace data for version incrementing                      |
| `dependencyData` | Object | Dependency data keyed by module ID (from `aggregateDependencies`) |
| `skippedFiles`   | Array  | Files skipped during dependency aggregation                       |
| `config`         | Object | Pre-loaded trace config (avoids re-reading from disk)             |

`dependencyData` entries and `dependencies[]`/`dependents[]` arrays use string module IDs.

`skippedFiles` (if provided) is included at the trace root as `skippedFiles[]`, an array of `{ path: string, matchedModules: string[] }`.

#### `validateDependency(dep, context)`

Validates a single dependency entry. Accepts string module IDs (non-empty strings). Returns `{ valid: boolean, errors: string[] }`.

### Constants

| Constant                            | Value | Location           | Description                                          |
| ----------------------------------- | ----- | ------------------ | ---------------------------------------------------- |
| `SIGNATURE_DISPLAY_MAX_LENGTH`      | 200   | trace-generate.mjs | Max chars for `signature` field                      |
| `SIGNATURE_RAW_MAX_LENGTH`          | 500   | trace-generate.mjs | Max chars for `signatureRaw` field                   |
| `MULTI_LINE_SIGNATURE_BUFFER_LIMIT` | 5     | trace-generate.mjs | Max additional lines buffered for multi-line sigs    |
| `MULTI_LINE_IMPORT_BUFFER_LIMIT`    | 20    | trace-generate.mjs | Max additional lines buffered for multi-line imports |

## Hook Enforcement

Three hooks enforce trace discipline:

1. **PreToolUse: trace-read-enforcement** (`Edit|Write` matcher): Blocks file edits in traced modules unless the agent has read the module's trace first. Untraced files pass with an advisory.

2. **PostToolUse: trace-read-tracker** (`Read` matcher, `.claude/traces/**` pattern): Records which trace files the agent has read during the current session. Updates `.claude/coordination/trace-reads.json`.

3. **PostToolUse: trace-commit-staleness** (`Bash` matcher, `git commit`): Blocks commits when staged files belong to modules whose traces are stale (source files modified after last trace generation).

## Session State

Trace read state is stored in `.claude/coordination/trace-reads.json`. This file is ephemeral (not committed to git) and tracks which modules' traces have been read in the current session.

## Portability

The trace system is designed to be portable across projects. When `.claude/` is synced to a different repository:

- Trace commands use `resolveProjectRoot()` (checks `$CLAUDE_PROJECT_DIR`, then `git rev-parse --show-toplevel`, then `cwd`) -- no hardcoded paths.
- `trace.config.json` defines project-specific module boundaries. Each project generates its own trace data.
- Hook scripts use relative paths from the project root.

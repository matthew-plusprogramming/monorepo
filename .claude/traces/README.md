# Architecture Trace System

The trace system provides a hierarchical two-level dependency map of the project's architecture:

- **High-level traces** (`high-level.json` / `high-level.md`): Service/module boundaries and their direct upstream/downstream dependencies (1-hop).
- **Low-level traces** (`low-level/<module-id>.json` / `low-level/<module-id>.md`): File-level relationships within each module, including imports, exports, function calls, and events.

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
# Generate all traces (high-level + low-level for all modules)
node .claude/scripts/trace-generate.mjs

# Generate traces for a single module
node .claude/scripts/trace-generate.mjs <module-id>

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

# Agent Tools

Scripts under `agents/scripts/` give coding agents a consistent toolbox for loading context, maintaining the Memory Bank, and running focused quality checks. Each command below is intended to be run from the repository root (use `node agents/scripts/<name>.mjs`).

Prefer the purpose-built discovery scripts (`list-files-recursively.mjs`, `smart-file-query.mjs`, and `read-files.mjs`) whenever you need to enumerate files, inspect content, or stream multiple files; avoid falling back to raw shell commands unless these utilities cannot handle the scenario.

## Context & Memory Management

- `node agents/scripts/load-context.mjs [--include-optional] [--list]`
  Prints required Memory Bank + workflow files for the current task with numbered lines to encourage single-pass note taking. Add `--include-optional` to pull in supplemental context and `--list` to show paths without content.
- `node agents/scripts/append-memory-entry.mjs --requirements "<text>" [--design "<text>"] [--implementation "<text>"] [--execution "<text>"] [--dry-run]`
  Appends formatted reflections (Requirements, Design, Implementation Planning, Execution) to `agents/ephemeral/active.context.md`; at least one flag is required.
- `node agents/scripts/reset-active-context.mjs --slug "<task-slug>" [--title "<text>"] [--date "<YYYY-MM-DD>"]`
  Creates a per-task spec under `agents/ephemeral/task-specs/` and refreshes the active context index (date defaults to today UTC).

## Search & Discovery

- `node agents/scripts/smart-file-query.mjs --regex "<pattern>" [--glob ...] [--contextLines ...] [--includeAllContent] [--json]`
  Finds regex matches across the repo with optional glob scoping, numbered context lines, and optional full file contents. Text output is default; pass `--json` to recover the prior machine-readable payload.
- `node agents/scripts/read-files.mjs --files "<path[,path...]>" [--file-list ...] [--encoding ...] [--maxFileSizeKB ...] [--json]`
  Reads multiple repo-relative files, applying size/binary guards, and prints numbered text blocks by default so you can cite `path:line` without re-reading. Use `--json` when automation requires the legacy `{ files: [{ path, content }] }` payload.

## Reporting & Diff Utilities

- `node agents/scripts/list-files-recursively.mjs --root <path> --pattern <pattern> [--types ...] [--regex] [--case-sensitive]`
  Emits a CSV (`path,size,modifiedAt`) of files under the given root whose repo-relative paths match the pattern; supports substring or regex matching plus optional type filters (`ts`, `md`, `all`).
- `node agents/scripts/git-diff-with-lines.mjs [--cached]`
  Emits the working tree (or staged) diff against `HEAD` with old/new line numbers for verification reports.

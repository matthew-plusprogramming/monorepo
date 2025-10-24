# Agent Tools

Scripts under `agents/scripts/` give coding agents a consistent toolbox for loading context, maintaining the Memory Bank, and running focused quality checks. Each command below is intended to be run from the repository root (use `node agents/scripts/<name>.mjs`).

Prefer the purpose-built discovery scripts (`list-files-recursively.mjs`, `smart-file-query.mjs`, and `read-files.mjs`) whenever you need to enumerate files, inspect content, or stream multiple files; avoid falling back to raw shell commands unless these utilities cannot handle the scenario.

## Context & Memory Management

- `node agents/scripts/load-context.mjs [--include-optional] [--list]`
  Prints required Memory Bank + workflow files for the current task. Add `--include-optional` to pull in supplemental context and `--list` to show paths without content.
- `node agents/scripts/append-memory-entry.mjs --target <active|progress> [...]`
  Appends formatted reflections to `active.context.md` or `progress.log.md`. Supply `--plan`, `--build`, `--verify` for active context entries or `--message` for the progress log; `--dry-run` previews the output.

## Search & Discovery

- `node agents/scripts/smart-file-query.mjs --regex "<pattern>" [--glob ...] [--contextLines ...] [--includeAllContent]`
  Finds regex matches across the repo with optional glob scoping, surrounding context lines, and full file contents, returning a minified JSON payload for downstream tooling.
- `node agents/scripts/read-files.mjs --files "<path[,path...]>" [--file-list ...] [--encoding ...] [--maxFileSizeKB ...]`
  Reads multiple repo-relative files, applying size/binary guards, and prints a JSON array preserving the requested order (`{ files: [{ path, content }] }`).

## Reporting & Diff Utilities

- `node agents/scripts/list-files-recursively.mjs --root <path> --pattern <pattern> [--types ...] [--regex] [--case-sensitive]`
  Emits a CSV (`path,size,modifiedAt`) of files under the given root whose repo-relative paths match the pattern; supports substring or regex matching plus optional type filters (`ts`, `md`, `all`).
- `node agents/scripts/git-diff-with-lines.mjs [--cached]`
  Emits the working tree (or staged) diff against `HEAD` with old/new line numbers for verification reports.

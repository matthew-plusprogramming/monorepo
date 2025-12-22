# Agent Tools

Scripts under `agents/scripts/` give coding agents a consistent toolbox for loading context, maintaining the Memory Bank, and running focused quality checks. Each command below is intended to be run from the repository root (use `node agents/scripts/<name>.mjs`).

Prefer the purpose-built discovery scripts (`list-files-recursively.mjs`, `smart-file-query.mjs`, and `read-files.mjs`) whenever you need to enumerate files, inspect content, or stream multiple files; avoid falling back to raw shell commands unless these utilities cannot handle the scenario.

## Context & Memory Management

- `node agents/scripts/load-context.mjs [--include-optional] [--list] [--task <path>]`
  Prints required Memory Bank + workflow files for the current task with numbered lines to encourage single-pass note taking. Add `--include-optional` to pull in supplemental context, `--list` to show paths without content, and `--task` to include the current task spec explicitly.
- `node agents/scripts/append-memory-entry.mjs --requirements "<text>" [--design "<text>"] [--implementation "<text>"] [--execution "<text>"] [--dry-run]`
  Deprecated; prints a formatted reflection entry for manual copy into the task spec (no file writes).
- `node agents/scripts/reset-active-context.mjs --slug "<task-slug>" [--title "<text>"] [--date "<YYYY-MM-DD>"]`
  Creates a per-task spec (date defaults to today UTC).

## Spec Tooling

- `node agents/scripts/spec-validate.mjs --specs "<path[,path...]>" [--root <path>] [--registry <path>] [--allow-empty]`
  Validates spec front matter, required sections, and contract registry references.
- `node agents/scripts/spec-merge.mjs --specs "<path[,path...]>" --output <path> [--report <path>] [--registry <path>]`
  Generates a MasterSpec and gate report from workstream specs.
- `npm run spec:finalize`
  Runs spec validation and Memory Bank validation in one pass.

## Search & Discovery

- `node agents/scripts/smart-file-query.mjs --regex "<pattern>" [--glob ...] [--contextLines ...] [--includeAllContent] [--json]`
  Finds regex matches across the repo with optional glob scoping, numbered context lines, and optional full file contents. Text output is default; pass `--json` to recover the prior machine-readable payload.
- `node agents/scripts/read-files.mjs --files "<path[,path...]>" [--file-list ...] [--encoding ...] [--maxFileSizeKB ...] [--json]`
  Reads multiple repo-relative files, applying size/binary guards, and prints numbered text blocks by default so you can cite `path:line` without re-reading. Use `--json` when automation requires the legacy `{ files: [{ path, content }] }` payload.

## Git Worktrees

- `node agents/scripts/create-worktree.mjs --name "<worktree-name>" [--branch "<branch-name>"] [--base "<git-ref>"]`
  Creates a git worktree under `.worktrees/`, defaulting to the `worktree/<name>` branch when none is provided.
- `node agents/scripts/manage-worktrees.mjs <command> [options]`
  Manages orchestrator worktrees (ensure/sync/list/status/remove/prune) under `.worktrees/` using workstream specs or explicit lists.
- `node agents/scripts/sync-worktree-env-keys.mjs [--target <path>] [--source <path>] [--dry-run] [--force]`
  Copies missing `.env.keys` into the target worktree and preserves relative paths.
- `node agents/scripts/dotenvx-run.mjs <dotenvx args>`
  Runs dotenvx and emits guidance when missing private keys are detected.

## Reporting & Diff Utilities

- `node agents/scripts/list-files-recursively.mjs --root <path> --pattern <pattern> [--types ...] [--regex] [--case-sensitive]`
  Emits a CSV (`path,size,modifiedAt`) of files under the given root whose repo-relative paths match the pattern; supports substring or regex matching plus optional type filters (`ts`, `md`, `all`).
- `node agents/scripts/git-diff-with-lines.mjs [--cached]`
  Emits the working tree (or staged) diff against `HEAD` with old/new line numbers for verification reports.

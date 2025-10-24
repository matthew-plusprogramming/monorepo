# Agent Tools

Scripts under `agents/scripts/` give coding agents a consistent toolbox for loading context, maintaining the Memory Bank, and running focused quality checks. Each command below is intended to be run from the repository root (use `node agents/scripts/<name>.mjs`).

## Context & Memory Management

- `node agents/scripts/load-context.mjs [--include-optional] [--list]`
  Prints required Memory Bank + workflow files for the current task. Add `--include-optional` to pull in supplemental context and `--list` to show paths without content.
- `node agents/scripts/append-memory-entry.mjs --target <active|progress> [...]`
  Appends formatted reflections to `active.context.md` or `progress.log.md`. Supply `--plan`, `--build`, `--verify` for active context entries or `--message` for the progress log; `--dry-run` previews the output.
- `node agents/scripts/update-memory-stamp.mjs [--dry-run]`
  Refreshes the `generated_at` date and `repo_git_sha` in `agents/memory-bank.md` after Memory Bank updates.

## Code Quality & Safety Checks

- `node agents/scripts/check-code-quality.mjs`
  Runs the bundled heuristics (`check-effect-*`, env schema usage, resource naming, console usage, AAA comments, unsafe assertions).

## Reporting & Diff Utilities

- `node agents/scripts/git-diff-with-lines.mjs [--cached]`
  Emits the working tree (or staged) diff against `HEAD` with old/new line numbers for verification reports.

Workflows

It is very important you strictly follow the agent workflows.

- Default workflow: `agents/workflows/default.workflow.md`
- Purpose: drive three-phase execution (plan → build → verify) with explicit inputs/outputs and gates.

Usage

- Open the workflow file and start at the current phase.
- Follow the checklist, produce outputs, and update the phase state in the file.
- After each phase, log a 3-line reflection to `agents/memory-bank/active.context.md` and append a brief entry to `agents/memory-bank/progress.log.md`.
- Reference `agents/tools.md` for script helpers that support each phase.
  - Use `node agents/scripts/append-memory-entry.mjs --target active --plan "..." --build "..." --verify "..."` to capture reflections.
  - Use `node agents/scripts/append-memory-entry.mjs --target progress --message "..."` for the progress log.
  - Use `node agents/scripts/list-files-recursively.mjs` for file discovery and `node agents/scripts/smart-file-query.mjs`/`node agents/scripts/read-files.mjs` for scoped, numbered text output instead of default shell tooling; only re-run these helpers when the file actually changes.
- For system-impacting changes, open an ADR stub using `agents/memory-bank/decisions/ADR-0000-template.md`.

Policies

- Retrieval: Follow the Retrieval Policy in `agents/memory-bank.md`.
- Commit proposal: Format commit proposals using conventional commit format under 70 chars and a brief body preview.
- Markdown: use Prettier (`npm run format:markdown`) to format Markdown in `agents/**`.
- Memory stamp: run `node agents/scripts/update-memory-stamp.mjs` once canonical updates are ready so `agents/memory-bank.md` reflects the current date and HEAD SHA.

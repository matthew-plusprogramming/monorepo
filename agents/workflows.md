Workflows

It is very important you strictly follow the agent workflows.

- Default workflow: `agents/workflows/default.workflow.md`
- Purpose: drive the four-phase loop (Requirements → Design → Implementation Planning → Execution) with explicit inputs/outputs and gates.

Usage

- Open the workflow file and start at the current phase.
- Follow the checklist, produce outputs, and update the phase state in the file.
- After each phase, log a 3-line reflection to `agents/ephemeral/active.context.md`.
- Reference `agents/tools.md` for script helpers that support each phase.
  - Use `node agents/scripts/append-memory-entry.mjs --requirements "..." --design "..." --implementation "..." --execution "..."` to capture reflections.
  - Retrieval tooling and single-pass rules live in `agents/memory-bank.md#retrieval-policy`; defer to that section for discovery commands and numbered output expectations.
- For system-impacting changes, open an ADR stub using `agents/memory-bank/decisions/ADR-0000-template.md`.

Policies

- Retrieval: Follow the Retrieval Policy in `agents/memory-bank.md`.
- Commit proposal: Format commit proposals using conventional commit format under 70 chars and a brief body preview.
- Markdown: use Prettier (`npm run format:markdown`) to format Markdown in `agents/**`.
- Memory stamp: run `node agents/scripts/update-memory-stamp.mjs` once canonical updates are ready so `agents/memory-bank.md` reflects the current date and HEAD SHA.

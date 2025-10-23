Workflows

It is very important you strictly follow the agent workflows.

- Default workflow: `agents/workflows/default.workflow.md`
- Purpose: drive three-phase execution (plan → build → verify) with explicit inputs/outputs and gates.
- New workflow template: `agents/workflows/templates/pattern.workflow.template.md`

Usage

- Open the workflow file and start at the current phase.
- Follow the checklist, produce outputs, and update the phase state in the file.
- After each phase, log a 3-line Reflexion to `agents/memory-bank/active.context.md` and append a brief entry to `agents/memory-bank/progress.log.md`.
  - Use `node agents/scripts/append-memory-entry.mjs --target active --plan "..." --build "..." --verify "..."` to capture reflexions.
  - Use `node agents/scripts/append-memory-entry.mjs --target progress --message "..."` for the progress log.
- For system-impacting changes, open an ADR stub using `agents/memory-bank/decisions/ADR-0000-template.md`.

Policies

- Retrieval: Follow the Retrieval Policy in `agents/memory-bank.md`.
- External tools: prefer GitHub MCP for git actions (branching, commits, PRs).
- Workflow Synthesis: When a high-importance procedural pattern is recorded in `agents/memory-bank/system.patterns.md`, update an existing workflow or create a new one from the template. Declarative knowledge updates do not change workflows and should be captured in the Memory Bank only.
- Commit confirmation: always ask for explicit approval before each commit (share the Conventional Commit title under 70 chars and a brief body preview) and before pushing.
- Markdown: use Prettier (`npm run format:markdown`) to format Markdown in `agents/**`. Running `npm run lint` or `npm run lint:fix` at the repo root automatically formats Markdown via a prelint hook.
- Memory stamp: run `node agents/scripts/update-memory-stamp.mjs` once canonical updates are ready so `agents/memory-bank.md` reflects the current date and HEAD SHA.

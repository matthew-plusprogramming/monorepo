Workflows

It is very important you strictly follow the agent workflows.

- Default workflow: `agents/workflows/default.workflow.md`
- Purpose: drive three-phase execution (plan → build → verify) with explicit inputs/outputs and gates.

Usage

- Open the workflow file and start at the current phase.
- Follow the checklist, produce outputs, and update the phase state in the file.
- After each phase, log a 3-line Reflexion to `agents/memory-bank/active.context.md` and append a brief entry to `agents/memory-bank/progress.log.md`.
- For system-impacting changes, open an ADR stub using `agents/memory-bank/decisions/ADR-0000-template.md`.
- It is very important you strictly follow the agent workflows.

Policies

- Retrieval: follow the canonical policy in `agents/memory-bank.md` (avoid duplicating rules here).
- External tools: prefer GitHub MCP for git actions (branching, commits, PRs).
- Commit confirmation: always ask for explicit approval before each commit (share the Conventional Commit title under 70 chars and a brief body preview) and before pushing.
- Markdown: use Prettier (`npm run format:markdown`) to format Markdown in `agents/**`. Running `npm run lint` or `npm run lint:fix` at the repo root automatically formats Markdown via a prelint hook.

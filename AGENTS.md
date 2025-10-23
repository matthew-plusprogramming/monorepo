## 🔧 Start Here (for AI agents)

Before modifying code, load required context with `node agents/scripts/load-context.mjs`, then use the repo-native agent system under `agents/`.

- Memory Bank overview: `agents/memory-bank.md`
- Workflows overview: `agents/workflows.md`

## 🔑 Memory Bank

The Memory Bank provides durable, structured context for all tasks.

- Overview and canonical policy: `agents/memory-bank.md` (source of truth for storage tiers and retrieval rules)
- Canonical files live under: `agents/memory-bank/` (PR‑reviewed)

Update Requirements (per task)

- Update relevant canonical files under `agents/memory-bank/` to reflect changes.
- Stamp `agents/memory-bank.md` front matter:
  - `generated_at`: today (YYYY‑MM‑DD)
  - `repo_git_sha`: `git rev-parse HEAD`
- Validate and check drift:
  - `npm run memory:validate` — verify referenced paths exist across all memory files
  - `npm run memory:drift` — ensure stamped SHA matches or intentionally update
- Include Memory Bank updates in the same PR.

## 🧭 Workflow Process List

One LLM executes work by following process markdowns in `agents/workflows/`.

- Phases: plan → build → verify
- Each process file defines checklists, inputs/outputs, and quality gates.
- The LLM loads the process .md (+ linked partials), executes the current phase, writes artifacts, updates phase state, advances when gates pass, and logs a short Reflexion to the Memory Bank.
- External tools: prefer GitHub MCP for git workflows.

It is very important you strictly follow the agent workflows.

Start with: `agents/workflows/default.workflow.md`
## Conventions

- Markdown: use Prettier via `npm run format:markdown` for `agents/**`; `npm run lint`/`lint:fix` runs it via prelint hook.

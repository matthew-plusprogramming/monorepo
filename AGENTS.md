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
- Use `node agents/scripts/update-memory-stamp.mjs` to automatically apply the stamp once updates are ready.
- Validate and check drift:
  - `npm run agent:finalize` - verify referenced paths exist across all memory files, check stamped SHA matches

Convenience helpers

- `node agents/scripts/append-memory-entry.mjs --target active --plan "..." --build "..." --verify "..."` appends a reflexion block to `active.context.md`.
- `node agents/scripts/append-memory-entry.mjs --target progress --message "..."` appends a line to `progress.log.md`.

## 🧭 Workflow Process List

One LLM executes work by following process markdowns in `agents/workflows/`.

- Phases: plan → build → verify
- Each process file defines checklists, inputs/outputs, and quality gates.
- The LLM loads the process .md (+ linked partials), executes the current phase, writes artifacts, updates phase state, advances when gates pass, and logs a short Reflexion to the Memory Bank.

IT IS VERY IMPORTANT YOU STRICTLY FOLLOW AGENT WORKFLOWS

Start with: `agents/workflows/default.workflow.md`

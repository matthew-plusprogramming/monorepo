## 🔧 Start Here (for AI agents)

Before modifying code, load required context with `node agents/scripts/load-context.mjs`, then use the repo-native agent system under `agents/`.

- Memory Bank overview: `agents/memory-bank.md`
- Workflows overview: `agents/workflows.md`
- Tool catalog: `agents/tools.md`
- Retrieval policy: `agents/memory-bank.md#retrieval-policy` is the canonical source for discovery tooling, one-pass note taking, and context tiers. Quick start: `node agents/scripts/list-files-recursively.mjs --root apps` (pattern defaults to match everything; add `--pattern handler` to filter results).

## 🔑 Memory Bank

The Memory Bank provides durable, structured context for all tasks.

- Overview and canonical policy: `agents/memory-bank.md` (source of truth for storage tiers and retrieval rules)
- Canonical files live under: `agents/memory-bank/` (PR‑reviewed)

Update Requirements (per task)

- Update relevant canonical files under `agents/memory-bank/` to reflect changes.
- Use `node agents/scripts/update-memory-stamp.mjs` to automatically apply the stamp once updates are ready.
- Validate and check drift:
  - `npm run agent:finalize` - verify referenced paths exist across all memory files, check stamped SHA matches
- Retrieval helpers: follow the Retrieval Policy in `agents/memory-bank.md` for the authoritative list of discovery commands (`list-files-recursively.mjs`, `smart-file-query.mjs`, `read-files.mjs`), numbered output expectations, and when `--json` is appropriate.

Convenience helpers

- `node agents/scripts/append-memory-entry.mjs --plan "..." --build "..." --verify "..."` appends a reflection block to `active.context.md`.

## 🧭 Workflow Process List

One LLM executes work by following process markdowns in `agents/workflows/`.

- Phases: plan → build → verify
- Each process file defines checklists, inputs/outputs, and quality gates.
- The LLM loads the process .md (+ linked partials), executes the current phase, writes artifacts, updates phase state, advances when gates pass, and logs a short reflection to the Memory Bank.

IT IS VERY IMPORTANT YOU STRICTLY FOLLOW AGENT WORKFLOWS

Start with: `agents/workflows/default.workflow.md`

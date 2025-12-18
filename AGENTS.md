## 🔧 Start Here (for AI agents)

Before modifying code, load required context with `node agents/scripts/load-context.mjs`, then work inside the repo-native agent system under `agents/`.

- Memory Bank overview: `agents/memory-bank.md`
- Workflows overview: `agents/workflows.md`
- Tool catalog: `agents/tools.md`
- Retrieval policy: `agents/memory-bank.md#retrieval-policy` is the canonical source for discovery tooling, one-pass note taking, and context tiers.

## 🔑 Memory Bank

The Memory Bank provides durable, structured context for all tasks.

- Overview and canonical policy: `agents/memory-bank.md` (source of truth for storage tiers and retrieval rules)
- Canonical files live under: `agents/memory-bank/` (PR-reviewed)
- Operating model: `agents/memory-bank/operating-model.md` describes the default four-phase loop and expectations.
- Task spec guide: `agents/memory-bank/task-spec.guide.md` shows the per-task spec structure.

Update Requirements (per task)

- Update relevant canonical files under `agents/memory-bank/` to reflect changes.
- Validate and check quality:
  - `npm run agent:finalize` - format markdown, verify referenced paths exist across Memory/Workflow docs, and run repo quality checks.
- Retrieval helpers: follow the Retrieval Policy in `agents/memory-bank.md` for the authoritative list of discovery commands (`list-files-recursively.mjs`, `smart-file-query.mjs`, `read-files.mjs`), numbered output expectations, and when `--json` is appropriate.

Convenience helpers

- `node agents/scripts/reset-active-context.mjs --slug <task-slug> [--title "..."] [--date YYYY-MM-DD]` creates a new per-task spec under `agents/ephemeral/task-specs/` and refreshes `agents/ephemeral/active.context.md`.
- `node agents/scripts/append-memory-entry.mjs --requirements "..." --design "..." --implementation "..." --execution "..."` appends a reflection block to `agents/ephemeral/active.context.md` (at least one flag required).

## 🧭 Workflow Process List

One LLM executes work by following process markdowns in `agents/workflows/`.

- Phases: Requirements → Design → Implementation Planning → Execution (default)
- Each process file defines checklists, inputs/outputs, and quality gates.
- The LLM loads the process .md (+ linked partials), executes the current phase, writes artifacts, updates phase state, advances when gates pass, and logs a short reflection to the Memory Bank.

IT IS VERY IMPORTANT YOU STRICTLY FOLLOW AGENT WORKFLOWS

Start with: `agents/workflows/default.workflow.md`

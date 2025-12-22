## 🔧 Start Here (for AI agents)

Before modifying code, load required context with `node agents/scripts/load-context.mjs`, then work inside the repo-native agent system under `agents/`. When a task spec exists, include it with `node agents/scripts/load-context.mjs --task agents/specs/task-specs/<YYYY-MM-DD>-<slug>.md`.

- Memory Bank overview: `agents/memory-bank.md`
- Workflows overview: `agents/workflows.md`
- Tool catalog: `agents/tools.md`
- Retrieval policy: `agents/memory-bank.md#retrieval-policy` is the canonical source for discovery tooling, one-pass note taking, and context tiers.

## 🧭 Mode Selection (Orchestrator vs One-off)

- If the user does not specify a mode, ask them to choose orchestrator or one-off before proceeding.
- Orchestrator: follow `agents/workflows/orchestrator.workflow.md` and the spec-first pipeline in `agents/memory-bank/spec-orchestration.design.md`.
- Spec author: follow `agents/workflows/spec-author.workflow.md` when assigned a workstream spec.
- Implementer: follow `agents/workflows/implementer.workflow.md` when executing an approved MasterSpec.
- One-off: ask whether the request is one-off vibe or one-off spec; use `agents/workflows/oneoff.workflow.md` for the overview.
- One-off vibe: no spec, small scope only; follow `agents/workflows/oneoff-vibe.workflow.md` and recommend switching modes if scope grows.
- One-off spec: create a single spec using the required section schema, log approvals in the Decision & Work Log, then execute via `agents/workflows/oneoff-spec.workflow.md`.
- Use user selection as the only threshold; do not infer mode from scope or complexity.
- Reference `agents/workflows/spec-author.workflow.md` or `agents/workflows/implementer.workflow.md` when assigned a specific spec role.

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

- `node agents/scripts/reset-active-context.mjs --slug <task-slug> [--title "..."] [--date YYYY-MM-DD]` creates a new per-task spec.
- `node agents/scripts/append-memory-entry.mjs --requirements "..." --design "..." --implementation "..." --execution "..."` is deprecated; it prints a reflection entry for manual copy into the task spec.

## 🧭 Workflow Process List

One LLM executes work by following process markdowns in `agents/workflows/`.

- Phases: Requirements → Design → Implementation Planning → Execution (default)
- Each process file defines checklists, inputs/outputs, and quality gates.
- The LLM loads the process .md (+ linked partials), executes the current phase, writes artifacts, updates phase state, advances when gates pass, and logs a short reflection to the Memory Bank.

IT IS VERY IMPORTANT YOU STRICTLY FOLLOW AGENT WORKFLOWS

Start with: `agents/workflows/oneoff.workflow.md`

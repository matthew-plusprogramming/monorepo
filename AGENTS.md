## 🔧 Start Here (for AI agents)

Before modifying code, use the repo-native agent system under `agents/`.

- Memory Bank overview: `agents/memory-bank.md`
- Workflows overview: `agents/workflows.md`

## 🔑 Memory Bank

The Memory Bank provides durable, structured context for all tasks.

- Overview: `agents/memory-bank.md`
- Canonical tier: files under `agents/memory-bank/` (PR‑reviewed)

Principles

- Decisions as ADRs; episodic/reflective memory; tiered storage; handoffs between workflow phases.

Storage Tiers

- Tier 0 — Task Context: ephemeral notes in the active workflow file.
- Tier 1 — Active Context Ring: rolling buffer summarized in `agents/memory-bank/active.context.md` with Reflexion entries.
- Tier 2 — Canonical Files: `agents/memory-bank/*` (PR‑reviewed only).

Retrieval Policy

- Identify task type: bug | feature | refactor | ops.
- Always load: `agents/memory-bank/project.brief.md`, recent `agents/memory-bank/progress.log.md` entries, `agents/memory-bank/active.context.md`.
- Add by relevance: `agents/memory-bank/tech.context.md`, `agents/memory-bank/system.patterns.md`, and ADRs under `agents/memory-bank/decisions/`.
- For system‑impacting changes: open an ADR stub PR using `agents/memory-bank/decisions/ADR-0000-template.md`.
- After each phase: append a 3‑line Reflexion to `agents/memory-bank/active.context.md`; when stable, roll up into an ADR or `agents/memory-bank/system.patterns.md`.

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

- Phases: planner → retriever → architect → implementer → reviewer → tester → documenter
- Each process file defines checklists, inputs/outputs, and quality gates.
- The LLM loads the process .md (+ linked partials), executes the current phase, writes artifacts, updates phase state, advances when gates pass, and logs a short Reflexion to the Memory Bank.
- External tools: prefer GitHub MCP for git workflows.

Start with: `agents/workflows/default.workflow.md`

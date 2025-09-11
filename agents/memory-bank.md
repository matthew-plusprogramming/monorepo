---
memory_bank: v1
generated_at: 2025-09-11
repo_git_sha: 2b7f86b580888c3715393f5e3cb9b775b0a7b68c
---

Memory Bank

- Canonical: `agents/memory-bank/*`

Source of Truth

- Retrieval and tier policies are defined here. Other docs should reference this file rather than duplicating the rules.

Storage Tiers

- Tier 0 — Task Context: ephemeral notes in the active workflow.
- Tier 1 — Active Context Ring: rolling buffer summarized in `agents/memory-bank/active.context.md`; Reflexion entries appended per phase.
- Tier 2 — Canonical Files: `agents/memory-bank/` (PR‑reviewed only).

Retrieval Policy

- Identify task type: bug | feature | refactor | ops.
- Always include (non‑negotiable):
  - `agents/workflows/default.workflow.md` (or a more applicable workflow under `agents/workflows/`)
  - `agents/memory-bank/project.brief.md`
  - Recent `agents/memory-bank/progress.log.md`
  - `agents/memory-bank/active.context.md`
- Gate by non‑empty relevance:
  - Include `agents/memory-bank/tech.context.md` only if it contains substantive, task‑relevant content beyond boilerplate (e.g., concrete constraints, entrypoints, or codebase map used by the task).
  - Include `agents/memory-bank/system.patterns.md` only if there are adopted/proposed patterns that materially guide the task.
  - Pull ADRs from `agents/memory-bank/decisions/` only when directly relevant to the task.
- For system‑impacting changes, open an ADR stub using `agents/memory-bank/decisions/ADR-0000-template.md`.
- After each phase, append a 3‑line Reflexion to `agents/memory-bank/active.context.md`; when stable, roll up into an ADR or `agents/memory-bank/system.patterns.md`.

Stage Metadata Policy

- To avoid drift, do not track “stage”/phase in every Memory Bank file.
- Ground truth for phase lives in the active workflow file under `agents/workflows/*`.
- Memory files should use `last_reviewed` to indicate freshness; `stage` is optional and, if used, should be limited to `agents/memory-bank/active.context.md` only.

Validation scripts

- Validate file paths across all Memory Bank files: `npm run memory:validate`
- Drift check against stamped SHA (front matter in this file): `npm run memory:drift`

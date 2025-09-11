---
memory_bank: v1
generated_at: 2025-09-11
repo_git_sha: 4d16b6e01ced53b45105d0d6d89baf9665b319de
---

Memory Bank

- Canonical: `agents/memory-bank/*`

Storage Tiers

- Tier 0 — Task Context: ephemeral notes in the active workflow.
- Tier 1 — Active Context Ring: rolling buffer summarized in `agents/memory-bank/active.context.md`; Reflexion entries appended per phase.
- Tier 2 — Canonical Files: `agents/memory-bank/` (PR‑reviewed only).

Retrieval Policy

- Identify task type: bug | feature | refactor | ops.
- Always include: `agents/memory-bank/project.brief.md`, recent `agents/memory-bank/progress.log.md`, `agents/memory-bank/active.context.md`.
- Add by relevance: `agents/memory-bank/tech.context.md`, `agents/memory-bank/system.patterns.md`, and related ADRs under `agents/memory-bank/decisions/`.
- For system‑impacting changes, open an ADR stub using `agents/memory-bank/decisions/ADR-0000-template.md`.
- After each phase, append a 3‑line Reflexion to `agents/memory-bank/active.context.md`; when stable, roll up into an ADR or `agents/memory-bank/system.patterns.md`.

Validation scripts

- Validate file paths across all Memory Bank files: `npm run memory:validate`
- Drift check against stamped SHA (front matter in this file): `npm run memory:drift`

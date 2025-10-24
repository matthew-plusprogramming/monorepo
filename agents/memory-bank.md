---
memory_bank: v1
generated_at: 2025-10-24
repo_git_sha: 3ef99ff4a68ab05ad7eb81e13678136f51c01177
---

Memory Bank

- Canonical: `agents/memory-bank/*`
- Single source of truth: This file defines knowledge representation. Other docs should reference (not duplicate) these rules.
- Script catalog: `agents/tools.md` lists automation helpers for loading context, stamping metadata, and running validations.

Procedural vs Declarative

- Declarative knowledge (facts, mappings, invariants) is recorded in canonical files under `agents/memory-bank/*` and does not change workflow definitions.
- Procedural learnings (repeatable steps) are captured as patterns in `agents/memory-bank/system.patterns.md`. High-importance procedural patterns may modify/create workflows per the synthesis rule.

Retrieval Policy

- Identify task type: bug | feature | refactor | ops | etc.
- Always include: `agents/workflows/default.workflow.md`, `agents/memory-bank/project.brief.md`, recent `agents/memory-bank/progress.log.md`, and `agents/memory-bank/active.context.md`.
- Gate optional files by substance: include `agents/memory-bank/tech.context.md` and `agents/memory-bank/system.patterns.md` only when they contain substantive, non-placeholder content (more than headings/TBDs). Include relevant ADRs under `agents/memory-bank/decisions/` when directly applicable.
- For system-impacting changes, open an ADR stub using `agents/memory-bank/decisions/ADR-0000-template.md`.
- After each phase, append a reflection to `agents/memory-bank/active.context.md` via the append-memory-entry script; when stable, roll up into an ADR or a relevant stable memory bank file.

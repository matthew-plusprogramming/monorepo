---
memory_bank: v1
generated_at: 2025-12-02
repo_git_sha: 191c13d3e9f9e240dd5fbeb55f6815164dfbbebf
---

Memory Bank

- Canonical: `agents/memory-bank/*`
- Single source of truth: This file defines knowledge representation. Other docs should reference (not duplicate) these rules.
- Script catalog: `agents/tools.md` lists automation helpers for loading context, stamping metadata, and running validations.
- Operating model: `agents/memory-bank/operating-model.md` defines the default Requirements → Design → Implementation Planning → Execution loop.
- Task specs: per-task specs live under `agents/ephemeral/task-specs/` and are guided by `agents/memory-bank/task-spec.guide.md`.

Procedural vs Declarative

- Declarative knowledge (facts, mappings, invariants) is recorded in canonical files under `agents/memory-bank/*` and does not change workflow definitions.
- Procedural learnings (repeatable steps) are captured as patterns in files under `agents/workflows/*`

Retrieval Policy

- Identify task type: bug | feature | refactor | ops | etc.
- Always include: `agents/workflows/default.workflow.md`, `agents/memory-bank/project.brief.md`, `agents/memory-bank/operating-model.md`, `agents/memory-bank/task-spec.guide.md`, recent `agents/ephemeral/active.context.md` (use `node agents/scripts/reset-active-context.mjs` to recreate the template if needed).
- Gate optional files by substance: include `agents/memory-bank/tech.context.md` only when they contain substantive, non-placeholder content (more than headings/TBDs). Include relevant ADRs under `agents/memory-bank/decisions/` when directly applicable.
- File discovery & content retrieval: rely on `node agents/scripts/list-files-recursively.mjs` to surface candidate paths, `node agents/scripts/smart-file-query.mjs` for scoped searches, and `node agents/scripts/read-files.mjs` (default numbered text output, `--json` when automation requires it) when you need ordered contents from multiple files; avoid falling back to generic shell defaults unless these scripts cannot satisfy the need.
- Capture context in a single pass: the helper scripts now emit line numbers, so take notes the first time you load a file and only re-read when the file genuinely changes; repeated pulls violate workflow discipline and waste cycles.
- For system-impacting changes, open an ADR stub using `agents/memory-bank/decisions/ADR-0000-template.md`.
- After each phase (Requirements, Design, Implementation Planning, Execution), append a reflection to `agents/ephemeral/active.context.md` via the append-memory-entry script; when stable, roll up into an ADR or a relevant stable memory bank file.

---
memory_bank: v1
---

Memory Bank

- Canonical: `agents/memory-bank/*`
- Single source of truth: This file defines knowledge representation. Other docs should reference (not duplicate) these rules.
- Script catalog: `agents/tools.md` lists automation helpers for loading context, discovery, and running validations.
- Operating model: `agents/memory-bank/operating-model.md` defines the default Requirements → Design → Implementation Planning → Execution loop.
- Task specs: per-task specs follow `agents/memory-bank/task-spec.guide.md` and live in the task spec directory defined by the operating model.

Design References

- Spec-first orchestration system: `agents/memory-bank/spec-orchestration.design.md`

Procedural vs Declarative

- Declarative knowledge (facts, mappings, invariants) is recorded in canonical files under `agents/memory-bank/*` and does not change workflow definitions.
- Procedural learnings (repeatable steps) are captured as patterns in files under `agents/workflows/*`

Retrieval Policy

- Identify task type: bug | feature | refactor | ops | etc.
- Always include: `agents/workflows/oneoff.workflow.md`, `agents/workflows/oneoff-spec.workflow.md`, `agents/memory-bank/project.brief.md`, `agents/memory-bank/operating-model.md`, `agents/memory-bank/task-spec.guide.md`, and the current task spec (include via `--task` when available) or workstream spec (review the Decision & Work Log for approvals).
- For one-off vibe tasks, also include `agents/workflows/oneoff-vibe.workflow.md`.
- Gate optional files by substance: include `agents/memory-bank/tech.context.md` only when they contain substantive, non-placeholder content (more than headings/TBDs).
- Consult `agents/memory-bank/best-practices/README.md` to identify domain relevant matches and include all applicable `agents/memory-bank/best-practices/*.md` files (match by `domain`/`tags` in front matter).
- File discovery & content retrieval: rely on `node agents/scripts/list-files-recursively.mjs` to surface candidate paths, `node agents/scripts/smart-file-query.mjs` for scoped searches, and `node agents/scripts/read-files.mjs` (default numbered text output, `--json` when automation requires it) when you need ordered contents from multiple files; avoid falling back to generic shell defaults unless these scripts cannot satisfy the need.
- Capture context in a single pass: the helper scripts now emit line numbers, so take notes the first time you load a file and only re-read when the file genuinely changes; repeated pulls violate workflow discipline and waste cycles.
- After each phase (Requirements, Design, Implementation Planning, Execution), log a reflection in the task spec and record approvals in the Decision & Work Log; when stable, roll up into an ADR or a relevant stable memory bank file.

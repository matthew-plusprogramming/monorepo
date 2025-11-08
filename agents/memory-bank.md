---
memory_bank: v1
generated_at: 2025-11-08
repo_git_sha: 6cc1a53b466e24e1ddd5b98988e6f25bea9717ab
---

Memory Bank

- Canonical: `agents/memory-bank/*`
- Single source of truth: This file defines knowledge representation. Other docs should reference (not duplicate) these rules.
- Script catalog: `agents/tools.md` lists automation helpers for loading context, stamping metadata, and running validations.

Procedural vs Declarative

- Declarative knowledge (facts, mappings, invariants) is recorded in canonical files under `agents/memory-bank/*` and does not change workflow definitions.
- Procedural learnings (repeatable steps) are captured as patterns in files under `agents/workflows/*`

Retrieval Policy

- This section is the canonical source for discovery tooling expectations, numbered output defaults, and single-pass context rules. Other docs should reference it instead of duplicating instructions.
- Identify task type: bug | feature | refactor | ops | etc.
- Always include: `agents/workflows/default.workflow.md`, `agents/memory-bank/project.brief.md`, recent `agents/memory-bank/active.context.md`.
- Gate optional files by substance: include `agents/memory-bank/tech.context.md` only when they contain substantive, non-placeholder content (more than headings/TBDs). Include relevant ADRs under `agents/memory-bank/decisions/` when directly applicable.
- File discovery & content retrieval: rely on `node agents/scripts/list-files-recursively.mjs` to surface candidate paths, `node agents/scripts/smart-file-query.mjs` for scoped searches, and `node agents/scripts/read-files.mjs` (default numbered text output, `--json` when automation requires it) when you need ordered contents from multiple files; avoid falling back to generic shell defaults unless these scripts cannot satisfy the need. Example: `node agents/scripts/list-files-recursively.mjs --root apps` lists everything under `apps` (pattern defaults to match all) while `--pattern handler` narrows the output.
- Capture context in a single pass: the helper scripts now emit line numbers, so take notes the first time you load a file and only re-read when the file genuinely changes; repeated pulls violate workflow discipline and waste cycles.
- For system-impacting changes, open an ADR stub using `agents/memory-bank/decisions/ADR-0000-template.md`.
- After each phase, append a reflection to `agents/memory-bank/active.context.md` via the append-memory-entry script; when stable, roll up into an ADR or a relevant stable memory bank file.

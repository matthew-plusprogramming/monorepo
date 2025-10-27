---
last_reviewed: 2025-10-21
---

# Active Context

Current Focus

- Keep the Memory Bank and default workflow concise, accurate, and aligned with AGENTS.md guidance.
- Maintain high-signal reflection summaries that point to the latest workflows, scripts, and ADRs.

Next Steps

- Track upstream agent-template updates and capture repo-specific deviations through ADRs when policies diverge.
- Periodically prune reflection/log entries to preserve readability without losing key decisions.

Open Decisions

- Define the long-term ADR indexing cadence as the system matures.

Reflection

- 2025-10-25 — Plan phase: Scoped doc + script updates to enforce one-pass context and default line-numbered outputs
  Build phase: Updated AGENTS/workflows/memory policy plus load-context/read-files/smart-file-query to emit numbered text with optional --json fallback
  Verify phase: Ran npm run phase:check, git-diff-with-lines, and spot-checked new script modes to confirm line numbers without regressing JSON consumers
- 2025-10-26 — Plan phase: Scoping doc + workflow updates to improve list-files-recursively UX and consolidate retrieval guidance into memory-bank canonical reference.
- 2025-10-26 — Build phase: Updated list-files-recursively CLI to allow default match-all pattern, refreshed AGENTS/tools docs with concrete usage, and retargeted workflows to cite the memory-bank retrieval policy.
- 2025-10-26 — Verify phase: Re-ran npm run phase:check plus git-diff-with-lines after doc/workflow updates and confirmed retrieval guidance now points to the canonical memory-bank policy.
- 2025-10-27 — Plan phase: Planned DEBUG-gated log channel covering service schema, app layer, and testing surfaces.
  Build phase: Implemented logDebug across backend-core + console layer, added DEBUG env schema, rebuilt package.
  Verify phase: Extended logger service tests for DEBUG enabled/disabled and reran npm run phase:check.

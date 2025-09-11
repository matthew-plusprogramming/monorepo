---
last_reviewed: 2025-09-03
stage: implementation
---

# ADR-0001: Adopt Memory Bank + Workflow Process Files

Status: Proposed
Context:

- Need a repo-native coordination system for LLM agents and maintainers that preserves context, decisions, and execution flow.
- Requirements: tiered memory (scratchpad → active → canonical), episodic/reflexive logging, ADR governance, and phase-driven workflows.
- Desire: visibility and diff-able orchestration using Markdown files with validation/drift checks.
  Decision:
- Adopt a Memory Bank with three storage tiers:
  - Tier 0 – Task Context: ephemeral, within workflow files.
  - Tier 1 – Active Context Ring: summarized in active.context.md with Reflexion entries per phase.
  - Tier 2 – Canonical Files: PR-reviewed under agents/memory-bank/\*.
- Establish a default, multi-phase workflow (planner → retriever → architect → implementer → reviewer → tester → documenter) under agents/workflows/.
- Require a 3-line Reflexion after each phase; roll stable learnings into ADRs or system.patterns.md.
- For system-impacting changes, open ADR stubs using decisions/ADR-0000-template.md.
- Prefer GitHub MCP for git workflows.
- Validate memory integrity via npm run memory:validate and npm run memory:drift.
  Consequences (Positive/Negative):
- Positive: Improves continuity, clarity, and traceability; enables handoffs; enforces governance.
- Positive: Easier onboarding for new contributors/agents; predictable execution via phases.
- Negative: Adds process overhead; requires discipline to maintain logs/ADRs; may slow trivial tasks.
  Related: AGENTS.md; agents/workflows/default.workflow.md; agents/memory-bank/system.patterns.md; agents/memory-bank.md

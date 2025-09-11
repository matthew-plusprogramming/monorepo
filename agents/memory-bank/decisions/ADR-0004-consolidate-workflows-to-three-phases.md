---
last_reviewed: 2025-09-11
stage: accepted
---

# ADR-0004: Consolidate Workflows to Three Phases

Status: Accepted
Context:

- The existing default and template workflows included seven phases (planner, retriever, architect, implementer, reviewer, tester, documenter).
- These phases created overhead and duplication between adjacent steps (planning/design/retrieval and review/test/doc).
- Streamlining improves agent velocity while preserving quality gates and Memory Bank discipline.
  Decision:
- Collapse the workflow into three phases: plan → build → verify.
- Update `agents/workflows.md`, `agents/workflows/default.workflow.md`, and `agents/workflows/templates/pattern.workflow.template.md` to reflect the new structure.
- Keep global prompts (retrieval policy, commit approvals, formatting habits) intact.
  Consequences (Positive/Negative):
- Positive: Simpler handoffs, fewer state transitions, clearer milestones; still enforces acceptance criteria, testing, and memory updates.
- Negative: Less granularity in phase-specific reporting; requires updating references in docs and habits.
  Related: `agents/workflows.md`, `agents/workflows/default.workflow.md`, `agents/workflows/templates/pattern.workflow.template.md`, `AGENTS.md`

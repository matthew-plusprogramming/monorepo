---
last_reviewed: 2025-09-13
stage: proposed
---

# ADR-0005: Require Given/When/Then Acceptance Criteria and Non-goals in Plan Phase

Status: Proposed
Context:

- Plan-phase acceptance criteria varied in specificity and testability, leading to ambiguity during implementation and verification.
- Lack of explicit Non-goals occasionally caused scope creep and review churn.
- We want tighter planning artifacts that directly map to verification steps and keep scope boundaries explicit.
  Decision:

- Update `agents/workflows/default.workflow.md` plan phase to require:
  - Acceptance Criteria formatted as short, testable Given/When/Then lines (1–3 concise items).
  - A Non-goals bullet listing items explicitly out of scope.
- Tighten plan-phase gates to require G/W/T presence and Non-goals capture.
- Update verify-phase checklist to trace each G/W/T to a verification step and affirm Non-goals remain out of scope.
  Consequences (Positive/Negative):

- Positive: Clearer, testable acceptance criteria; better traceability from plan → verify; fewer scope misunderstandings; easier PR reviews.
- Negative: Slightly higher upfront planning effort; requires teams to adopt the succinct G/W/T habit.
  Related: `agents/workflows/default.workflow.md`, `agents/memory-bank.md`

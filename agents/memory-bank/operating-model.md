---
last_reviewed: 2025-11-26
---

# Operating Model

## Overview

- Default phases: Requirements → Design → Implementation Planning → Execution.
- Every task has a Task Spec in `agents/ephemeral/task-specs/` that holds these phases; it is created with `node agents/scripts/reset-active-context.mjs --slug <task-slug> [--title "..."]`.
- Reflections are appended to `agents/ephemeral/active.context.md` after each phase using `node agents/scripts/append-memory-entry.mjs`.
- Canonical updates live in `agents/memory-bank/**`; validate via `npm run memory:validate` (or `npm run agent:finalize`) after stable changes.

## Phase Expectations

- **Requirements**
  - Author EARS-formatted user stories and acceptance criteria.
  - List non-goals, constraints, risks, invariants, impacted components, interfaces, and candidate files/tests.
  - Capture retrieval sources consulted.
- **Design**
  - Document architecture (logical, data, control flows) and at least one Mermaid sequence diagram for the primary path.
  - Capture interfaces/contracts, data shapes, edge/failure behaviors, and performance/security/migration considerations.
- **Implementation Planning**
  - Break work into discrete tasks with outcomes, dependencies, and owners (when relevant).
  - Map tests to acceptance criteria for traceability; note blockers and sequencing.
- **Execution**
  - Track progress against tasks, update the spec as reality changes, and log evidence/tests tied to acceptance criteria.
  - Keep changes focused; update canonicals as needed and run quality gates (`npm run phase:check`, `npm run agent:finalize`).

## Artifacts & Tools

- Task Specs: created via `reset-active-context.mjs`; named `<YYYY-MM-DD>-<slug>.md`; include all four phases plus execution log and evidence.
- Active Context: `agents/ephemeral/active.context.md` indexes the current Task Spec and holds reflections.
- Retrieval: use `agents/scripts/load-context.mjs` to pull required context; follow `agents/memory-bank.md#retrieval-policy` for discovery discipline.
- Validation: `npm run agent:finalize` runs formatting, validation, and quality checks before completion.

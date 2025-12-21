---
last_reviewed: 2025-11-26
---

# Operating Model

## Overview

- Default phases: Requirements → Design → Implementation Planning → Execution.
- Every task has a Task Spec under `agents/specs/task-specs/` that holds these phases; it is created with `node agents/scripts/reset-active-context.mjs --slug <task-slug> [--title "..."]`.
- Reflections are recorded in the task spec after each phase, with approvals logged in the Decision & Work Log.
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
  - Identify non-primitive fields and define storage format. (if applicable)
  - Map tests to acceptance criteria for traceability.
  - Identify documentation updates and Memory Bank canonical updates needed.
  - Note blockers and sequencing.
- **Execution**
  - Track progress against tasks, update the spec as reality changes, and log evidence/tests tied to acceptance criteria.
  - Keep changes focused; update canonicals as needed and run quality gates (`npm run phase:check`, `npm run agent:finalize`).

## Artifacts & Tools

- Task Specs: created via `reset-active-context.mjs`; named `<YYYY-MM-DD>-<slug>.md`; include all four phases plus execution log and evidence.
- Retrieval: use `agents/scripts/load-context.mjs --task <path>` to pull required context and include the current task spec; follow `agents/memory-bank.md#retrieval-policy` for discovery discipline.
- Worktrees: orchestrators use `node agents/scripts/manage-worktrees.mjs ensure` to manage per-workstream worktrees; implementers create individual worktrees with `node agents/scripts/create-worktree.mjs --name <workstream-id>` before execution.
- Validation: `npm run agent:finalize` runs formatting, validation, and quality checks before completion.

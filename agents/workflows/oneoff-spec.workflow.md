---
Title: One-off Spec Workflow
---

Intent

- Orchestrate one-off spec changes with visible phases, artifacts, and gates. Keeps memory updated across phases.

Global Prompts

- Retrieval & context discipline: Follow the Retrieval Policy in `agents/memory-bank.md` for required discovery tooling, numbered text defaults, and the single-pass note-taking rule; treat that section as canonical for file inspection guidance.
- Task specs: Each task gets its own spec (Requirements, Design, Implementation Planning, Execution). Create one via `node agents/scripts/reset-active-context.mjs --slug <task-slug> [--title "..."]` and keep it updated.
- Reflection note: After each phase, log a reflection in the task spec and record approvals in the Decision & Work Log.
- Markdown standards: See `AGENTS.md`.

Phase: requirements

- Goal: Clarify the problem and outcomes using EARS; ground the task spec.
- Inputs: Issue/ask
- Checklist:
  - Run `node agents/scripts/load-context.mjs` (add `--include-optional` when optional tiers are relevant).
  - Create/refresh the task spec with the slug for this effort.
  - Capture EARS user stories and acceptance criteria; list non-goals, constraints, risks, invariants.
  - Map impacted components and critical paths; note retrieval sources consulted.
  - Identify interfaces/contracts and candidate files/tests to touch.
  - If system-impacting, open ADR stub.
- Outputs: Task spec Requirements section filled (EARS + acceptance criteria, non-goals, constraints/risks, invariants, interfaces/files/tests to touch); reflection logged in the task spec.
- Done_when: Scope and criteria are clear; risks/constraints logged; invariants confirmed.
- Gates: EARS stories + acceptance criteria are specific/testable; non-goals captured; risks noted; invariants stated.
- Next: design

Phase: design

- Goal: Design how to achieve the outcomes and document flows.
- Checklist:
  - Produce architecture notes (logical, data, control flows) and at least one Mermaid sequence diagram for the primary path.
  - Define interfaces/contracts, data shapes, and error/failure behaviors.
  - Note performance, security, and migration implications; consider test strategy against acceptance criteria.
  - Update the Design section of the task spec.
  - Decide whether an ADR is needed; if yes, start from the template.
- Outputs: Task spec Design section complete; diagrams added; ADR stub if required; reflection logged.
- Done_when: Flows, interfaces, and edge behaviors are clear and trace to Requirements.
- Gates: Primary path diagram present; interfaces and failure modes captured; tests mapped at a high level.
- Next: implementation-planning

Phase: implementation-planning

- Goal: Break down the work into trackable tasks with coverage mapping.
- Checklist:
  - List discrete tasks with outcomes/owners (if relevant) and dependencies.
  - Identify non-primitive fields and define storage format. (if applicable)
  - Map tests to acceptance criteria (traceability back to EARS items).
  - Note sequencing/blockers and checkpoints for progress updates.
  - Update the Implementation Planning section of the task spec.
- Outputs: Task list with outcomes/dependencies; test plan mapped to acceptance criteria; reflection logged.
- Done_when: Tasks are actionable, ordered, and traceable to Requirements/Design.
- Gates: Each acceptance criterion has at least one planned verification; dependencies/risks identified.
- Next: execution

Phase: execution

- Goal: Deliver the change, keep the spec honest, and validate outcomes.
- Checklist:
  - Execute tasks, updating the Execution section with progress, adjustments, and evidence.
  - Implement code/docs; keep changes focused; update canonicals when needed.
  - Run `npm run phase:check` as changes evolve.
  - Run targeted tests; gather outputs; tie evidence back to acceptance criteria.
  - Update Memory Bank canonicals if needed; keep `npm run memory:validate` green.
  - Capture line-numbered diff with `node agents/scripts/git-diff-with-lines.mjs` for verification reports.
  - Run `npm run agent:finalize` before concluding.
  - Propose a conventional commit message.
- Outputs: Code/doc changes; updated task spec Execution log; tests/evidence; Memory Bank updates; commit message proposal; reflection logged.
- Done_when: Acceptance criteria satisfied; risks addressed; quality checks pass; spec reflects what shipped.
- Gates: `npm run agent:finalize` passes; evidence traces to acceptance criteria.

End

- Close with summary, surfaced tests, proposed commit message, and next steps.
- Make sure you propose a commit message.

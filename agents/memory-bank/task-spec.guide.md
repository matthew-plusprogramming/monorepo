---
last_reviewed: 2025-11-26
---

# Task Spec Guide

## Location & Naming

- One file per task under `agents/ephemeral/task-specs/`, named `<YYYY-MM-DD>-<slug>.md`.
- Create via `node agents/scripts/reset-active-context.mjs --slug <task-slug> [--title "..."] [--date YYYY-MM-DD]`.
- Keep the spec updated as the source of truth for the task.

## Sections

- **Requirements**
  - Capture EARS-formatted user stories and acceptance criteria.
  - List non-goals, constraints/risks, invariants, and impacted components.
  - Note interfaces/contracts and candidate files/tests to touch.
- **Design**
  - Document architecture notes (logical/data/control flows).
  - Include at least one Mermaid sequence diagram for the primary flow:
    ```mermaid
    sequenceDiagram
      autonumber
      participant User
      participant System
      User->>System: Primary request
      System-->>User: Outcome
    ```
  - Define interfaces/contracts, data shapes, and edge/failure behaviors.
- **Implementation Planning**
  - Break work into tasks with outcomes, dependencies, and sequencing.
  - Map tests to acceptance criteria for traceability.
- **Execution**
  - Log progress updates and adjustments to the spec.
  - Record evidence/tests tied to acceptance criteria; note follow-ups.

## Tips

- Keep traceability: link each acceptance criterion to tests or evidence in Execution.
- Update the spec incrementally as decisions change; avoid drift between plan and reality.
- Use reflections (`append-memory-entry.mjs`) after each phase to summarize decisions and risks.

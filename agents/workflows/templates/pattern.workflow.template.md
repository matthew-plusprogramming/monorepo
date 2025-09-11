---
Title: <Pattern Name> Workflow
---

Intent

- Encapsulate a high-importance procedural pattern discovered in `agents/memory-bank/system.patterns.md` as a reusable, diff-able workflow.

State

- current_phase: planner
- last_actor: <set by agent>
- derived_from_pattern: <PAT-YYYYMMDD-slug>

Global Prompts

- Follow the same phase structure as default; customize checklists to the pattern’s steps.
- Keep unrelated changes out; update Memory Bank as needed.

Phase: planner

- Goal: Frame when to apply this pattern.
- Inputs: Pattern entry; relevant context files.
- Checklist:
  - Identify applicability and success criteria for pattern use.
  - Note constraints and risks.
- Outputs: Scope and criteria for using this workflow.
- Next: retriever

Phase: retriever

- Goal: Gather context specific to this pattern.
- Inputs: Pattern Steps and Signals; tech/product context.
- Checklist:
  - Map impacted components/interfaces for this pattern.
- Outputs: Focused context.
- Next: architect

Phase: architect

- Goal: Adapt the pattern steps to current task.
- Checklist:
  - Validate the steps; adjust for constraints.
  - Consider performance/security implications.
- Outputs: Tailored plan.
- Next: implementer

Phase: implementer

- Goal: Execute the pattern steps minimally.
- Checklist:
  - Implement scoped changes according to the pattern.
  - Keep diffs minimal and consistent with repo style.
- Outputs: Code changes.
- Next: reviewer

Phase: reviewer

- Goal: Ensure clarity and minimalism.
- Checklist:
  - Self-review diffs against pattern intent and criteria.
- Outputs: Fixups; notes.
- Next: tester

Phase: tester

- Goal: Validate behavior and edge cases.
- Checklist:
  - Run targeted tests; validate signals from the pattern.
- Outputs: Test results.
- Next: documenter

Phase: documenter

- Goal: Update docs and memory.
- Checklist:
  - Record outcomes; update `agents/memory-bank` as needed.
  - If the workflow template evolved, capture those changes here.
- Outputs: Updated docs; notes.
- Next: done

End

- Close with a brief summary and any follow-ups.

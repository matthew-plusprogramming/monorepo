---
Title: <Pattern Name> Workflow
---

Intent

- Encapsulate a high-importance procedural pattern discovered in `agents/memory-bank/system.patterns.md` as a reusable, diff-able workflow.

Global Prompts

- Follow the same three-phase structure as default; customize checklists to the pattern’s steps.
- Keep unrelated changes out; update Memory Bank as needed.

Phase: plan

- Goal: Frame applicability, gather context, and tailor the approach.
- Inputs: Pattern entry; relevant context files.
- Checklist:
  - Identify applicability and success criteria for pattern use.
  - Note constraints and risks.
  - Map impacted components/interfaces specific to this pattern.
  - Adapt the pattern steps for the task; consider perf/security implications.
- Outputs: Scope and criteria; tailored plan for this pattern.
- Next: build

Phase: build

- Goal: Execute the tailored pattern steps minimally.
- Checklist:
  - Implement scoped changes according to the pattern.
  - Keep diffs minimal and consistent with repo style.
- Outputs: Code changes.
- Next: verify

Phase: verify

- Goal: Ensure clarity, validate behavior, and update memory.
- Checklist:
  - Self-review diffs against pattern intent and criteria.
  - Run targeted tests; validate pattern signals and edge cases.
  - Record outcomes; update `agents/memory-bank` as needed.
  - If the workflow template evolved, capture those changes here.
- Outputs: Fixups; test results; updated docs/notes.
- Next: done

End

- Close with a brief summary and any follow-ups.

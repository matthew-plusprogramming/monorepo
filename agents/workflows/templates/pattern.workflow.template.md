---
Title: <Pattern Name> Workflow
---

Intent

- Encapsulate a high-importance procedural pattern discovered in `agents/memory-bank/system.patterns.md` as a reusable, diff-able workflow.

Global Prompts

- Follow the same phase structure as default; customize checklists to the pattern’s steps.
- Keep unrelated changes out; update Memory Bank as needed.
- Use `node agents/scripts/list-files-recursively.mjs` for discovery, `node agents/scripts/smart-file-query.mjs` for targeted searches, and `node agents/scripts/read-files.mjs` when you need ordered contents from multiple files instead of default shell tooling.

Phase: plan

- Goal: Frame applicability, gather context, and tailor the approach.
- Inputs: Pattern entry in `agents/memory-bank/system.patterns.md`; relevant tech/product context; recent progress and active context.
- Checklist:
  - Identify when to apply this pattern and success criteria.
  - Note constraints and risks; map impacted components/interfaces.
  - Validate pattern steps; adjust for current constraints; consider performance and security implications.
- Outputs: Tailored plan; scope and criteria for using this workflow; focused context notes.
- Next: build

Phase: build

- Goal: Execute the pattern steps with minimal diffs and high clarity.
- Checklist:
  - Implement scoped changes according to the pattern; follow repo style.
  - Keep diffs minimal; update docs as needed.
  - Self-review diffs against pattern intent, criteria, and invariants.
- Outputs: Code changes; documentation updates; fixups.
- Next: verify

Phase: verify

- Goal: Validate behavior, edge cases, and update Memory Bank.
- Checklist:
  - Run targeted tests; validate signals from the pattern.
  - Update `agents/memory-bank` as needed; record outcomes.
  - If the workflow template evolved or a new procedural pattern emerged, update/create a workflow and consider an ADR stub.
  - Run memory validation and drift checks:
    - Run `npm run phase:check`
- Outputs: Test results; updated Memory Bank; notes.
- Next: done

End

- Close with a brief summary and any follow-ups.

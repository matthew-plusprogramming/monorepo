---
Title: <Workflow Title Placeholder>
---

Intent

- Describe what this workflow automates and why it exists.
- Outline the boundaries or components it governs.

Problem Statement

- Summarize the pain this workflow resolves.
- Note any constraints, guardrails, or non-goals.

Desired Outcome

- List the concrete success criteria this workflow should guarantee.

Global Prompts

- Reference `agents/memory-bank.md#retrieval-policy` for discovery tooling, numbered output expectations, and single-pass context discipline.
- Call out any workflow-specific safety, coordination, or communication rules.

Phase: plan

- Goal: <What the plan phase must accomplish.>
- Inputs: <Key files, context, or systems to inspect before proposing work.>
- Checklist:
  - <Add bullet items that define planning steps and acceptance criteria.>
- Outputs: <Artifacts required to exit the phase.>
- Next: build

Phase: build

- Goal: <What implementation should deliver.>
- Checklist:
  - <Implementation tasks and verification steps.>
- Outputs: <Code/doc changes, migrations, etc.>
- Next: verify

Phase: verify

- Goal: <How to prove the change met expectations.>
- Checklist:
  - <Tests, validations, and Memory Bank updates.>
- Outputs: <Evidence collected plus any follow-up actions.>
- Next: done

End

- Capture closing notes, deployment sequencing, or follow-up tracking guidance.

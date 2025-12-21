---
Title: One-off Vibe Workflow
---

Intent

- Ship a small change quickly without a formal spec. Keep scope tight and defer to the one-off spec workflow if the task grows.

Guardrails

- Confirm the request is small and bounded; if not, switch to `agents/workflows/oneoff-spec.workflow.md` or orchestrator mode.
- Use `node agents/scripts/load-context.mjs` to load required context before changes.
- Record approvals and key decisions in the final response (or a task spec if you choose to create one).

Phase: intake

- Goal: Confirm scope and expected outcome.
- Checklist:
  - Clarify the request and confirm it is small enough for vibe mode.
  - Note any constraints or risks verbally (no formal spec required).
  - Identify candidate files to touch.
- Done_when: Scope is agreed and bounded.

Phase: execution

- Goal: Implement the change and validate outcomes.
- Checklist:
  - Make focused edits; avoid expanding scope.
  - Run targeted checks/tests when applicable.
  - Run `npm run agent:finalize` before concluding.
  - Summarize changes, tests, and next steps.
- Done_when: Change is shipped, validated, and summarized.

End

- Propose a conventional commit message.

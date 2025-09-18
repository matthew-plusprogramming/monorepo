---
Title: Default Software Change Workflow
---

Intent

- Orchestrate end-to-end changes with visible, diff-able phases, artifacts, and gates. Keeps memory updated across phases.

Global Prompts

- Retrieval: Follow the Retrieval Policy in `agents/memory-bank.md`.
- Reflexion note: After each phase, add a 3-line Reflexion to `active.context.md` and append a succinct entry to `progress.log.md`; doc-only or advisory tasks may batch these updates upon completion when no canonical files change.
- External tools: See `AGENTS.md` for MCP guidance.
- Commit confirmations: If interactive approvals are enabled, request commit confirmation; otherwise proceed with clear, conventional commit messages.
- Markdown standards: See `AGENTS.md`.

Phase: plan

- Goal: Clarify scope, gather context, and propose approach.
- Inputs: Issue/ask; `agents/memory-bank/project.brief.md`; `agents/memory-bank/product.context.md` (if present); `agents/memory-bank/system.patterns.md`; `agents/memory-bank/tech.context.md`; recent `agents/memory-bank/progress.log.md`; ADR template for system-impacting changes.
- Checklist:
  - Define problem statement, desired outcome, and acceptance criteria using a short Given/When/Then block; add a Non-goals bullet.
  - Identify constraints, risks, and assumptions.
  - Map impacted components and critical paths.
  - Identify interfaces, contracts, and invariants; list candidate files and tests to touch.
  - Review `agents/memory-bank/testing.guidelines.md` to align planned tests with boundary strategies and utilities.
  - Sketch design/options; choose and justify approach; note performance, security, and migration implications.
  - If system-impacting, open ADR stub.
- Example format:

  ```md
  Acceptance Criteria (Given/When/Then)

  - Given X; When Y; Then measurable Z

  Non-goals

  - Explicitly out of scope: A, B
  ```

- Outputs: Brief plan; acceptance criteria (Given/When/Then); Non-goals; context notes; file list; invariants list; design notes; ADR stub (if needed); updated `active.context.md` next steps.
- Done_when: Scope and criteria are clear; context coverage is credible; approach addresses constraints.
- Gates: Given/When/Then present, specific, and testable; Non-goals captured; invariants confirmed; risks mitigated; migration path identified.
- Next: build

Phase: build

- Goal: Apply minimal, focused changes and self-review for clarity.
- Inputs: Plan outputs; design notes; file list.
- Checklist:
  - Implement code and docs surgically; keep unrelated changes out; follow repo style.
  - Update `agents/memory-bank` canonical files if required by the change.
  - Self-review diff for clarity and minimalism; verify naming, comments, and docs; re-check invariants and contracts.
  - With confirmation, create `codex/<slug>` branch. If interactive approvals are enabled, request commit confirmation; otherwise proceed with clear, conventional commit messages; push when ready.
- Outputs: Code changes; updated docs; migrations/scripts as needed; review notes and fixups.
- Done_when: Changes compile and meet plan scope.
- Gates: Lint/build pass locally.
- Next: verify

Phase: verify

- Goal: Validate behavior against criteria and finalize Memory Bank updates.
- Inputs: Plan; acceptance criteria; test harness; diff.
- Checklist:
  - Run targeted tests; add missing ones nearby if an adjacent pattern exists.
  - Trace each Given/When/Then to a verification step; confirm Non-goals remain out of scope.
  - Confirm implemented tests follow `agents/memory-bank/testing.guidelines.md` (boundaries, DI, fakes/mocks, flake-proofing).
  - Validate error paths and edge cases; re-run build/lint.
  - Update Memory Bank: canonical files under `agents/memory-bank/`; add/update ADRs for accepted decisions; append Reflexion and progress log entries.
  - Workflow Synthesis: If `agents/memory-bank/system.patterns.md` contains new high-importance procedural patterns, then update an existing workflow or create a new one from `agents/workflows/templates/pattern.workflow.template.md`; for workflow changes that alter behavior, open an ADR stub.
  - Run `npm run lint:fix` and ensure Markdown is formatted via `npm run format:markdown`.
  - Validate Memory Bank and drift:
    - `npm run memory:validate`
    - `npm run memory:drift`
- Outputs: Test results; fixes; updated Memory Bank; optional workflow updates.
- Done_when: Criteria met; no regressions visible; memory validated and drift-free.
- Gates: CI passes (if applicable); memory validation/drift checks pass.
- Next: done

End

- Close with summary and next steps.

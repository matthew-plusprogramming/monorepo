---
Title: Default Software Change Workflow
---

Intent

- Orchestrate end-to-end changes with visible, diff-able phases, artifacts, and gates. Keeps memory updated across phases.

Global Prompts

- Information Retrieval: Follow the Retrieval Policy in `agents/memory-bank.md`.
- File inspection: Prefer `node agents/scripts/list-files-recursively.mjs` for enumerating files, `node agents/scripts/smart-file-query.mjs` for targeted searches, and `node agents/scripts/read-files.mjs` when streaming multiple file contents instead of generic shell commands.
- reflection note: After each phase, add a 3-line reflection to `active.context.md` and append a succinct entry to `progress.log.md`; doc-only or advisory tasks may batch these updates upon completion when no canonical files change.
  - CLI helpers: `node agents/scripts/append-memory-entry.mjs --target active ...` for reflections and `--target progress ...` for log entries keep formatting consistent.
- Markdown standards: See `AGENTS.md`.

Phase: plan

- Goal: Clarify scope, gather context, and propose approach.
- Inputs: Issue/ask
- Checklist:
  - Run `node agents/scripts/load-context.mjs` (add `--include-optional` when optional tiers are relevant) to review required Memory Bank context.
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
- Gates: Given/When/Then present, specific, and testable; Non-goals captured; invariants confirmed; risks mitigated; migration path identified. User approves plan.
- Next: build

Phase: build

- Goal: Apply minimal, focused changes and self-review for clarity.
- Inputs: Plan outputs; design notes; file list.
- Checklist:
  - Implement code and docs surgically; keep unrelated changes out; follow repo style.
  - Update `agents/memory-bank` canonical files if required by the change.
  - Self-review diff for clarity and minimalism.
  - Run `npm run phase:check`
  - Propose a clear, conventional commit message.
- Outputs: Code changes; updated docs; migrations/scripts as needed; review notes and fixups.
- Done_when: Changes compile and meet plan scope.
- Gates: `npm run phase:check` passes.
- Next: verify

Phase: verify

- Goal: Validate behavior against criteria and finalize Memory Bank updates.
- Inputs: Plan; acceptance criteria; test harness; diff.
- Checklist:
  - Run `node agents/scripts/git-diff-with-lines.mjs` to capture line-numbered diff context for the verification report.
  - Run targeted tests; add missing ones nearby if an adjacent pattern exists.
  - Trace each Given/When/Then to a verification step; confirm Non-goals remain out of scope.
  - Confirm implemented tests follow `agents/memory-bank/testing.guidelines.md` (boundaries, DI, fakes/mocks, flake-proofing).
  - Validate error paths and edge cases; re-run build.
  - Update Memory Bank: canonical files under `agents/memory-bank/`; add/update ADRs for accepted decisions; append reflection and progress log entries (use `node agents/scripts/append-memory-entry.mjs` helpers for consistent formatting).
  - Stamp `agents/memory-bank.md` via `node agents/scripts/update-memory-stamp.mjs` once updates are recorded.
  - Workflow Synthesis: If `agents/memory-bank/system.patterns.md` contains new high-importance procedural patterns, then update an existing workflow or create a new one from `agents/workflows/templates/pattern.workflow.template.md`; for workflow changes that alter behavior, open an ADR stub.
  - Validate Memory Bank and drift:
    - `npm run agent:finalize`
- Outputs: Test results; fixes; updated Memory Bank; optional workflow updates.
- Done_when: Criteria met; no regressions visible; memory validated and drift-free.
- Gates: `npm run agent:finalize` passes
- Next: done

End

- Close with summary, surfaced tests, proposed commit message, and next steps.
- Make sure you propose a commit message.

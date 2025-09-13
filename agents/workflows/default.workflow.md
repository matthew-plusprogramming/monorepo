---
Title: Default Software Change Workflow
---

Intent

- Orchestrate end-to-end changes with visible, diff-able phases, artifacts, and gates. Keeps memory updated across phases.

State

- current_phase: plan

Global Prompts

- Retrieval: Follow Retrieval Policy in `agents/memory-bank.md`.
- Reflexion: After each phase, add a 3-line Reflexion to `active.context.md` and a brief `progress.log.md` entry.
- Tools/Standards: See `AGENTS.md` for MCP usage and Markdown formatting.
- Commit approvals: If interactive approvals are enabled, request commit confirmation; otherwise proceed with clear, conventional commit messages.

Phase: plan

- Goal: Clarify scope, gather context, and choose an approach.
- Inputs: Issue/ask; core context per Memory Bank policy.
- Checklist:
  - Define problem statement, desired outcome, and explicit, testable acceptance criteria with a short Given/When/Then block.
  - Capture Non-goals to clarify what is out of scope for this change.
  - Identify constraints, risks, and assumptions.
  - Map impacted components, interfaces, and invariants; list candidate files/tests.
  - Sketch design/options; justify chosen approach; note perf/security/migration implications.
  - If system-impacting, open ADR stub from `agents/memory-bank/decisions/ADR-0000-template.md`.
  - Propose a branch name `codex/<meaningful-slug>` and ask for confirmation to branch.
- Example format (keep 1–3 concise lines):

  ```text
  Acceptance Criteria (Given/When/Then):
  - Given <precondition>; When <action>; Then <measurable outcome>

  Non-goals:
  - <explicitly out of scope item>
  ```

- Outputs: Brief plan; acceptance criteria (Given/When/Then); Non-goals; context notes; design notes; ADR stub (if needed); updated `active.context.md` next steps.
- Done_when: Scope and approach are agreed and testable.
- Gates: Scope clear; Given/When/Then present, specific, and testable; Non-goals captured; no critical gaps; risks noted.
- Next: build

Phase: build

- Goal: Apply minimal, focused changes per plan.
- Inputs: Plan/design; file list.
- Checklist:
  - Implement code and docs surgically; keep unrelated changes out.
  - Update `agents/memory-bank` canonical files if required.
  - Run `npm run lint:fix` and `npm run format:markdown`.
  - Branching/commits: follow `AGENTS.md` conventions; if interactive approvals are enabled, request commit confirmation; otherwise proceed with clear Conventional Commits.
- Outputs: Code changes; updated docs; migrations/scripts as needed.
- Done_when: Changes compile and meet plan scope.
- Gates: Lint/build pass locally.
- Next: verify

Phase: verify

- Goal: Review, test, document, and finalize memory.
- Inputs: Diff; design notes; plan/criteria; test harness; `agents/memory-bank/*`.
- Checklist:
  - Self-review diffs for clarity and minimalism; verify naming and docs; re-check invariants/contracts.
  - Trace each Given/When/Then to a verification step; confirm Non-goals remain out of scope.
  - Run targeted tests; validate error paths/edge cases.
  - Update canonical files under `agents/memory-bank/` as needed; add/update ADRs for accepted decisions.
  - Append Reflexion and progress log entries.
  - Run memory validation and drift checks: `npm run memory:validate` and `npm run memory:drift`.
  - Ensure `npm run lint:fix` and `npm run format:markdown` have been run.
- Outputs: Review notes; test results; Memory Bank updates.
- Done_when: Criteria met; no regressions visible; memory validated and drift-free.
- Gates:
  - `npm run memory:validate`
  - `npm run memory:drift`
- Next: done

End

- Close with summary and next steps.
- Always run `npm run lint:fix` and ensure Markdown is formatted (`npm run format:markdown`).

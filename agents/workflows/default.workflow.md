---
Title: Default Software Change Workflow
---

Intent

- Orchestrate end-to-end changes with visible, diff-able phases, artifacts, and gates. Keeps memory updated across phases.

State

- current_phase: plan

Global Prompts

- Retrieval setup: Identify task type (bug|feature|refactor|ops). Always include `agents/memory-bank/project.brief.md`, recent `agents/memory-bank/progress.log.md`, and `agents/memory-bank/active.context.md`. Add more canonical files by relevance. For system-impacting changes, create an ADR stub PR.
- Reflexion note: After each phase, add a 3-line Reflexion to `active.context.md` and append a succinct entry to `progress.log.md`.
- External tools: Use GitHub MCP for git operations.
- Linting habit: After completing a task, run `npm run lint:fix` and `npm run format:markdown` (Markdown in `agents/**`). Running `npm run lint` or `npm run lint:fix` at the repo root will automatically format `agents/**/*.md` via prelint hooks.
- Branch & commit flow: After confirming with the requester, create a branch named `codex/<meaningful-slug>`, commit with a Conventional Commit title under 70 chars, and push upstream to that branch. Offer this step proactively at the start of implementation.
- Commit confirmation: Before each commit (including fixups), present the proposed Conventional Commit title (< 70 chars) and body, and ask for explicit approval. Do not commit without approval.

Phase: plan

- Goal: Clarify scope, gather context, and choose an approach.
- Inputs: Issue/ask; `project.brief.md`; `product.context.md`; `tech.context.md`; recent `progress.log.md`; `active.context.md`; ADR template.
- Checklist:
  - Define problem statement, desired outcome, and acceptance criteria.
  - Identify constraints, risks, and assumptions.
  - Map impacted components, interfaces, and invariants; list candidate files/tests.
  - Sketch design/options; justify chosen approach; note perf/security/migration implications.
  - If system-impacting, open ADR stub from `agents/memory-bank/decisions/ADR-0000-template.md`.
  - Propose a branch name `codex/<meaningful-slug>` and ask for confirmation to branch.
- Outputs: Brief plan; criteria; context notes; design notes; ADR stub (if needed); updated `active.context.md` next steps.
- Done_when: Scope and approach are agreed and testable.
- Gates: Scope clear; criteria testable; no critical gaps; risks noted.
- Next: build

Phase: build

- Goal: Apply minimal, focused changes per plan.
- Inputs: Plan/design; file list.
- Checklist:
  - Implement code and docs surgically; keep unrelated changes out.
  - Update `agents/memory-bank` canonical files if required.
  - Run `npm run lint:fix` and `npm run format:markdown` to format/fix lint and Markdown.
  - With confirmation, create `codex/<slug>` branch. Before each commit, ask for approval with the proposed Conventional Commit title (< 70 chars) and body; then push to the remote branch when confirmed.
- Outputs: Code changes; updated docs; migrations/scripts as needed.
- Done_when: Changes compile and meet plan scope.
- Gates: Lint/build pass locally.
- Next: verify

Phase: verify

- Goal: Review, test, document, and finalize memory.
- Inputs: Diff; design notes; plan/criteria; test harness; `agents/memory-bank/*`.
- Checklist:
  - Self-review diffs for clarity and minimalism; verify naming and docs; re-check invariants/contracts.
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

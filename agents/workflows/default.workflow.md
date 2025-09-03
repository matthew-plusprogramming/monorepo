Title: Default Software Change Workflow

Intent
- Orchestrate end-to-end changes with visible, diff-able phases, artifacts, and gates. Keeps memory updated across phases.

State
- current_phase: planner
- last_actor: <set by agent>
- started_at: <YYYY-MM-DD>

Global Prompts
- Retrieval setup: Identify task type (bug|feature|refactor|ops). Always include `agents/memory-bank/project.brief.md`, recent `agents/memory-bank/progress.log.md`, and `agents/memory-bank/active.context.md`. Add more canonical files by relevance. For system-impacting changes, create an ADR stub PR.
- Reflexion note: After each phase, add a 3-line Reflexion to `active.context.md` and append a succinct entry to `progress.log.md`.
- External tools: Use GitHub MCP for git operations.

Phase: planner
- Goal: Clarify scope, constraints, success metrics, and plan.
- Inputs: Issue/ask, `project.brief.md`, `product.context.md`.
- Checklist:
  - Define problem statement and desired outcome.
  - Identify constraints, risks, and assumptions.
  - Draft high-level plan and acceptance criteria.
- Outputs: Brief plan; acceptance criteria; updated `active.context.md` next steps.
- Done_when: Stakeholders agree on scope and criteria.
- Gates: Scope clear; criteria testable; risks noted.
- Next: retriever

Phase: retriever
- Goal: Gather relevant context from code and docs.
- Inputs: `system.patterns.md`, `tech.context.md`, recent `progress.log.md`.
- Checklist:
  - Map impacted components and critical paths.
  - Identify interfaces, contracts, and invariants.
  - List candidate files and tests to touch.
- Outputs: Context notes; file list; invariants list.
- Done_when: Coverage of relevant areas is credible.
- Gates: No critical gaps; invariants confirmed.
- Next: architect (or loop to planner if gaps found)

Phase: architect
- Goal: Propose changes with tradeoffs.
- Inputs: Planner+Retriever outputs; ADR template.
- Checklist:
  - Sketch design/options; justify chosen approach.
  - Note performance, security, and migration implications.
  - If system-impacting, open ADR stub.
- Outputs: Design notes; ADR stub (if needed).
- Done_when: Approach addresses criteria and constraints.
- Gates: Risks mitigated; migration path identified.
- Next: implementer

Phase: implementer
- Goal: Apply minimal, focused changes.
- Inputs: Design; file list.
- Checklist:
  - Implement code and docs surgically.
  - Keep unrelated changes out; follow repo style.
  - Update `agents/memory-bank` canonical files if required.
- Outputs: Code changes; updated docs; migrations/scripts as needed.
- Done_when: Changes compile and meet plan scope.
- Gates: Lint/build pass locally.
- Next: reviewer

Phase: reviewer
- Goal: Validate correctness and clarity.
- Inputs: Diff; design notes; acceptance criteria.
- Checklist:
  - Self-review diff for clarity and minimalism.
  - Verify naming, comments, and docs.
  - Re-check invariants and contracts.
- Outputs: Review notes; fixups.
- Done_when: No blocking issues remain.
- Gates: All comments addressed.
- Next: tester

Phase: tester
- Goal: Verify behavior against acceptance criteria.
- Inputs: Plan; criteria; test harness.
- Checklist:
  - Run targeted tests; add missing ones nearby if pattern exists.
  - Validate error paths and edge cases.
  - Re-run build/lint.
- Outputs: Test results; fixes.
- Done_when: Criteria met; no regressions visible.
- Gates: CI passes (if applicable).
- Next: documenter

Phase: documenter
- Goal: Update docs and memory bank.
- Inputs: All prior outputs; `agents/memory-bank/*`.
- Checklist:
  - Update canonical files under `agents/memory-bank/` as needed.
  - Add/Update ADRs for accepted decisions.
  - Append Reflexion and progress log entries.
  - Workflow Synthesis: If `agents/memory-bank/system.patterns.md` contains new high-importance procedural patterns, then either:
    - Modify an existing workflow under `agents/workflows/*.workflow.md` (augment the relevant phase), or
    - Create a new workflow from `agents/workflows/templates/pattern.workflow.template.md` as `agents/workflows/<slug>.workflow.md`.
  - For workflow changes that alter team/system behavior, open an ADR stub.
- Outputs: Updated docs; Memory Bank updates.
- Done_when: Memory validated and drift-free.
- Gates:
  - `npm run memory:validate`
  - `npm run memory:drift`
- Next: done

End
- Close with summary and next steps.

---
Title: Implementer Workflow
---

Intent

- Execute implementation tasks from an approved MasterSpec with gate evidence.
- Keep task specs and Decision & Work Log approvals up to date.

Global Prompts

- Follow `agents/memory-bank.md#retrieval-policy` for discovery tooling and single-pass context discipline.
- Require an approved MasterSpec and gate report before implementation.
- Create or switch to a per-workstream git worktree under `.worktrees/` using `node agents/scripts/create-worktree.mjs --name <workstream-id>` before making changes.
- Record approvals and key decisions in the Decision & Work Log.
- Use `npm run agent:finalize` before concluding.

Phase: requirements

- Goal: Confirm scope and acceptance criteria from the MasterSpec.
- Inputs: approved MasterSpec, gate report summary, contract registry.
- Checklist:
  - Verify MasterSpec status and gate report approval.
  - Identify implementation tasks, interfaces, and acceptance criteria.
  - Note any assumptions or constraints in the task spec.
- Outputs: confirmed scope and task list candidate.
- Next: design

Phase: design

- Goal: Plan implementation approach and integration points.
- Checklist:
  - Document architecture notes for the implementation path.
  - Identify required integrations, migrations, or risk areas.
  - Confirm contract references match the registry.
- Outputs: design notes and risk assessment.
- Next: implementation-planning

Phase: implementation-planning

- Goal: Break implementation into tasks with verification mapping.
- Checklist:
  - Convert MasterSpec tasks into actionable steps with dependencies.
  - Identify non-primitive fields and define storage format. (if applicable)
  - Map tests/evidence to acceptance criteria.
  - Set checkpoints for progress updates.
- Outputs: task breakdown and verification plan.
- Next: execution

Phase: execution

- Goal: Implement changes and validate against the MasterSpec.
- Checklist:
  - Execute tasks and update the task spec Execution log.
  - Run relevant tests and gather evidence tied to acceptance criteria.
  - Update Memory Bank canonicals if needed.
  - Run `npm run phase:check` as changes evolve.
  - Run `npm run agent:finalize` before concluding.
- Outputs: code/doc changes, evidence, updated task spec.
- Next: done

End

- Close with summary, tests, and any follow-ups for the orchestrator.
- Propose a conventional commit message when shipping workflow updates.

---
Title: Orchestrator Workflow
---

Intent

- Run the spec-first pipeline from ProblemBrief through MasterSpec approval and gate reporting.
- Coordinate workstream specs and enforce spec-complete gates before implementation.

Global Prompts

- Follow `agents/memory-bank.md#retrieval-policy` for discovery tooling, numbered output expectations, and single-pass context discipline.
- Use the spec templates in `agents/specs/templates/` and the contract registry at `agents/contracts/registry.yaml`.
- Use `node agents/scripts/manage-worktrees.mjs ensure` to create per-workstream worktrees under `.worktrees/` once workstreams are defined.
- Record approvals and gating decisions in the Decision & Work Log.
- Use `node agents/scripts/spec-validate.mjs` and `node agents/scripts/spec-merge.mjs` to enforce gates.
- Ensure workstream specs include a Workstream Reflection section that captures preventable errors (lint, deprecated code) and remediation ideas.

Phase: requirements

- Goal: Normalize the request into a ProblemBrief and identify workstreams.
- Inputs: user request, `agents/memory-bank/spec-orchestration.design.md`, spec templates.
- Checklist:
  - Create or update the ProblemBrief using `agents/specs/templates/problem-brief.template.md`.
  - Capture goals, non-goals, constraints, and success criteria.
  - Identify candidate workstreams, owners, and dependencies.
  - Note initial contract surfaces that need registry entries.
  - Log any approvals in the Decision & Work Log.
- Outputs: ProblemBrief draft, initial workstream list, candidate contracts.
- Next: design

Phase: design

- Goal: Define workstream boundaries and contract expectations.
- Checklist:
  - Confirm workstream scope, dependencies, and ownership boundaries.
  - Identify shared contracts and ensure each has a registry owner.
  - Provide spec authors with scope, dependencies, and contract expectations.
  - Update the contract registry with placeholders if needed.
- Outputs: scoped workstream assignments, updated registry entries.
- Next: implementation-planning

Phase: implementation-planning

- Goal: Plan spec production and gate checks.
- Checklist:
  - Provide spec authors with `agents/specs/templates/workstream-spec.template.md`.
  - Call out the Workstream Reflection section; instruct authors to capture problems and preventable errors as they arise (lint, deprecated code) with remediation ideas.
  - Run `node agents/scripts/manage-worktrees.mjs ensure --workstreams <ws-ids>` to provision per-workstream worktrees.
  - Define required validation cadence (`spec-validate` before merge).
  - Set spec-complete gates and required evidence.
  - Confirm timeline and communication checkpoints.
- Outputs: spec production plan and validation plan.
- Next: execution

Phase: execution

- Goal: Collect specs, validate, merge, and approve the MasterSpec.
- Checklist:
  - Gather workstream specs from authors.
  - Confirm each workstream spec includes a Workstream Reflection section with issues and prevention notes before merge.
  - Run `node agents/scripts/spec-validate.mjs` on workstream specs and the registry.
  - Run `node agents/scripts/spec-merge.mjs` to generate the MasterSpec and gate report.
  - Resolve validation or merge issues with spec authors.
  - Record spec-complete approval in the Decision & Work Log.
  - Run `npm run spec:finalize` to validate specs + Memory Bank references.
  - Run `npm run agent:finalize` before concluding.
- Outputs: MasterSpec, gate report summary, approval record.
- Next: done

End

- Close with a summary, gate report location, and next handoff steps.
- Propose a conventional commit message when shipping workflow updates.

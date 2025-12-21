---
name: spec-first-orchestration-master-spec
description: MasterSpec plan for implementing spec-first orchestration
---

# Plan

Produce a pinnacle-spec design for modifying the agent system to implement the spec-first orchestration model. This plan acts as the orchestrator's MasterSpec plus workstream packets ready for spec authors.

## Overview (MasterSpec)

ProblemBrief: Implement the spec-first orchestration system across docs, workflows, templates, and tooling so user-selected modes (orchestrator vs one-off) drive how specs and implementation proceed, with explicit review gates and machine-checkable contracts.

## Requirements

- User selects mode: orchestrator or one-off; one-off branches into Vibe (no spec) or Spec (single spec + implementation).
- Orchestrator mode produces workstream specs that conform to required sections and are merged into a MasterSpec.
- MasterSpec gates block implementation until spec-complete, with approvals recorded in Decision & Work Log.
- Required spec section schema is enforced for every workstream spec (and one-off spec).
- Contract registry and validation hooks exist; workflows reflect the run-loop.

## Scope

- In: AGENTS guidance, workflows, spec templates/schema, contract registry, orchestration tooling, validation gates.
- Out: Production-grade runtime orchestration across multiple repos; changes to product features.

## Files and entry points

- `AGENTS.md`
- `agents/memory-bank/spec-orchestration.design.md`
- `agents/workflows/orchestrator.workflow.md`
- `agents/workflows/spec-author.workflow.md`
- `agents/workflows/implementer.workflow.md`
- `agents/workflows/oneoff.workflow.md`
- `agents/workflows/oneoff-spec.workflow.md`
- `agents/workflows/oneoff-vibe.workflow.md`
- `agents/specs/` (templates + per-task specs)
- `agents/contracts/registry.yaml`
- `agents/scripts/spec-validate.mjs`
- `agents/scripts/spec-merge.mjs`
- `package.json` (spec:\* scripts, if adopted)

## Data model / API changes

- Workstream spec schema with required sections.
- MasterSpec file format with workstream list + gates.
- Contract registry schema (id, type, path, owner, version).
- Tooling interfaces for spec init/validate/merge.

## Workstreams (ready for spec authors)

Workstream list:

- WS-1: Mode Selection + Top-Level Guidance (depends on none)
- WS-2: Workflow Library + Run-Loop (depends on WS-1)
- WS-3: Spec Schema + Templates + Contract Registry (depends on WS-1)
- WS-4: Tooling + Validation Gates (depends on WS-2, WS-3)

### WS-1: Mode Selection + Top-Level Guidance

Spec path: `agents/specs/spec-first-orchestration/workstreams/ws-1-mode-selection.md`
Context: AGENTS guidance and canonical docs must make user-directed mode selection explicit and document one-off variants.
Goals / Non-goals:

- Goals: Clear entrypoint decision tree; document one-off vibe vs one-off spec; preserve current one-off spec behavior.
- Non-goals: Implement orchestration runtime.
  Requirements:
- Mode selection prompt is explicit and user-directed.
- One-off Vibe: no spec; uses system context only.
- One-off Spec: single spec using required section schema; approvals logged.
  Core Flows:
- User chooses orchestrator orchestrator runs spec factory.
- User chooses one-off asks Vibe vs Spec; proceeds accordingly.
  Edge Cases:
- User does not choose prompt for mode.
- User requests both modes in one prompt ask to pick a primary.
  Interfaces & Data Model:
- AGENTS decision tree text; references to workflow files.
  Security (if applicable):
- N/A.
  Additional considerations:
- Keep the one-off spec workflow intact for the one-off spec path.
  Testing:
- `npm run agent:finalize` path validation; doc review.
  Open Questions:
- None.
  Decision & Work Log:
- Decision: User selection is the only threshold for orchestrator vs one-off.
- Approval: User confirmed required spec sections + decision log.

### WS-2: Workflow Library + Run-Loop

Spec path: `agents/specs/spec-first-orchestration/workstreams/ws-2-workflow-library.md`
Context: Expand the stub workflows to enforce the spec-first run-loop and handoffs.
Goals / Non-goals:

- Goals: Orchestrator, spec author, implementer, and one-off workflows (overview/spec/vibe) define phases, inputs/outputs, and gates.
- Non-goals: Implement automation beyond documented steps.
  Requirements:
- Orchestrator workflow defines decomposition, spec assignments, merge, and spec-complete gates.
- Spec author workflow requires the section schema and Decision & Work Log.
- Implementer workflow gates on approved MasterSpec.
- One-off workflow covers Vibe vs Spec variants.
  Core Flows:
- Orchestrator spec author spec merge spec-complete implementer.
- One-off Vibe implementer with no spec.
- One-off Spec single spec approval implementation.
  Edge Cases:
- Spec missing required sections gate fail.
- Conflicting contracts return to spec authors.
  Interfaces & Data Model:
- Workflow files under `agents/workflows/*.workflow.md`; references to templates and scripts.
  Security (if applicable):
- N/A.
  Additional considerations:
- Ensure workflows reference spec validation and decision log approvals.
  Testing:
- `npm run agent:finalize` validation; manual walk-through of workflows.
  Open Questions:
- None.
  Decision & Work Log:
- Decision: Orchestrator must record spec-complete approval before implementation begins.

### WS-3: Spec Schema + Templates + Contract Registry

Spec path: `agents/specs/spec-first-orchestration/workstreams/ws-3-spec-schema.md`
Context: Define spec schemas and templates that enforce required sections and contract references.
Goals / Non-goals:

- Goals: Provide templates for ProblemBrief, WorkstreamSpec, MasterSpec; define registry schema.
- Non-goals: Author full workstream specs (that is for spec authors).
  Requirements:
- Workstream spec section list matches the required schema.
- Decision & Work Log is mandatory and holds approvals.
- Contract registry supports type/path/owner/version.
  Core Flows:
- Orchestrator creates ProblemBrief + MasterSpec.
- Spec authors create workstream specs from template.
- Contracts registered and referenced by id.
  Edge Cases:
- Missing required section validation fails.
- Contract id collisions conflict flag.
  Interfaces & Data Model:
- Templates under `agents/specs/templates/`.
- Schemas under `agents/specs/schema/`.
- Registry at `agents/contracts/registry.yaml`.
  Security (if applicable):
- Ensure specs/registry do not embed secrets.
  Additional considerations:
- Keep templates short and explicitly labeled for required sections.
  Testing:
- Validate templates against schemas; `spec-validate` fixtures.
  Open Questions:
- None.
  Decision & Work Log:
- Decision: One-off Spec uses the same section schema as workstreams.

### WS-4: Tooling + Validation Gates

Spec path: `agents/specs/spec-first-orchestration/workstreams/ws-4-tooling-gates.md`
Context: Implement tooling that enforces spec-complete before implementation.
Goals / Non-goals:

- Goals: Spec validation, merge checks, and gating scripts; integrate with workflows.
- Non-goals: Full orchestration runtime.
  Requirements:
- `spec-validate` checks schema compliance and required sections.
- `spec-merge` builds MasterSpec and detects conflicts/acyclic dependencies.
- `spec:finalize` (or equivalent) runs spec validation + memory validation.
  Core Flows:
- Orchestrator runs spec-validate for each workstream.
- Orchestrator runs spec-merge to generate MasterSpec + gate report.
  Edge Cases:
- Invalid YAML/markdown clear error output.
- Cyclic dependencies merge failure.
  Interfaces & Data Model:
- CLI arguments: input paths, output path, registry path.
- Output: MasterSpec + gate report summary.
  Security (if applicable):
- Validate file paths and restrict writes to `agents/specs/`.
  Additional considerations:
- Keep scripts deterministic for easier review.
  Testing:
- Fixture inputs for valid/invalid specs; `npm run agent:finalize`.
  Open Questions:
- None.
  Decision & Work Log:
- Decision: Orchestrator must attach gate report to Decision & Work Log.

## Testing and validation

- `npm run agent:finalize`
- Spec validation via `spec-validate` fixtures (once implemented)

## Risks and edge cases

- Users skip explicit mode selection mitigate with prompt.
- Spec drift after approval mitigate with gate check before implementation.
- Overhead for small tasks one-off vibe path.

## Open questions

- None.

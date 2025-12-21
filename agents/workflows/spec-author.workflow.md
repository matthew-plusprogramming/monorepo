---
Title: Spec Author Workflow
---

Intent

- Produce a compliant workstream spec and register required contracts.
- Keep approvals and decisions in the Decision & Work Log.

Global Prompts

- Follow `agents/memory-bank.md#retrieval-policy` for discovery tooling and single-pass context discipline.
- Use `agents/specs/templates/workstream-spec.template.md` for required sections.
- Reference relevant best-practices docs when applicable.
- Record approvals and gating decisions in the Decision & Work Log.

Phase: requirements

- Goal: Define scope and requirements for the assigned workstream.
- Inputs: orchestrator brief, ProblemBrief, contract registry.
- Checklist:
  - Confirm scope, dependencies, and deliverables with the orchestrator.
  - Draft the workstream spec using the template and required sections.
  - Capture atomic, testable requirements and non-goals.
  - Identify contracts to register and draft entries in `agents/contracts/registry.yaml`.
  - Log any approvals in the Decision & Work Log.
- Outputs: workstream spec draft with requirements + contracts.
- Next: design

Phase: design

- Goal: Document architecture and flows for the workstream.
- Checklist:
  - Add architecture notes (logical, data, control flows).
  - Include a Mermaid sequence diagram for the primary flow.
  - Define interfaces, data shapes, and edge/failure behaviors.
  - Note performance, security, or migration considerations.
- Outputs: design sections complete with diagrams and interfaces.
- Next: implementation-planning

Phase: implementation-planning

- Goal: Produce the Task List and verification plan.
- Checklist:
  - Translate requirements + design into a Task List with outcomes/dependencies.
  - Map tests or evidence to requirements.
  - Note any blockers or sequencing constraints.
- Outputs: Task List and Testing sections complete.
- Next: execution

Phase: execution

- Goal: Finalize the workstream spec and deliver it to the orchestrator.
- Checklist:
  - Run `node agents/scripts/spec-validate.mjs --specs <workstream-spec>` to confirm compliance.
  - Resolve validation issues and ensure all required sections exist.
  - Update the Decision & Work Log with approvals and delivery notes.
  - Deliver the spec to the orchestrator (no code changes).
  - Run `npm run agent:finalize` before concluding.
- Outputs: validated workstream spec, updated registry, delivery confirmation.
- Next: done

End

- Close with a summary and any open questions for the orchestrator.
- Propose a conventional commit message when shipping workflow updates.

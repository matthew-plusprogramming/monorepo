# Specs

This directory holds spec-first artifacts (ProblemBriefs, workstream specs, and MasterSpecs) for orchestrator mode.
See `agents/memory-bank/spec-orchestration.design.md` for the proposed layout.

Recommended layout:

- `agents/specs/<task>/problem-brief.md`
- `agents/specs/<task>/workstreams/<ws-id>.md`
- `agents/specs/<task>/master-spec.md`

Related assets:

- Templates: `agents/specs/templates/`
- Schemas: `agents/specs/schema/`
- Contract registry: `agents/contracts/registry.yaml`

Note: One-off task specs still live under `agents/specs/task-specs/` per the operating model until a full migration is completed.

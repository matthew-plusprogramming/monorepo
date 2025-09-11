---
last_reviewed: 2025-09-03
stage: implementation
---


# Active Context

Current Focus
- Establish Memory Bank canonical files and default workflow. Align AGENTS.md to direct agents through these artifacts.

Next Steps
- Use `agents/workflows/default.workflow.md` for future tasks.
- Record ADRs when changes impact architecture or policy.

Open Decisions
- Define initial ADR index and numbering cadence as the system evolves.

Reflexion
- What happened: Introduced canonical Memory Bank files and default workflow structure; opened ADR-0001 (Proposed) to adopt them.
- What worked: Clear tiering, retrieval policy, and phase gates make orchestration transparent.
- Next time: Expand process templates as patterns emerge (e.g., bug/feature variants).
- What happened (2025-09-10): Extracted Logger/DynamoDB service definitions to backend-core; left live implementations in node-server for reuse across projects.
- What worked: Centralized Effect service tags without disrupting existing app layers; minimal import churn by re-exporting tags from node-server.
- Next time: Consider decoupling service schemas from AWS SDK types to keep core lightweight.
- What happened (2025-09-11): Added UserRepo with findByIdentifier, centralized projection/marshalling and error mapping.
- What worked: Handlers became thin; default Layer applied at bootstrap via backend-core hook.
- Next time: Consider adding create/update methods to UserRepo to remove remaining Dynamo glue from register flow.
- What happened (2025-09-11, later): Promoted `UserPublic` and projection to schemas; added `UserCreate`; repo uses AWS util-dynamodb for marshalling; register now calls `repo.create`.
- What worked: Reduced duplication and made DynamoDB access paths consistent.
- Next time: Consider adding optimistic concurrency (conditional writes) and created/updated timestamps in schema.
- What happened (2025-09-11, policy): Updated default.workflow to always run `npm run lint:fix` after tasks and executed it.
- What worked: Keeps style consistent and avoids noisy diffs later.
- Next time: Consider pre-commit hooks to enforce this automatically.

---
last_reviewed: 2025-09-03
stage: implementation
---


# Progress Log

- 2025-09-03: Scaffolded Memory Bank canonical files, workflows overview, and default workflow. Updated AGENTS.md to direct usage; stamped core metadata; added Reflexion entries.
- 2025-09-03: Added ADR-0001 (Proposed) to adopt Memory Bank + Workflow Process Files.
- 2025-09-03: Folded `agents/memory-bank.core.md` and `agents/memory-bank.deep.md` into canonical files; updated overview, scripts, and references to validate/drift against the entire Memory Bank.
- 2025-09-10: Extracted Logger/DynamoDB Effect service definitions to `packages/core/backend-core`; live Layers remain in `apps/node-server`. Added ADR-0002 (Proposed).
- 2025-09-11: Introduced `UserRepo.findByIdentifier` with centralized projection and error mapping; refactored `getUser` and `register` handlers; added default Layer hook in backend-core and applied at app bootstrap.
- 2025-09-11: Moved `UserPublic` type and projection into `@packages/schemas/user`; added `UserCreate` schema; updated repo to use `@aws-sdk/util-dynamodb` marshall/unmarshall and added `create(user)`; refactored register handler to use repo.create.
- 2025-09-11: Updated default workflow to mandate `npm run lint:fix` after tasks; executed lint:fix across workspaces.

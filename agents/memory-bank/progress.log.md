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
- 2025-09-11: Removed unsafe `as unknown as` cast in `defaultLayer`; enforced default layer presence; eliminated `any` usage in `userRepo.service` with precise AWS types; returned `UserPublic` directly in `getUser` handler and cleaned imports; lint and build clean.
- 2025-09-11: Moved default Layer management to node-server; deleted backend-core `defaultLayer.ts`; `generateRequestHandler` now assumes fully-provided effects; handlers wrap with `Effect.provide(AppLayer)`; added ADR-0003 (Proposed).
- 2025-09-11: Added root script `format:markdown` using Prettier (CommonMark) to format `agents/**/*.md`; wired via prelint hooks so it runs with `lint`/`lint:fix`; updated default workflow and docs accordingly.
- 2025-09-11: Ops check after dependency updates — lint passed, Turbo builds for apps/packages passed, tests via `turbo run test` surfaced missing-task errors for workspaces without `test` scripts; recommended making root test resilient or adding no-op tests.

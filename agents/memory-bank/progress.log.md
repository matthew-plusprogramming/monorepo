---
last_reviewed: 2025-09-03
---

# Progress Log

- 2025-09-03: Scaffolded Memory Bank canonical files, workflows overview, and default workflow. Updated AGENTS.md to direct usage; stamped core metadata; added Reflexion entries.
- 2025-09-03: Added ADR-0001 (Proposed) to adopt Memory Bank + Workflow Process Files.
- 2025-09-03: Folded legacy Memory Bank core/deep docs into canonical files; updated overview, scripts, and references to validate/drift against the entire Memory Bank.
- 2025-09-10: Extracted Logger/DynamoDB Effect service definitions to `packages/core/backend-core`; live Layers remain in `apps/node-server`. Added ADR-0002 (Proposed).
- 2025-09-11: Introduced `UserRepo.findByIdentifier` with centralized projection and error mapping; refactored `getUser` and `register` handlers; added default Layer hook in backend-core and applied at app bootstrap.
- 2025-09-11: Moved `UserPublic` type and projection into `@packages/schemas/user`; added `UserCreate` schema; updated repo to use `@aws-sdk/util-dynamodb` marshall/unmarshall and added `create(user)`; refactored register handler to use repo.create.
- 2025-09-11: Updated default workflow to mandate `npm run lint:fix` after tasks; executed lint:fix across workspaces.
- 2025-09-11: Removed unsafe `as unknown as` cast in `defaultLayer`; enforced default layer presence; eliminated `any` usage in `userRepo.service` with precise AWS types; returned `UserPublic` directly in `getUser` handler and cleaned imports; lint and build clean.
- 2025-09-11: Moved default Layer management to node-server; deleted backend-core `defaultLayer.ts`; `generateRequestHandler` now assumes fully-provided effects; handlers wrap with `Effect.provide(AppLayer)`; added ADR-0003 (Proposed).
- 2025-09-11: Added root script `format:markdown` using Prettier (CommonMark) to format `agents/**/*.md`; wired via prelint hooks so it runs with `lint`/`lint:fix`; updated default workflow and docs accordingly.
- 2025-09-11: Ops check after dependency updates — lint passed, Turbo builds for apps/packages passed, tests via `turbo run test` surfaced missing-task errors for workspaces without `test` scripts; recommended making root test resilient or adding no-op tests.
- 2025-09-11: Consolidated workflows to three phases (plan → build → verify); updated default workflow, pattern template, and overview; added ADR-0004.
- 2025-09-13: Required Given/When/Then acceptance criteria and Non-goals in plan; tightened gates and verify checklist; added ADR-0005; stamped Memory Bank metadata.
- 2025-09-16: Planned alignment of agents Markdown with updated template while preserving repo-specific instructions.
- 2025-09-16: Updated agents Markdown to latest template format while retaining repo-specific policies.
- 2025-09-16: Ran formatting, lint, and memory validation scripts to confirm agents template refresh.
- 2025-09-18: Planned Vitest bootstrap for node-server tests with scoped acceptance criteria and file targets.
- 2025-09-18: Implemented Vitest tooling and added zodParser helper spec in node-server.
- 2025-09-18: Verified Vitest setup via package test script, lint:fix, and memory validation/drift checks.
- 2025-09-18: Extracted Vitest config into @configs/vitest-config with node/browser helpers and updated node-server to consume shared preset.
- 2025-09-18: Planned testing-guidelines refresh to incorporate boundary policies, DI requirements, testing scopes, and supporting utilities.
- 2025-09-18: Authored testing guidelines covering boundary defaults, reusable builders/fakes, unit-type expectations, and review checklist.
- 2025-09-18: Verified testing-guidelines update via markdown formatting, lint:fix, and memory validation/drift (updated stamped repo SHA).
- 2025-09-18: Planned default workflow update to reference the testing guidelines within phase checklists.
- 2025-09-18: Updated default workflow plan/verify checklists to point at the testing guidelines.
- 2025-09-18: Verified workflow update via format:markdown, lint:fix, memory validation, and drift checks.
- 2025-09-18: Scoped node-server testing gap analysis plan aligned to testing guidelines and logged plan reflexion.
- 2025-09-18: Authored node-server testing plan detailing target suites, shared fakes, and priority order.
- 2025-09-18: Verified testing plan updates with markdown formatting plus memory validation and drift checks.
- 2025-09-18: Implemented node-server testing helpers (Dynamo/Logger fakes, user builders, time & UUID utilities, Express harness) and updated tsconfig to include tests; ran Vitest, lint:fix, and memory checks.
- 2025-09-20: Planned uuid test helper typing fix to resolve node-server build errors.
- 2025-09-20: Updated uuid test helper typing and reran node-server build/test scripts to confirm errors cleared.
- 2025-09-20: Completed verification with lint:fix plus memory validation/drift to finalize uuid helper fix.

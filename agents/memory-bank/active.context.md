---
last_reviewed: 2025-09-03
---

# Active Context

Current Focus

- Establish Memory Bank canonical files and default workflow. Align AGENTS.md to direct agents through these artifacts.

Next Steps

- Monitor agents_template for further updates and capture intentional deviations inline.
- Use ADRs when template shifts require policy changes.

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
- What happened (2025-09-11, types): Cleaned up unsafe casts — removed `as unknown as` in `defaultLayer`, replaced `any` with AWS `AttributeValue` in `userRepo.service`, and returned `UserPublic` directly in `getUser`.
- What worked: Stronger types eliminated noisy casts; handlers/readers stayed simple; lint/build green.
- Next time: Tighten `generateRequestHandler` generics to align with `Effect.Effect<A, E, R>` order and remove any residual type looseness.
- What happened (2025-09-11, refactor): Moved default Layer handling from backend-core to node-server; deleted `defaultLayer.ts`; `generateRequestHandler` now expects fully-provided effects with no env deps.
- What worked: Clearer ownership boundary; handlers now explicitly `Effect.provide(AppLayer)`; build stayed green.
- Next time: Add a local helper in node-server to DRY the `provide(AppLayer)` wrapping for handlers and middleware.
- What happened (2025-09-11, docs/ops): Introduced `format:markdown` (Prettier) for `agents/**/*.md` and hooked it to run with lint tasks; updated workflow/docs.
- What worked: Markdown stays consistently formatted to CommonMark with minimal overhead.
- Next time: Consider adding a pre-commit hook to run `format:markdown` on changed `.md` files.
- What happened (2025-09-11, ops): Post-dependency update verification: ran lint (green), full builds via Turbo (green), and attempted tests. `turbo run test` failed due to missing test scripts in some workspaces.
- What worked: Build pipeline validated SSR/client apps and packages; environment injection and postbuild steps executed successfully.
- Next time: Make root `test` resilient (e.g., use `npm -ws run test --if-present`) or add no-op `test` scripts to all workspaces to avoid Turbo missing-task errors.
- What happened (2025-09-11, workflows): Consolidated workflows to 3 phases (plan → build → verify); updated default, template, overview; recorded ADR-0004.
- What worked: Simpler handoffs and fewer transitions while preserving quality gates and Memory Bank updates.
- Next time: Monitor usage and, if needed, add optional sub-checklists per task type without increasing phase count.
- What happened (2025-09-13, workflows): Required Given/When/Then acceptance criteria and Non-goals in plan; tightened gates and verify tracing; added ADR-0005 (Proposed).
- What worked: Clearer testability and scope boundaries; easier verification and review.
- Next time: Consider lightweight lint/template checks to ensure G/W/T and Non-goals presence.
- What happened (2025-09-16, plan): Reviewed agents template updates and scoped required Markdown alignment.
- What worked: Template diff highlighted format deltas; project-specific instructions cataloged for preservation.
- Next time: Mark repo-specific deviations inline to simplify future refreshes.
- What happened (2025-09-16, build): Updated agents Markdown files to match template structure while keeping project-specific policies.
- What worked: Direct rewrite kept diffs clean and ensured repo standards like commit confirmations stayed in place.
- Next time: Consider scripted sync to flag intentional deviations explicitly.
- What happened (2025-09-16, verify): Ran formatting, lint, and memory validation to confirm template alignment.
- What worked: Required scripts and drift checks passed cleanly, validating front matter updates.
- Next time: Bundle template diff/validation steps into a helper checklist to speed verification.
- What happened (2025-09-18, plan): Scoped Vitest bootstrap for node-server, capturing Given/When/Then and candidate files.
- What worked: Memory Bank retrieval highlighted alias constraints and prior test gaps to watch.
- Next time: Pre-check existing Jest configuration overlap before adopting new tooling.
- What happened (2025-09-18, build): Wired Vitest config, dependency, and helper spec for node-server.
- What worked: Vite-style resolve alias kept `@` imports seamless in tests; Effect utilities made assertions straightforward.
- Next time: Consider a shared Vitest preset once more packages adopt the stack.
- What happened (2025-09-18, verify): Ran node-server Vitest, lint:fix, and memory validation/drift checks.
- What worked: Turbo cache limited lint work; memory scripts confirmed stamped SHA alignment.
- Next time: Suppress ES2024 warnings from esbuild for cleaner Vitest output.
- What happened (2025-09-18, plan): Scoped shared Vitest preset extraction into @configs/vitest-config with node/browser exports and alias defaults.
- What worked: Acceptance criteria highlighted alias invariants and targeted files before editing.
- Next time: Evaluate whether other workspaces need additional Vitest defaults (e.g., globals) before codifying.
- What happened (2025-09-18, build): Authored @configs/vitest-config helpers, updated node-server config and workspace dependencies, and compiled the package.
- What worked: Central helper kept alias logic consistent; TypeScript compilation surfaced UserConfig typing gap early.
- Next time: Consider surfacing optional overrides for include patterns instead of requiring consumers to rewrap.
- What happened (2025-09-18, verify): Ran package build, node-server Vitest suite, lint:fix, and prepared memory updates.
- What worked: Workspace install re-linked the new config package so tests consumed shared settings without manual alias tweaks.
- Next time: Automate config package builds inside Turbo pipelines to avoid manual tsc calls before usage.
- What happened (2025-09-18, plan-testing-guidelines): Scoped testing guidelines refresh covering boundaries, DI, utilities, and testing scope; drafted Given/When/Then and candidate files.
- What worked: Workflow retrieval surfaced Memory Bank obligations and validation scripts before editing.
- Next time: Template a testing-guidelines outline to accelerate future updates.
- What happened (2025-09-18, build-testing-guidelines): Authored testing guidelines Memory Bank entry with boundary defaults, reusable utilities, and review checklist.
- What worked: Sectioned bullets kept instructions scannable while mirroring the requested numbered list.
- Next time: Cross-link guideline sections from relevant workflows once patterns solidify.
- What happened (2025-09-18, verify-testing-guidelines): Ran markdown formatting, lint:fix via Turbo, and memory validation/drift after updating stamped SHA.
- What worked: Drift script confirmed front matter alignment once repo SHA updated post-edits.
- Next time: Bundle format+lint+memory scripts into a single npm task for documentation-only changes.
- What happened (2025-09-18, plan-workflow-note): Determined default workflow needs a pointer to the new testing guidelines and scoped update to the plan/verify checklists.
- What worked: Acceptance criteria clarified we just need a concise reference without restructuring other workflows.
- Next time: Consider centralizing cross-references via front-matter links to reduce manual updates.
- What happened (2025-09-18, build-workflow-note): Added testing-guidelines references to the plan and verify checklists in the default workflow.
- What worked: Keeping the reminder scoped to existing bullets avoided disrupting the checklist structure.
- Next time: Evaluate whether build phase also needs a quick reminder once additional tooling exists.
- What happened (2025-09-18, verify-workflow-note): Ran markdown formatting, lint:fix, and memory scripts to confirm workflow edits pass gates.
- What worked: Existing automation caught no extra formatting needs; drift stayed clear since SHA already stamped.
- Next time: Add a unit test or lint rule to ensure workflow checklists keep referencing canonical guidance.
- What happened (2025-09-18, plan-node-server-testing): Scoped node-server test gap analysis using repo guidelines and mapped target files.
- What worked: Testing guidelines highlighted boundary handling and fake requirements before deeper audit.
- Next time: Pre-tag prospective fakes/builders in plan outputs to speed build phase documentation.
- What happened (2025-09-18, build-node-server-testing): Documented node-server testing plan outlining suites, fakes, and sequencing.
- What worked: Structuring by module type clarified boundary coverage and highlighted shared utility needs.
- Next time: Include risk flags for dependencies requiring additional refactors before tests can land.
- What happened (2025-09-18, verify-node-server-testing): Ran markdown formatter and memory scripts to validate the testing plan updates.
- What worked: Formatter confirmed canonical files stay aligned; memory scripts guard against stale path references.
- Next time: Pair verify gate with lint or targeted Vitest run once tests exist.
- What happened (2025-09-18, plan-node-server-testing-helpers): Scoped required DynamoDB/logger fakes, user builders, and time/UUID utilities for upcoming tests.
- What worked: Testing plan plus guidelines clarified helper contracts and boundary expectations quickly.
- Next time: Predefine module namespaces before editing to minimize later refactors when suites land.
- What happened (2025-09-18, build-node-server-testing-helpers): Implemented DynamoDB and logger fakes plus user, time, and UUID helpers with Express context harness under tests/.
- What worked: Layer-based fakes kept Effect wiring straightforward and ensured middleware tests can reuse shared runners.
- Next time: Add typed fixtures for additional services once new suites target other boundaries.
- What happened (2025-09-18, verify-node-server-testing-helpers): Ran node-server Vitest, repo lint:fix, markdown formatting, and memory validation/drift checks; stamped current repo SHA.
- What worked: Reusing root scripts ensured markdown and lint gates stayed in sync with workflow expectations.
- Next time: Consider adding lightweight type-check script for tests folder to flag helper regressions early.
- What happened (2025-09-20, plan): Scoped uuid test helper fix to align Vitest spy typing with crypto.randomUUID.
- What worked: Workflow planning clarified acceptance criteria and kept effort limited to the helper file.
- Next time: Catalog reusable patterns for mocking Node core utilities in tests to speed future tasks.
- What happened (2025-09-20, build): Tightened uuid helper queue typing and mocked crypto.randomUUID with typed MockInstance; verified node-server build and tests locally.
- What worked: Leveraging ReturnType<typeof crypto.randomUUID> avoided template literal assignment errors without changing helper ergonomics.
- Next time: Add convenience assertions to spot exhausted UUID queues during test reviews.
- What happened (2025-09-20, verify): Ran node-server build, Vitest suite, lint:fix, and memory validation/drift to close out UUID helper fix.
- What worked: Memory scripts confirmed front matter SHA update after edits, keeping workflow gates green.
- Next time: Add targeted test covering mock queue exhaustion to ensure verify phase exercises error path.

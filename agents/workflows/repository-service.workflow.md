---
Title: Repository Service Workflow
---

Intent

- Provide a reusable recipe for introducing a new repository service under `apps/node-server/src/services` that keeps schemas, infrastructure, and application layers synchronized when modeling new data.
- Serve as the single canonical reference for repository work; no standalone plan document is required.

Problem Statement

- Adding DynamoDB-backed repositories today requires coordinating schemas, infrastructure outputs, and runtime wiring across the monorepo. A unified workflow prevents drift and guarantees new data models are fully represented.

Desired Outcome

- Cross-package schema, infrastructure, and runtime updates stay aligned for each new repository.
- Effect layers expose typed repository dependencies ready for handlers and services to consume.
- Memory Bank entries capture decisions and validations as part of this workflow.

Global Prompts

- Follow Memory Bank retrieval policy before starting.
- Use `node agents/scripts/list-files-recursively.mjs` and `node agents/scripts/smart-file-query.mjs` for file discovery and content inspection instead of raw shell utilities.
- Coordinate infra/app/schema changes in the same PR; avoid leaving intermediate states that break boot.
- Update the Memory Bank (reflection + progress log) after each phase; the CLI helper `node agents/scripts/append-memory-entry.mjs` keeps entries consistent; rerun validation/drift scripts in verify.

Phase: plan

- Goal: Frame the data model update, dependencies, and acceptance criteria.
- Inputs: Domain requirements, `service.example.ts`, existing repository services (`userRepo`, etc.), schema constants, infrastructure stack definitions, testing guidelines.
- Checklist:
  - Tailor Acceptance Criteria, Non-goals, and Constraints above to the specific domain entity.
  - Identify required schema additions (`packages/core/schemas/schemas`) and DynamoDB resources (`cdk/backend-server-cdk/**`).
  - Map consumers (handlers, services, layers) and confirm interfaces/invariants (Effect layers, logger usage, table names via outputs).
  - Decide on keys/indexes, throughput expectations, and migration/backfill considerations.
  - List candidate files/tests to touch and align on testing strategy (schema unit tests, repository unit tests, handler integration slices).
- Outputs: Updated task context in Memory Bank with acceptance criteria, risks, and targeted files/tests for the entity.
- Next: build

Phase: build

- Goal: Implement the schema, infrastructure, and repository service changes with tight diffs.
- Checklist:
  - Scaffold (highly recommended)
    - Run `node scripts/create-repository-service.mjs <entity-slug>` to generate baseline schemas, CDK stubs, repository service, and fakes.
    - Use `--with handler` (or `--with all`) to opt into additional bundles; run without `--with` in an interactive terminal to pick bundles via prompts.
    - Review the generated checklist under `scripts/output/repository-service/<entity-slug>-checklist.md` and treat remaining TODOs as part of this phase.
    - You can read more at `scripts/README.md`
  - Schemas
    - Add/update Zod schemas, DTO types, and constants under `packages/core/schemas/schemas` (e.g., extend `packages/core/schemas/schemas/user`).
    - Export schema constants for table name/GSI usage; add schema tests.
  - Infrastructure
    - Update or create DynamoDB stack modules in `cdk/backend-server-cdk/src/stacks`.
    - Register new stacks in `stacks.ts`; expose outputs via consumers and re-export table names through `@cdk/backend-server-cdk`.
    - Update CDK outputs loader tests and re-run `npm -w @cdk/backend-server-cdk run lint`.
  - Backend Core (if needed)
    - Define additional domain errors or shared types in `packages/core/backend-core` (e.g., `packages/core/backend-core/src/types/errors`).
  - Repository Service
    - Scaffold a `<Entity>Repo.service.ts` module under `apps/node-server/src/services` (e.g., follow `apps/node-server/src/services/userRepo.service.ts`) using Effect pattern (`Context.Tag`, `Layer.effect`).
    - Inject `DynamoDbService` and `LoggerService`; validate inputs with schemas before persistence; convert AWS SDK errors to `InternalServerError` or domain errors.
    - Load table names via `@/clients/cdkOutputs`; avoid hardcoded literals.
  - Layer Wiring & Consumption
    - Export the repository layer from `apps/node-server/src/layers/app.layer.ts` (or relevant layer module).
    - Update handlers/use cases to inject and use the repository; adjust middleware or service composition as needed.
  - Repository Fake
    - Create or update `apps/node-server/src/__tests__/fakes/<entity>Repo.ts` to implement the repository interface with queue-backed responses.
    - Expose a `Layer` via `Layer.succeed(<Entity>Repo, service)` so tests can provide the fake without additional wiring.
    - Track calls and expose `reset` utilities to clear queues/counters between expectations.
    - Offer helper functions (e.g., `queueFindSome`, `queueCreateFailure`) that enqueue `Effect` results matching the real repository contract.
  - Tests
    - Add repository unit tests (mocking DynamoDB client or using local fake) covering happy path, validation failure, and AWS errors.
    - Extend handler/service integration tests to cover repository usage.
    - Ensure schema and CDK consumer tests reflect new outputs.
  - Self-review
    - Verify imports use barrel exports consistently; ensure no unused exports remain.
    - Run `npm run lint`, targeted package lint/test scripts, and Vitest suites you touched.

- Outputs: Repository service implementation, schema/infra/test updates, passing local checks.
- Next: verify

Phase: verify

- Goal: Validate behavior end-to-end and lock in Memory Bank artifacts.
- Checklist:
  - Map each Given/When/Then acceptance criterion to a completed test or manual verification.
  - Run `npm run lint`, `npm run test`, and targeted CDK/handler suites; capture results.
  - Confirm infra outputs compile by running `npm -w @cdk/backend-server-cdk run cdk:synth:dev`.
  - Update `agents/memory-bank` entries (plan summary, new invariants, system patterns if the workflow evolves); leverage `node agents/scripts/append-memory-entry.mjs` for reflections and progress entries.
  - Stamp `agents/memory-bank.md` via `node agents/scripts/update-memory-stamp.mjs`
  - Ensure documentation references (READMEs, ADRs) are updated if contracts changed.
- Outputs: Test logs, Memory Bank updates, ready-to-merge diff.
- Next: done

End

- Summarize outcomes, note follow-up tasks (backfill jobs, synthetic data scripts), and confirm deployment sequencing (infra first, then app).

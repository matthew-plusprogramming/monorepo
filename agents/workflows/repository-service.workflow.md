---
Title: Repository Service Workflow
---

Intent

- Provide a reusable recipe for introducing a new repository service under `apps/node-server/src/services` that keeps schemas, infrastructure, and application layers synchronized when modeling new data.

Applicability

- Use when creating or extending a DynamoDB-backed repository for a new or existing domain entity.
- Not for pure in-memory fakes or when swapping persistence engines wholesale (open a new workflow if that occurs).

Global Prompts

- Follow Memory Bank retrieval policy before starting.
- Coordinate infra/app/schema changes in the same PR; avoid leaving intermediate states that break boot.
- Update the Memory Bank (Reflexion + progress log) after each phase; rerun validation/drift scripts in verify.

Phase: plan

- Goal: Frame the data model update, dependencies, and acceptance criteria.
- Inputs: Domain requirements, existing repository services (`userRepo`, etc.), schema constants, infrastructure stack definitions, testing guidelines.
- Checklist:
  - Document problem statement, Given/When/Then acceptance criteria, non-goals, and risks.
  - Identify required schema additions (`packages/core/schemas/schemas`) and DynamoDB resources (`cdk/backend-server-cdk/**`).
  - Map consumers (handlers, services, layers) and confirm interfaces/invariants (Effect layers, logger usage, table names via outputs).
  - Decide on keys/indexes, throughput expectations, and migration/backfill considerations.
  - List candidate files/tests to touch and align on testing strategy (schema unit tests, repository unit tests, handler integration slices).
- Outputs: Approved plan document (may reference `agents/workflows/repository-service.plan.md`), updated task context in Memory Bank.
- Next: build

Phase: build

- Goal: Implement the schema, infrastructure, and repository service changes with tight diffs.
- Checklist:
  1. **Schemas**
     - Add/update Zod schemas, DTO types, and constants under `packages/core/schemas/schemas` (e.g., extend `packages/core/schemas/schemas/user`).
     - Export schema constants for table name/GSI usage; add schema tests.
  2. **Infrastructure**
     - Update or create DynamoDB stack modules in `cdk/backend-server-cdk/src/stacks`.
     - Register new stacks in `stackRegistry.ts`; expose outputs via consumers and re-export table names through `@cdk/backend-server-cdk`.
     - Update CDK outputs loader tests and re-run `npm -w @cdk/backend-server-cdk run lint`.
  3. **Backend Core (if needed)**
     - Define additional domain errors or shared types in `packages/core/backend-core` (e.g., `packages/core/backend-core/src/types/errors`).
  4. **Repository Service**
     - Scaffold a `<Entity>Repo.service.ts` module under `apps/node-server/src/services` (e.g., follow `apps/node-server/src/services/userRepo.service.ts`) using Effect pattern (`Context.Tag`, `Layer.effect`).
     - Inject `DynamoDbService` and `LoggerService`; validate inputs with schemas before persistence; convert AWS SDK errors to `InternalServerError` or domain errors.
     - Load table names via `@/clients/cdkOutputs`; avoid hardcoded literals.
  5. **Layer Wiring & Consumption**
     - Export the repository layer from `apps/node-server/src/layers/app.layer.ts` (or relevant layer module).
     - Update handlers/use cases to inject and use the repository; adjust middleware or service composition as needed.
  6. **Tests**
     - Add repository unit tests (mocking DynamoDB client or using local fake) covering happy path, validation failure, and AWS errors.
     - Extend handler/service integration tests to cover repository usage.
     - Ensure schema and CDK consumer tests reflect new outputs.
  7. **Self-review**
     - Verify imports use barrel exports consistently; ensure no unused exports remain.
     - Run `npm run lint`, targeted package lint/test scripts, and Vitest suites you touched.
- Outputs: Repository service implementation, schema/infra/test updates, passing local checks.
- Next: verify

Phase: verify

- Goal: Validate behavior end-to-end and lock in Memory Bank artifacts.
- Checklist:
  - Map each Given/When/Then acceptance criterion to a completed test or manual verification.
  - Run `npm run lint`, `npm run test`, and targeted CDK/handler suites; capture results.
  - Confirm infra outputs compile by running `npm -w @cdk/backend-server-cdk run lint` (and synth if relevant).
  - Update `agents/memory-bank` entries (plan summary, new invariants, system patterns if the workflow evolves).
  - Stamp `agents/memory-bank.md` (`generated_at`, `repo_git_sha`) and rerun validation scripts:
    - `npm run memory:validate`
    - `npm run memory:drift`
  - Ensure documentation references (READMEs, ADRs) are updated if contracts changed.
- Outputs: Test logs, Memory Bank updates, ready-to-merge diff.
- Next: done

End

- Summarize outcomes, note follow-up tasks (backfill jobs, synthetic data scripts), and confirm deployment sequencing (infra first, then app).

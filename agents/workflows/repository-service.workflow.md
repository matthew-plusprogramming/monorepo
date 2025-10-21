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

Acceptance Criteria (Given/When/Then)

- Given a new domain entity requirement, when this workflow is followed end-to-end, then the repository implementation, schemas, infrastructure resources, and tests exist with consistent typings and outputs.
- Given the new repository service, when it is composed within handlers or use cases, then Effect layers resolve without missing dependencies and table names come from CDK outputs.
- Given the new data representation, when `npm run lint`, `npm run test`, and Memory Bank validation scripts run, then they pass without extra manual fixes.

Non-goals

- Production hardening such as multi-region failover or autoscaling policies.
- Replacing existing repositories or global logging strategies.
- Automating deployments beyond ensuring local readiness and documented sequencing.

Constraints & Assumptions

- DynamoDB remains the default backing store; alternative adapters should mirror these patterns.
- Repository services must be injectable via `Context.Tag` and layered through Effect.
- Schemas in `packages/core/schemas` remain the single source of truth for domain contracts.
- Logger integration uses `LoggerService`; avoid ad-hoc console usage.

Risks & Mitigations

- **Missed infrastructure updates** → Couple schema changes with CDK updates and run CDK lint/tests.
- **Misaligned CDK outputs** → Ensure table names flow via `@cdk/backend-server-cdk` consumers and cover with integration tests.
- **Schema drift** → Validate via Zod before persistence and add schema tests mirroring the new domain.

Impacted Components & Critical Paths

- `packages/core/schemas/schemas` — Zod schemas, constants, DTOs.
- `cdk/backend-server-cdk/**` — DynamoDB stacks, output consumers, stack registry.
- `apps/node-server/src/services` — repository implementation using `DynamoDbService`.
- `apps/node-server/src/layers/app.layer.ts` — layer wiring for new repositories.
- `apps/node-server/src/handlers` — consumers of the repository plus related tests.
- `packages/core/backend-core/src/types/errors` — shared error definitions when new domain errors emerge.
- `apps/node-server/src/__tests__` and package-level tests covering schema/service behavior.

Interfaces & Invariants

- Table names and resource identifiers originate from `@/clients/cdkOutputs`; no hardcoded literals.
- Repositories expose Effect-based contracts with explicit error typing (e.g., `InternalServerError` plus domain-specific failures).
- Inputs are validated with Zod before persistence; outputs satisfy public schema shapes.
- Memory Bank entries record workflow usage, decisions, and invariants.

Candidate Files & Tests

- `packages/core/schemas/schemas` (add new modules) and sibling tests such as `packages/core/schemas/schemas/user/user.schemas.test.ts`.
- `cdk/backend-server-cdk/src/stacks` for DynamoDB resources and `cdk/backend-server-cdk/src/stacks.ts` for registration.
- `cdk/backend-server-cdk/src/consumer` for outputs loaders and exports.
- `apps/node-server/src/services` (e.g., `apps/node-server/src/services/userRepo.service.ts`) for repository implementation.
- `apps/node-server/src/layers/app.layer.ts` for wiring the repository layer.
- `apps/node-server/src/handlers` (e.g., `apps/node-server/src/handlers/register.handler.ts`) and associated tests to consume the repository.
- `packages/core/backend-core/src/types/errors` if additional errors are required.

Testing Strategy Alignment

- Add schema unit tests covering validation boundaries per `agents/memory-bank/testing.guidelines.md`.
- Introduce repository-focused tests (mocked DynamoDB client or in-memory fake) for happy/error paths.
- Extend handler/service integration tests to exercise repository usage through Effect layers.
- Run `npm run lint`, `npm run test`, and targeted package scripts (e.g., CDK lint) to guard regressions.

Migration & Performance Notes

- Apply CDK stack changes before releasing app code that depends on new tables/GSIs; sequence deployments infra-first.
- Define keys, GSIs, and projections in schema constants to reflect access patterns and throughput considerations.
- Plan backfill or migration scripts under `scripts/` or relevant packages if historical data must be moved.

Applicability

- Use when creating or extending a DynamoDB-backed repository for a new or existing domain entity.
- Not for pure in-memory fakes or when swapping persistence engines wholesale (open a new workflow if that occurs).

Global Prompts

- Follow Memory Bank retrieval policy before starting.
- Coordinate infra/app/schema changes in the same PR; avoid leaving intermediate states that break boot.
- Update the Memory Bank (Reflexion + progress log) after each phase; rerun validation/drift scripts in verify.

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
  1. **Schemas**
     - Add/update Zod schemas, DTO types, and constants under `packages/core/schemas/schemas` (e.g., extend `packages/core/schemas/schemas/user`).
     - Export schema constants for table name/GSI usage; add schema tests.
  2. **Infrastructure**
     - Update or create DynamoDB stack modules in `cdk/backend-server-cdk/src/stacks`.
     - Register new stacks in `stacks.ts`; expose outputs via consumers and re-export table names through `@cdk/backend-server-cdk`.
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

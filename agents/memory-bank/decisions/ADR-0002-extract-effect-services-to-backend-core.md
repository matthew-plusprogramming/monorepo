---
last_reviewed: 2025-09-10
stage: planning
---


# ADR-0002: Extract Effect Service Definitions to backend-core
Status: Proposed
Context:
- Logger and DynamoDB services were defined within `apps/node-server` with Effect Context Tags and schemas, limiting reuse across backends.
- Other projects in the monorepo (and future ones) also use Effect and need shared service definitions.
Decision:
- Move the Effect service definitions (Context Tags and TypeScript schemas) for `LoggerService` and `DynamoDbService` into `packages/core/backend-core`.
- Keep the concrete live implementations (AWS CloudWatch Logs + DynamoDB clients and Layers) in `apps/node-server`.
Consequences (Positive/Negative):
- Positive: Shared, typed service contracts across projects; encourages consistent layering with Effect; minimal churn by re-exporting tags from node-server.
- Negative: backend-core now depends on AWS SDK types; may increase package weight and build time.
Related: `packages/core/backend-core/src/services/*`, `apps/node-server/src/services/*`


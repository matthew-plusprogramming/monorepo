---
last_reviewed: 2025-09-03
stage: design
---

# System Patterns

Architecture
- Backend service built on Express with typed Effect-based handlers; input validation via Zod.
- Infra via CDK for Terraform with typed outputs consumed by the app.

Components
- API handlers, middleware, services (DynamoDB & logging), auth token/domain schemas, infra stacks and consumers.

Critical Paths
- Request lifecycle: input validation → effectful handler → error mapping → HTTP response.
- Infra outputs: deploy stacks → synth outputs → load via consumer → configure app.

Invariants
- Never hardcode infra resource names; load via `loadCDKOutput()`.
- Validate all external inputs (Zod).
- JWT claims shape fixed by `UserTokenSchema`; auth middleware attaches `req.user`.

Cross-Cutting Concerns
- Security: rate limiting via DynamoDB TTL records; deny list table provisioned; JWT validation enforced.
- Observability: CloudWatch Logs groups/streams for application and security stacks; centralized logger service.
- Error Hygiene: central error taxonomy; Zod error prettification; avoid leaking internals.
- Config/Env: strict env schema at startup; build-time flags (`__BUNDLED__`, `LAMBDA`) drive paths/entrypoints.
- Data Modeling: table keys/GSIs defined once in schema constants and reused across infra/app.

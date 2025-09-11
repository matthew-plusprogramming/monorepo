---
last_reviewed: 2025-09-11
stage: planning
---


# ADR-0003: Move Default Layer Handling to node-server
Status: Proposed
Context:
- `packages/core/backend-core` exposed `setDefaultLayer/applyDefaultLayer` and the `generateRequestHandler` applied the default Layer internally.
- This coupled backend-core to application bootstrap concerns and made the request handler depend on external Layer setup.
Decision:
- Remove `setDefaultLayer`/`applyDefaultLayer` from backend-core and delete `defaultLayer.ts`.
- Update `generateRequestHandler` to expect fully-provided effects (`Effect.Effect<_, _, never>`) with no environment dependencies.
- Apply the application `AppLayer` in `apps/node-server` at the call sites (handlers), keeping default Layer management within the app boundary.
Consequences (Positive/Negative):
- Positive: backend-core request handler is dependency-free and portable; Layer concerns localized to the app; clearer ownership boundaries.
- Negative: Slight duplication in handlers to call `Effect.provide(AppLayer)` until a local helper is introduced.
Related:
- `packages/core/backend-core/src/request.handler.ts`
- `apps/node-server/src/handlers/*`
- `apps/node-server/src/layers/app.layer.ts`

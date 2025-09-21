---
last_reviewed: 2025-09-20
---

# Node-Server Testing Plan

## Current Coverage Snapshot

- Vitest is configured via `apps/node-server/vitest.config.ts`; pure specs now live under `src/__tests__` covering `helpers/zodParser`, `types/environment`, `middleware/jsonError.middleware`, and `location` helpers.
- Shared testing utilities under `src/__tests__` provide Express context, DynamoDB/logger fakes, builders, and time/UUID helpers.
- Client and wiring coverage now includes `clients/cdkOutputs` (base-path toggles), `layers/app.layer` (service composition via fakes), and `lambda.ts` (serverless wrapper + Express wiring).
- Gaps remain across handler logic, Argon2/JWT boundaries, and full Express integration slices (no happy-path or error-path endpoint coverage yet).

## Recommended Test Additions

### Pure/Validation Modules (Completed 2025-09-20)

- Coverage landed for `EnvironmentSchema`, `jsonErrorMiddleware`, and location helpers; specs assert happy-path parsing/coercion plus error delegation.
- Next gap: ensure any future env schemas or pure helpers follow the same table-driven pattern and reuse shared Express context utilities where applicable.

### Services & Layers (Effect Use Cases — Completed 2025-09-20)

- `src/services/userRepo.service.ts`
  - **Test type**: service tests with in-memory fakes.
  - **Dependencies**: Introduce `createDynamoDbServiceFake` exposing spies for `query`, `getItem`, `putItem`; `createLoggerServiceFake` capturing `log`/`logError` calls.
  - **Scenarios**:
    - `findByIdentifier` path: email hits `query` and returns Option.some(UserPublic).
    - `findByIdentifier` fallback: id hits `getItem` and handles Option.none.
    - Error propagation: thrown Dynamo error maps to `InternalServerError` and logs.
    - `create` translates payload via `marshall` and returns `true`; failure maps/logs.
  - **Notes**: Provide Effect test layer via `Layer.succeed` wrappers for fakes; inject via `Effect.provide`.
- `src/services/dynamodb.service.ts`
  - **Test type**: boundary adapter (unit with mocks).
  - **Scenarios**: `getItem`/`putItem` propagate AWS responses; rejection path wraps errors.
  - **Notes**: Mock `DynamoDBClient` methods with `vi.fn`; focus on retry config not needed.
- `src/services/logger.service.ts`
  - **Test type**: adapter with boundary mocks.
  - **Scenarios**: `ApplicationLoggerService` uses console fallback when `PutLogEventsCommand` throws; `logError` emits two entries.
  - **Notes**: Stub `CloudWatchLogsClient.send` and control `Date.now`; assert message shapes.
- `src/layers/app.layer.ts`
  - **Test type**: layering spec using fake modules.
  - **Scenarios**: providing the layer yields DynamoDB, Logger, and UserRepo fakes when the Effect runs.
  - **Notes**: Replace live modules with fakes to avoid AWS client construction.

### Clients & Entry (Completed 2025-09-20)

- `src/clients/cdkOutputs.ts`
  - **Test type**: pure module test with hoisted stub.
  - **Scenarios**: Asserts `loadCDKOutput` receives `undefined` base path locally and `'.'` when `__BUNDLED__` is true; constants expose expected values.
  - **Notes**: Use `vi.resetModules()` between cases to pick up toggled globals.
- `src/lambda.ts`
  - **Test type**: entrypoint wiring test with mocked dependencies.
  - **Scenarios**: Verifies environment parsing, middleware registration order, route binding, and serverless wrapper all point at the mocked Express app.
  - **Notes**: Mock Express factory, handlers, and middlewares to prevent side effects while asserting the wiring contract.

### Middleware

- `src/middleware/isAuthenticated.middleware.ts`
  - **Test type**: middleware service test (Effect + Express double).
  - **Dependencies**: Mock `jsonwebtoken.verify`, supply fake `LoggerService` to record calls.
  - **Scenarios**: missing header → 401; invalid JWT format → 400; verification failure → 401; valid token attaches `req.user` and logs.
  - **Utilities**: Add `makeExpressContext` helper returning `{ req, res, next }` with spies plus runner executing the Effect pipeline.
- `src/middleware/ipRateLimiting.middleware.ts`
  - **Test type**: middleware service test with Dynamo fake.
  - **Dependencies**: Provide fake `DynamoDbService.updateItem` returning shaped `Attributes`; fake `LoggerService` capturing log lines.
  - **Scenarios**: new IP under limit passes and calls `next`; threshold exceed triggers 429 and error log; Dynamo failure surfaces obfuscated 500 path.
  - **Notes**: Freeze time to control TTL; ensure partition key string matches expected pattern.

### Handlers (Domain Logic)

- `src/handlers/getUser.handler.ts`
  - **Test type**: service/use-case test using Effect layers.
  - **Dependencies**: Fake `UserRepo` with controllable responses; no real AWS calls.
  - **Scenarios**: happy path returns `UserPublic`; Option.none maps to `NotFoundError`; Zod validation failure propagates.
  - **Notes**: Provide `AppLayer` override with `Layer.merge` of fakes; assert resulting Either.
- `src/handlers/register.handler.ts`
  - **Test type**: service test with deterministic boundaries.
  - **Dependencies**: Fake `UserRepo`, stubbed `argon2.hash`, `randomUUID`, `Date.now`, `jsonwebtoken.sign`.
  - **Scenarios**: user exists → `ConflictError`; successful creation returns token; hashing/signing failures map to `InternalServerError`.
  - **Utilities**: Create `withFixedTime` helper and `mockRandomUUIDSequence` to maintain deterministic values.

### Integration Slice (Express)

- Endpoint-level spec using `supertest` (add dev dependency if absent).
  - **Scope**: Compose Express app with `Layer.merge` of fakes replacing AWS services.
  - **Scenarios**: `POST /register` happy path returns 201 and token; `GET /user/:id` not found returns 404 with obfuscated message; rate-limited IP yields 429.
  - **Notes**: Ensure integration runner resets fakes between tests; reuse middleware helpers; verify JSON formatting via `jsonErrorMiddleware`.

## Supporting Test Utilities

- `src/__tests__/fakes/dynamodb.ts`: factory returning effect-friendly fake with programmable responses.
- `src/__tests__/fakes/logger.ts`: accumulates logs for assertions.
- `src/__tests__/builders/user.ts`: builder producing `UserPublic`, `UserCreate`, and token payloads with sensible defaults.
- `src/__tests__/utils/time.ts`: helpers for freezing/unfreezing time and overriding `Date.now`.
- `src/__tests__/utils/uuid.ts`: deterministic UUID sequence generator.
- Express test harness: `src/__tests__/utils/express.ts` exports `makeRequestContext(options)` returning mock `req`, `res`, `next`; ensure `res.status` chainable and records payloads.

## Prioritization & Sequencing

1. Establish shared fakes/builders/utilities so subsequent suites stay concise.
2. Cover pure validation utilities (low effort, fast wins).
3. Add `UserRepo` and middleware service tests to lock critical boundaries before refactors.
4. Expand to handler service tests; ensures domain behavior before integration.
5. Finish with integration slice once fakes stabilize.

## Open Questions

- Express app currently hardcodes `AppLayer`; consider exposing factory to inject test layers without mutating production code.
- Decide whether to colocate test fakes under `src/__tests__` or root-level `tests/` for reuse across workspaces.
- Evaluate adding configurable retry/backoff options in `DynamoDbService` to ease failure simulations.

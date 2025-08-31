**Project Overview**
- **Purpose:** Opinionated TypeScript monorepo with a Node/Express server (optionally packaged as AWS Lambda) and CDK for infra. WIP, not production-ready. (evolving)
- **Apps:** `apps/node-server` provides REST endpoints and middleware; can run as an Express server or via `serverless-http` in Lambda.
- **Infra:** `cdk/backend-server-cdk` provisions DynamoDB tables and CloudWatch logs using CDK for Terraform (CDKTF) and supports OpenTofu. (invariant)
- **Packages:** Shared backend core primitives, domain schemas, utilities, and shared configs for TS/Vite/ESLint. (invariant)

**Tech Stack**
- **Runtime:** Node.js + TypeScript 5 (`type: module` across packages). (invariant)
- **Server:** Express 5, built with Vite SSR to CommonJS outputs (`apps/node-server/vite.config.ts`). (evolving)
- **Validation:** Zod 4 for inputs and env (`apps/node-server/src/types/environment.ts`). (invariant)
- **Effects:** Effect 3 for typed effects, layers, and error types (`packages/core/backend-core`). (invariant)
- **AWS:** AWS SDK v3 (DynamoDB, CloudWatch Logs) for data + logging. (evolving)
- **Auth:** JSON Web Tokens (`jsonwebtoken`) with custom claims (`packages/core/schemas/schemas/user/userToken.ts`). (invariant)
- **Infra as Code:** CDKTF + Constructs; OpenTofu/Terraform compatible (`cdk/backend-server-cdk`). (evolving)
- **Tooling:** Turborepo (`turbo.json`, root `package.json`), ESLint flat config, shared TS/Vite configs, dotenvx for envs. (evolving)

**Codebase Map**
- `apps/node-server`
  - Server entry: `src/index.ts`; Lambda entry: `src/lambda.ts` (wraps Express via `serverless-http`).
  - Routes: `src/handlers/register.handler.ts`, `src/handlers/getUser.handler.ts`.
  - Middleware: `src/middleware/jsonError.middleware.ts`, `src/middleware/isAuthenticated.middleware.ts`, `src/middleware/ipRateLimiting.middleware.ts`.
  - Services: `src/services/dynamodb.service.ts` (DynamoDB client wrapper), `src/services/logger.service.ts` (CloudWatch logs).
  - CDK outputs client: `src/clients/cdkOutputs.ts`.
  - Types/env: `src/types/environment.ts`, `src/types/declarations/*` (Express `Request.user`, `ProcessEnv`, `__BUNDLED__`).
  - Helpers: `src/helpers/zodParser.ts`.
  - Build/config: `vite.config.ts`, `tsconfig.json`, `eslint.config.ts`, scripts in `scripts/*.ts` (copy envs and CDK outputs). (evolving)
- `cdk/backend-server-cdk`
  - Entrypoint: `src/index.ts` (reads `AWS_REGION`, instantiates stacks, `app.synth()`).
  - Stacks registry: `src/stacks.ts` (bootstrap, api-stack, api-lambda-stack, api-security-stack).
  - API stack: `src/stacks/api-stack` (DynamoDB user + verification tables; CloudWatch groups/streams; typed outputs).
  - Security stack: `src/stacks/api-security-stack` (rate limit + deny list DynamoDB tables; typed outputs).
  - Lambda stack: `src/stacks/api-lambda-stack` (lambda from build artifact zip). (evolving)
  - Consumers: `src/consumer/*` exposes `loadCDKOutput()` with zod-validated outputs.
  - Backend wiring: `src/utils/standard-backend.ts` (AWS provider, S3 backend via constants in `src/constants/backend.ts`).
  - Scripts: `scripts/copy-lambda-artifacts.ts`, `scripts/cdk-output.ts`, `scripts/cdk-bootstrap-migrate.ts`. (evolving)
- `packages/core/backend-core`
  - Request handler generator: `src/request.handler.ts` maps typed errors → HTTP responses. (invariant)
  - Errors/HTTP: `src/types/errors/*`, `src/types/http.ts`. (invariant)
  - Auth constants: `src/auth/*` (`JWT_ISSUER`, `JWT_AUDIENCE`, `USER_ROLE`). (invariant)
  - Public exports: `src/index.ts` re-exports types and utilities. (invariant)
- `packages/core/schemas`
  - User domain: `schemas/user/*` (user, verification, token; commands: register/getUser; constants including GSI names). (invariant)
  - Security constants: `schemas/security/constants/*` (rate limiting, deny list key shapes). (invariant)
  - Package exports: `package.json` exposes `./user` and `./security`. (invariant)
- `packages/utils`
  - `ts-utils`: simple TTL utils and `exists` helper. (invariant)
  - `type-utils`: typing helpers (e.g., `Prettify<T>` referenced in CDK types). (invariant)
- `packages/configs`
  - `ts-config`: base TS configs (`tsconfig.build.json`, `tsconfig.transpiled.json`, `tsconfig.package.json`). (evolving)
  - `vite-config`: base Vite build defaults. (evolving)
  - `eslint-config`: flat config factory consumed by packages/apps. (evolving)

**Key Modules/APIs**
- `generateRequestHandler` (`packages/core/backend-core/src/request.handler.ts`): (invariant)
  - Inputs: `effectfulHandler`, `shouldObfuscate(error)`, `statusCodesToErrors` map, `successCode`.
  - Behavior: Runs effect; on Left(error), finds matching error type and returns mapped response; obfuscates to 502/"Bad Gateway" if configured; otherwise 500.
- Handlers (`apps/node-server/src/handlers`): (evolving)
  - `POST /register` (`register.handler.ts`): validates body (`RegisterInputSchema`), checks user by email (GSI), inserts user, returns signed JWT (1-hour TTL; claims per `UserToken`). Error mapping: 400 Zod, 409 Conflict, 500 Internal.
  - `GET /user/:identifier` (`getUser.handler.ts`): accepts user `id` or `email`, fetches via GetItem or Query on GSI, returns user; 404 if not found. Error mapping: 400 Zod, 404 NotFound, 500 Internal.
- Middleware (`apps/node-server/src/middleware`):
  - `jsonErrorMiddleware`: 400 on invalid JSON body. (invariant)
  - `isAuthenticated.middleware`: Extracts Bearer token, validates structure with Zod, verifies JWT via `JWT_SECRET`, attaches `req.user` else returns 401/400 via typed errors. (invariant)
  - `ipRateLimiting.middleware`: IP-based rate limiting using DynamoDB `rate-limit-table` (pk=`ip#<ip>`). TTL 60s, threshold 5 → 429. (evolving)
- Services (`apps/node-server/src/services`):
  - `DynamoDbService`: Effect service wrapping GetItem/PutItem/Query (AWS SDK v3). (invariant)
  - `LoggerService`: Effect service sending `PutLogEvents` to CloudWatch Logs; fallback to console on failures. (invariant)
- CDK Output Consumer (`cdk/backend-server-cdk/src/consumer/consumers.ts`):
  - `loadCDKOutput(stack, outputsPath?)`: Reads `cdktf.out/stacks/<stack>/outputs.json`, validates with stack-specific zod schema, caches per process. Used by `apps/node-server/src/clients/cdkOutputs.ts`. (invariant)
- Vite Config (`apps/node-server/vite.config.ts`): (evolving)
  - Uses shared `@configs/vite-config` base; defines alias `@ -> src`; `ssr: true`; output CJS; selects entry `src/lambda.ts` when `LAMBDA=true` else `src/index.ts`; defines `__BUNDLED__`.

**Conventions**
- **Error Modeling:** Use Effect `Data.TaggedError` classes in `backend-core` (HTTP, user, security). Map explicitly to HTTP via `generateRequestHandler`. Prefer obfuscation for internal errors. (invariant)
- **Validation:** All external input validated with Zod. Use `parseInput()` helper to return typed Zod or InternalServerError effects. Env validated at startup with `EnvironmentSchema`. (invariant)
- **Effects & Layers:** Handlers/middleware are Effect pipelines. Provide services with layers (`ApplicationLoggerService`, `LiveDynamoDbService`) at composition boundaries. (invariant)
- **Resource Discovery:** Never hardcode AWS resource names. Load from CDK outputs via `loadCDKOutput()` inside `apps/node-server/src/clients/cdkOutputs.ts`. (invariant)
- **Persistence:** DynamoDB table shapes and GSIs are defined in schema constants; application code references constants (e.g., `USER_SCHEMA_CONSTANTS.gsi.email`). (invariant)
- **Logging:** Prefer `LoggerService.log`/`logError` to emit to CloudWatch; degrade gracefully to console on failure. (invariant)
- **Auth:** JWT claims shape is fixed by `UserTokenSchema`; auth middleware attaches `req.user`. JWT signing uses `JWT_ISSUER`, `JWT_AUDIENCE`, `USER_ROLE` constants. (invariant)
- **Imports:** Use `@` alias for `apps/node-server/src`. Packages export named entrypoints (e.g., `@packages/backend-core/auth`). (evolving)
- **Lint/Format:** Shared ESLint flat config with import sorting, unused imports, TSDoc, Prettier integration. (evolving)
- **TypeScript:** Strict settings, `ES2024` target, incremental builds; shared configs from `@configs/ts-config`. (evolving)

**Workflows**
- **Repo (turborepo):** (evolving)
  - Build: `npm run build` (root) → `turbo run build`; caches `dist/**`.
  - Lint: `npm run lint`/`lint:fix` (root) → `turbo run lint[:fix]`.
  - Clean: `npm run clean` (root) removes `.turbo` and `node_modules`.
- **App: Node Server (`apps/node-server`)** (evolving)
  - Dev: `npm run dev` → copies CDK outputs, ensures `dist/`, copies `.env` + stage file, runs Vite SSR build in watch and `node --watch dist/index.cjs`.
  - Build: `npm run build` → Vite SSR build (`mode=production`); `prebuild: tsc`; `postbuild` copies CDK outputs and stage env.
  - Preview: `npm run preview` → `dotenvx` + `node --watch dist/index.cjs`.
  - Env management: `encrypt-envs` / `decrypt-envs` (dotenvx). Copies merged envs to `dist/.env` via `scripts/copy-env.ts`.
- **Infra: CDKTF (`cdk/backend-server-cdk`)** (evolving)
  - Requirements: `AWS_REGION` env set; OpenTofu CLI recommended (README notes WIP).
  - Deploy/synth/destroy: `cdk:*` scripts with `:dev`/`:prod` variants. Example: `npm run cdk:deploy:dev`.
  - Outputs: `npm run cdk:output:<stage>` then `scripts/cdk-output.ts <stack>` to write `cdktf.out/stacks/<stack>/outputs.json`.
  - Lambda packaging: `scripts/copy-lambda-artifacts.ts` copies the built server output and ensures `cdktf.out` outputs inside the CDK distribution; zip produced as `dist/lambda.zip` for `api-lambda-stack`.
  - Bootstrap migration: `npm run cdk:bootstrap:migrate:<stage>` (WIP).

**Cross-Cutting Concerns**
- **Security:**
  - Rate limiting by IP via DynamoDB TTL records (`RATE_LIMITING_SCHEMA_CONSTANTS`); threshold 5 calls/60s → 429. (invariant)
  - Deny list table provisioned (not yet enforced in middleware here). (evolving)
  - JWT auth middleware validates structure and signature; attaches `req.user`. (invariant)
- **Observability:** CloudWatch Logs groups/streams for application and security stacks. `LoggerService` centralizes writes. (invariant)
- **Error Hygiene:** Central error taxonomy and obfuscation option prevent leaking internals; Zod errors prettified for 400 responses. (invariant)
- **Config/Env:** Env schema enforced at startup; Vite config enforces presence/types for `LAMBDA` and `PORT`. (invariant)
- **Data Modeling:** Table keys/GSIs defined once in schema constants; used consistently in infra + app code. (invariant)

**Glossary**
- **Effect/Layer:** Functional effect system used to model async/typed computations and dependency injection. See `packages/core/backend-core` services and layers (`ApplicationLoggerService`, `LiveDynamoDbService`).
- **handlerInput:** `Effect.Effect<Request, never, never>` used as input to effectful handlers (`packages/core/backend-core/src/types/handler.ts`).
- **generateRequestHandler:** Adapter turning an effectful handler into an Express `RequestHandler` with typed error → status mapping.
- **HTTP_RESPONSE:** Centralized HTTP status codes (`packages/core/backend-core/src/types/http.ts`).
- **Zod schemas:** Domain validation types for user/security, commands (`packages/core/schemas/schemas/**`).
- **USER_SCHEMA_CONSTANTS / VERIFICATION_SCHEMA_CONSTANTS:** Keys and GSIs for user and verification tables.
- **RATE_LIMITING_SCHEMA_CONSTANTS / DENY_LIST_SCHEMA_CONSTANTS:** Partition key names and suffixes for security tables.
- **CDK stacks:** `api-stack`, `api-lambda-stack`, `api-security-stack`, `bootstrap` defined in `cdk/backend-server-cdk/src/stacks.ts`.
- **loadCDKOutput:** Reads and validates `cdktf.out/stacks/<stack>/outputs.json`; used by app to discover resource names.
- **__BUNDLED__ (define):** Vite-defined flag to adjust CDK outputs path at runtime (`apps/node-server/src/clients/cdkOutputs.ts`).
- **LAMBDA env:** Switches server entry from `src/index.ts` to `src/lambda.ts` at build time (`vite.config.ts`).
- **Required envs (server):** `PORT`, `JWT_SECRET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` (`apps/node-server/src/types/environment.ts`).

**Notes/Status**
- README marks repo as WIP; CDK README usage/bootstrapping is incomplete and flagged as TODOs.
- Tests are not implemented (`apps/node-server` test script is a stub).

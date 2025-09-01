---
memory_bank: v1
generated_at: 2025-09-01
repo_git_sha: 53743528f2476ce6646ae9459514d14c91e5db62
---

**Core**
- **Purpose:** Express/Effect/Zod monorepo; optional Lambda; CDKTF infra. (invariant)
- **Entrypoints:**
  - `Server`: `apps/node-server/src/index.ts` (dev) | `apps/node-server/src/lambda.ts` (Lambda) (invariant)
  - `Infra`: `cdk/backend-server-cdk/src/index.ts` (invariant)
- **Where-To-Look-First:**
  - `Handlers`: `apps/node-server/src/handlers/*`
  - `Schemas`: `packages/core/schemas/schemas/**`
  - `Infra stacks`: `cdk/backend-server-cdk/src/stacks/**`
- **Critical Invariants:**
  - Auth claims shape fixed by `UserTokenSchema` (invariant)
  - Resource discovery via `loadCDKOutput()` (never hardcode) (invariant)
  - All external input validated with Zod (invariant)
- **Task Recipes:**
  - "Add endpoint": define Zod schema → handler → map errors in `generateRequestHandler` → route → test
  - "Add table/GSI": edit schema constants → CDK stack → deploy → consume via outputs

**Index**
- `apps/node-server/src/index.ts`: Express app setup and route wiring. (invariant)
- `apps/node-server/src/handlers/*`: Effectful request handlers + error mapping. (invariant)
- `apps/node-server/src/middleware/*`: Auth, rate limit, JSON error handling. (invariant)
- `cdk/backend-server-cdk/src/stacks/**`: Infra definitions (DynamoDB, logs, Lambda). (invariant)
- `cdk/backend-server-cdk/src/consumer/consumers.ts`: `loadCDKOutput` to read stack outputs. (invariant)
- `packages/core/backend-core/src/request.handler.ts`: Effect→Express adapter. (invariant)
- `packages/core/schemas/schemas/**`: Zod domain schemas and constants. (invariant)
- `packages/configs/eslint-config/index.ts`: Shared ESLint config. (evolving)
- `packages/configs/ts-config/**`: Shared TS configs. (evolving)

**Recipes**
- Add endpoint
  - Steps: Define schema in `packages/core/schemas/schemas/**`; implement handler in `apps/node-server/src/handlers/**` using `parseInput`; wrap via `generateRequestHandler`; add route in `apps/node-server/src/index.ts`; run dev.
  - Files: `packages/core/schemas/schemas/**`, `apps/node-server/src/handlers/**`, `apps/node-server/src/index.ts`.
  - Commands: `npm -w node-server run dev`
- Add table/GSI
  - Steps: Update constants in `packages/core/schemas/schemas/user/constants/*`; add table/index in `cdk/backend-server-cdk/src/stacks/**`; deploy; output; ensure app consumes via `apps/node-server/src/clients/cdkOutputs.ts`.
  - Files: `packages/core/schemas/schemas/user/constants/*`, `cdk/backend-server-cdk/src/stacks/**`, `cdk/backend-server-cdk/src/consumer/consumers.ts`, `apps/node-server/src/clients/cdkOutputs.ts`.
  - Commands: `npm -w @cdk/backend-server-cdk run cdk:deploy:dev`, `npm -w @cdk/backend-server-cdk run cdk:output:dev`, `npm -w node-server run build`
- Add middleware
  - Steps: Implement Effect middleware in `apps/node-server/src/middleware/**`; wrap as `RequestHandler`; register in `apps/node-server/src/index.ts`.
  - Files: `apps/node-server/src/middleware/**`, `apps/node-server/src/index.ts`.
  - Commands: `npm -w node-server run dev`

See Deep Reference: `agents/memory-bank.deep.md`

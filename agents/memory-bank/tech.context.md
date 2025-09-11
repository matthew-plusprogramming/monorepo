---
last_reviewed: 2025-09-03
stage: design
---

# Technical Context

Stacks & Tooling

- Node.js + TypeScript, Express, Effect, Zod, JWT.
- AWS SDK v3, CDKTF (OpenTofu/Terraform compatible).
- Turborepo, Vite, ESLint flat config.

Constraints

- TypeScript modules across packages; keep builds and configs consistent.
- Keep changes minimal and localized; adhere to repo style.

Environment

- Local dev for the server; CDKTF for infra with outputs consumed by the app.

Entrypoints

- Server: apps/node-server/src/index.ts (dev) | apps/node-server/src/lambda.ts (Lambda)
- Infra: cdk/backend-server-cdk/src/index.ts

Where To Look First

- Handlers: apps/node-server/src/handlers/\*
- Schemas: packages/core/schemas/schemas/\*\*
- Infra stacks: cdk/backend-server-cdk/src/stacks/\*\*

Codebase Map

- apps/node-server: Express app, middleware, handlers, Lambda wrapper.
- cdk/backend-server-cdk: Stacks, consumers, outputs loader.
- packages/core/backend-core: Effect→Express adapter, services, types.
- packages/core/schemas: Zod domain schemas and constants.
- Shared configs: packages/configs/\*.

Tech Stack Details

- Validation: Zod 4 for inputs and env (apps/node-server/src/types/environment.ts).
- Effects: Effect 3 for typed effects/layers/errors (packages/core/backend-core).
- Auth: JWT with custom claims (packages/core/schemas/schemas/user/userToken.ts).
- Build: Vite SSR to CJS; TS strict, shared configs.

Workflows

- Repo: build/lint/clean via turborepo scripts.
- App (node-server): `dev`, `build`, `preview`, env management via dotenvx.
- Infra (CDKTF): deploy/synth/destroy per stage; outputs written and consumed by app.

Task Recipes

- Add endpoint: define schema → implement handler using `parseInput` → wrap with `generateRequestHandler` → wire route → run dev.
- Add table/GSI: update schema constants → add stack changes → deploy → load outputs → update app client.
- Add middleware: implement Effect middleware → wrap as `RequestHandler` → register in server entry.

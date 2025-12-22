---
last_reviewed: 2025-12-19
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
- Worktree env keys: `.env.keys` are untracked; use `node agents/scripts/sync-worktree-env-keys.mjs` for a single worktree or `node agents/scripts/manage-worktrees.mjs sync` for all to copy keys into `.worktrees` checkouts. `manage-worktrees.mjs ensure` also syncs `cdk/platform-cdk/cdktf-outputs` when present, and use the `dotenvx-run.mjs` wrapper for missing-key hints.
- Optional: use `git worktree` to keep parallel changes isolated (e.g. hidden repo-local `.worktrees/{admin,backend,client}` on `worktree/*` branches).
- When you hit a `"package not found"` error, run `npm run install` at the repo root and retry first.

Entrypoints

- Server: `apps/node-server/src/index.ts` (dev) | `apps/node-server/src/lambda.ts` (Lambda)
- Infra: `cdk/platform-cdk/src/index.ts`

Where To Look First

- Handlers: `apps/node-server/src/handlers/*`
- Schemas: `packages/core/schemas/schemas/**/*`
- Infra stacks: `cdk/platform-cdk/src/stacks/**/*`

Codebase Map

- `apps/node-server`: Express app, middleware, handlers, Lambda wrapper.
- `cdk/platform-cdk`: CDKTF stacks (API, analytics, client website), consumers, outputs loader.
- `packages/core/backend-core`: Effect→Express adapter, services, types.
- `packages/core/schemas`: Zod domain schemas and constants.
- Shared configs: `packages/configs/*`.
- Shared UI: `packages/ui-components` exports reusable React components/styles for the web apps; CSS module typings are generated via `gen:css-types` (watch in `dev`) into `__generated__/src`.

Tech Stack Details

- Validation: Zod 4 for inputs and env `apps/node-server/src/types/environment.ts`.
- Effects: Effect 3 for typed effects/layers/errors `packages/core/backend-core`.
- Auth: JWT with custom claims `packages/core/schemas/schemas/user/userToken.ts` (optional; can be ejected via `npm run eject:users`); role constants in `packages/core/backend-core/src/auth/roles.ts`, admin enforcement via `apps/node-server/src/middleware/isAdmin.middleware.ts`.
- Build: Vite SSR to CJS; TS strict, shared configs.

Workflows

- Repo: build/lint/clean via turborepo scripts.
- App (node-server): `dev`, `build`, `preview`, env management via dotenvx.
- Infra (CDKTF): deploy/synth/destroy per stage; outputs written and consumed by app.

Task Recipes

- Add endpoint: define schema → implement handler using `parseInput` → wrap with `generateRequestHandler` → wire route → run dev.
- Add table/GSI: update schema constants → add stack changes → deploy → load outputs → update app client.
- Add middleware: implement Effect middleware → wrap as `RequestHandler` → register in server entry.

Scaffolding

- Repository scaffolding scripts live under `scripts/**`; `scripts/create-repository-service.mjs` is a thin wrapper over a config-driven runner defined in `scripts/scaffolds/repository-service.config.json` plus shared utilities in `scripts/utils/**`.
- Reusable hooks register via `scripts/utils/hooks.mjs`; configs declare which hooks run per stage (`preScaffold`, `renderTemplates`, `postScaffold`) and map template tokens to resolvers.
- Aspect ejection codemods live under `scripts/eject-aspect.mjs` with per-aspect definitions in `scripts/aspects/*.aspect.mjs` (e.g., `npm run eject:analytics`, `npm run eject:users`).

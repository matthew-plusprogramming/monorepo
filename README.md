# @matthewlin/monorepo

Opinionated TypeScript monorepo with an Express 5 backend, a Next 16 marketing site, EventBridge/DynamoDB analytics processing, and CDK for Terraform (CDKTF) infrastructure. Repo-native agent workflows and Memory Bank docs are part of the core tooling. WIP, not production-ready.

## Quick Start

- Install deps: `npm install`
- Generate CDK outputs for dev (so services find table/log names):
  - API stack: `npm -w @cdk/platform-cdk run cdk:output:dev api-stack`
  - Analytics stack (for heartbeat + analytics lambda): `npm -w @cdk/platform-cdk run cdk:output:dev analytics-stack`
- Run the backend in dev: `npm -w node-server run dev`
- Run the client website (Next app router): `npm -w client-website run dev`

Dev servers use Vite SSR for the backend and Next dev for the client. Env files are managed with dotenvx; encrypted examples live alongside each workspace (`.env.dev` / `.env.production`).

Encrypted envs (dotenvx):
- Encrypted files are examples. If you lack the private key, delete them and create your own env files.
- Manage secrets with workspace scripts:
  - Server: `npm -w node-server run decrypt-envs` / `npm -w node-server run encrypt-envs`
  - CDK: `npm -w @cdk/platform-cdk run decrypt-envs` / `npm -w @cdk/platform-cdk run encrypt-envs`
  - Do not commit decrypted `.env` files (scripts print a warning).

## Workspaces

- Apps
  - `client-website` — Next 16 app-router marketing site with typed Sass modules. See `apps/client-website/README.md`.
  - `node-server` — Express server (Effect) with optional Lambda entry. See `apps/node-server/README.md`.
  - `analytics-lambda` — EventBridge → DynamoDB processor for heartbeat analytics. See `apps/analytics-lambda/README.md`.
- CDK/Infra
  - `@cdk/platform-cdk` — CDKTF stacks (DynamoDB, CloudWatch, Lambda packaging). See `cdk/platform-cdk/README.md`.
- Packages (selected)
  - `@packages/backend-core` — Effect-powered HTTP helpers (request handler adapter, AWS service contexts, auth/error types). See `packages/core/backend-core/README.md`.
  - `@packages/schemas` — Zod schemas for user/security domains and constants (keys, GSIs).
  - `@configs/*` — Shared TS/ESLint/Vite/Vitest configs.

## Common Commands

- Build all: `npm run build`
- Lint all: `npm run lint` (fix: `npm run lint:fix`)
- Clean all: `npm run clean`
- Run a workspace script: `npm -w <package-name> run <script>`
  - Examples: `npm -w node-server run build`, `npm -w @cdk/platform-cdk run cdk:deploy:dev`

## Automation Scripts

- Repository scaffolding: `node scripts/create-repository-service.mjs <entity-slug> [--with handler] [--dry-run] [--force]`
  - Generates schema/CDK/service templates plus a workflow-aligned checklist (see `scripts/README.md`).
- Node handler scaffolding: `node scripts/create-node-server-handler.mjs <handler-slug> [--route <path>] [--method <verb>] [...]`
- CDKTF state manager: `node scripts/manage-cdktf-state.mjs <command>` handles bootstrap/deploy/output flows with guardrails.
- Codemod helper: `tsx scripts/convert-to-arrows.ts` converts eligible functions to arrow expressions across TS/TSX.

## Lambda Packaging (overview)

1) Ensure `LAMBDA=true` in the server’s env for the build stage
2) Build server: `npm -w node-server run build`
3) Prepare Lambda zip in CDK pkg: `npm -w @cdk/platform-cdk run copy-assets-for-cdk`
   - Produces `cdk/platform-cdk/dist/lambda.zip`

## Agents & Memory Bank

- Workflows live under `agents/workflows/` (start with `agents/workflows/default.workflow.md`).
- Memory policies and canonicals live in `agents/memory-bank.md` and `agents/memory-bank/**`.
- Load required context before changes: `node agents/scripts/load-context.mjs`
- Validate/stamp Memory Bank updates:
  - Update front matter in `agents/memory-bank.md` (`generated_at`, `repo_git_sha`)
  - `npm run memory:validate`
  - `npm run memory:drift`

## Status

⚠️ Active WIP; tests are partial, analytics/infra scaffolding is evolving, and Lambda packaging is still being hardened.

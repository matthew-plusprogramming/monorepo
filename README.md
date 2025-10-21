# @matthewlin/monorepo

Opinionated TypeScript monorepo with an Express 5 backend (optionally packaged for AWS Lambda), a React 19 client website, and CDK for Terraform (CDKTF) infrastructure. WIP, not production-ready.

## Quick Start

- Install deps: `npm install`
- Generate CDK outputs for dev (so the app can find table/log names):
  - `npm -w @cdk/backend-server-cdk run cdk:output:dev api-stack`
- Run the server in dev: `npm -w node-server run dev`
- (Optional) Run the client website: `npm -w client-website run dev`

The dev server uses Vite SSR to build to `dist/index.cjs` (see [apps/node-server/vite.config.ts](apps/node-server/vite.config.ts)) and runs `node --watch`. Env files are managed with dotenvx (encrypted [apps/node-server/.env.dev](apps/node-server/.env.dev)/[apps/node-server/.env.production](apps/node-server/.env.production)).

Encrypted envs (dotenvx):
- The encrypted `.env.dev`/`.env.production` files under each workspace are examples. If you don't have the private key, delete them and create your own env files with the required variables.
- Manage secrets with workspace scripts:
  - Server: `npm -w node-server run decrypt-envs` / `npm -w node-server run encrypt-envs`
  - CDK: `npm -w @cdk/backend-server-cdk run decrypt-envs` / `npm -w @cdk/backend-server-cdk run encrypt-envs`
  - Do not commit decrypted `.env` files. The scripts print a warning after decrypt.

## Workspaces

- Apps
  - `client-website` — React 19 + Vite single-page app with typed Sass modules. See [apps/client-website/README.md](apps/client-website/README.md).
  - `node-server` — Express server with optional Lambda entry. See [apps/node-server/README.md](apps/node-server/README.md).
- CDK/Infra
  - `@cdk/backend-server-cdk` — CDKTF stacks (DynamoDB, CloudWatch, Lambda packaging). See [cdk/backend-server-cdk/README.md](cdk/backend-server-cdk/README.md).
- Packages (selected)
  - `@packages/backend-core` — Effect-powered Express adapter, HTTP/status, error types, auth constants.
  - `@packages/schemas` — Zod schemas for user/security domains and constants (keys, GSIs).
  - `@utils/*`, `@configs/*` — Utilities and shared TS/ESLint/Vite configs.

## Common Commands

- Build all: `npm run build`
- Lint all: `npm run lint` (fix: `npm run lint:fix`)
- Clean all: `npm run clean`
- Run a workspace script: `npm -w <package-name> run <script>`
  - Examples: `npm -w node-server run build`, `npm -w @cdk/backend-server-cdk run cdk:deploy:dev`

## Lambda Packaging (overview)

1) Ensure `LAMBDA=true` in the server’s env for the build stage
2) Build server: `npm -w node-server run build`
3) Prepare Lambda zip in CDK pkg: `npm -w @cdk/backend-server-cdk run copy-assets-for-cdk`
   - Produces [cdk/backend-server-cdk/dist/lambda.zip](cdk/backend-server-cdk/dist/lambda.zip)

## Memory Bank (for contributors/agents)

- Read: [agents/memory-bank.md](agents/memory-bank.md) for policy and storage tiers, then dive into files under [agents/memory-bank/](agents/memory-bank/) as needed.
- After changes, update front matter in [agents/memory-bank.md](agents/memory-bank.md):
  - `generated_at`: YYYY-MM-DD
  - `repo_git_sha`: `git rev-parse HEAD`
- Validate links/paths: `npm run memory:validate`
- Drift check vs stamped SHA: `npm run memory:drift`

## Status

⚠️ Active WIP; tests are stubbed for the app, and bootstrap/migration for CDKTF is in progress.

# node-server

Express 5 server written in TypeScript. Builds with Vite (SSR) to CommonJS and can run locally or be packaged for AWS Lambda via `serverless-http`.

## Quick Start

- Install deps at repo root: `npm install`
- Ensure AWS creds are available for DynamoDB access (env or profile)
- Pull CDK outputs for dev:
  - `npm -w @cdk/backend-server-cdk run cdk:output:dev api-stack`
  - `npm -w @cdk/backend-server-cdk run cdk:output:dev api-security-stack`
- Start dev server: `npm -w node-server run dev`

The dev script watches a Vite SSR build and runs `node --watch dist/index.cjs`.

## Scripts

- `dev`: Copies CDK outputs, prepares `dist/`, merges `.env` + `.env.dev`, watches build, runs server
- `build`: Type-checks then Vite SSR build (uses `.env.production`)
- `preview`: Runs `node --watch dist/index.cjs` with `.env.production`
- `lint` / `lint:fix`: ESLint flat config across `src`
- `clean`: Removes `dist/`, `node_modules/`, `.turbo`
- `encrypt-envs` / `decrypt-envs`: Manage `.env.dev` and `.env.production` via dotenvx

Run via workspaces from the repo root, for example:
`npm -w node-server run dev`

## Environment

Validated at startup by Zod ([src/types/environment.ts](src/types/environment.ts)). Required:
- `PORT`: number
- `JWT_SECRET`: string
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`: AWS SDK v3 credentials/region

Files:
- [`.env`](.env): shared non-sensitive defaults (optional)
- [`.env.dev`](.env.dev): encrypted dev secrets (dotenvx)
- [`.env.production`](.env.production): encrypted prod secrets (dotenvx)

Encrypted envs (dotenvx):
- The checked-in encrypted files are examples. If you don't have the private key, decryption will fail. In that case, delete the existing [`.env.dev`](.env.dev) and [`.env.production`](.env.production) and create your own with the required variables.
- Manage secrets with scripts:
  - Decrypt to edit locally: `npm -w node-server run decrypt-envs` (do not commit decrypted files)
  - Re-encrypt after edits: `npm -w node-server run encrypt-envs`
  - Note: the decrypt script prints a warning. Ensure decrypted `.env` files are excluded from commits.

Helpers:
- On build/dev, [scripts/copy-env.ts](scripts/copy-env.ts) writes a merged [dist/.env](dist) for runtime
- [scripts/copy-cdk-outputs.ts](scripts/copy-cdk-outputs.ts) copies outputs from [../../cdk/backend-server-cdk/cdktf-outputs](../../cdk/backend-server-cdk/cdktf-outputs) into [dist/cdktf-outputs](dist/cdktf-outputs)

Tip: If `copy-cdk-outputs` fails in dev, run the two `cdk:output:dev` commands above first.

## Lambda Packaging

This app can run as a Lambda (via [src/lambda.ts](src/lambda.ts)). At build time, Vite selects the entrypoint using the boolean `LAMBDA` env var.

To produce Lambda-ready artifacts:
1) Set `LAMBDA=true` in `.env.production`
2) Build the app: `npm -w node-server run build`
3) From the CDK package, copy + zip artifacts: `npm -w @cdk/backend-server-cdk run copy-assets-for-cdk`
   - Produces [../../cdk/backend-server-cdk/dist/lambda.zip](../../cdk/backend-server-cdk/dist/lambda.zip)

## API Endpoints

- `POST /register`: registers a user; validates input with Zod and uses DynamoDB
- `GET /user/:identifier`: fetches by `id` or `email` (auto-detected); returns 404 if not found

See [src/handlers](src/handlers) and [src/middleware](src/middleware) for details. Routes are wired in [src/index.ts](src/index.ts).

## Project Structure

- [src/index.ts](src/index.ts): Express app entry (local/server)
- [src/lambda.ts](src/lambda.ts): Lambda wrapper via `serverless-http`
- [src/handlers](src/handlers): Effectful request handlers
- [src/middleware](src/middleware): JSON error, auth, rate limiting
- [src/services](src/services): DynamoDB + logging services
- [src/clients/cdkOutputs.ts](src/clients/cdkOutputs.ts): Reads CDK outputs (stack names, tables, logs)
- [vite.config.ts](vite.config.ts): SSR build to CommonJS; selects entry via `LAMBDA`

## Troubleshooting

- Missing CDK outputs: run `cdk:output:dev` for `api-stack` and `api-security-stack`
- Vite error about `PORT`/`LAMBDA`: ensure both are present and typed correctly
- AWS auth errors: verify `AWS_REGION`/keys or an attached role; confirm network access

## Testing

`test` is a placeholder. Consider adding Vitest or integration tests once endpoints stabilize.

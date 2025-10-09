# node-server

Express 5 + Effect server written in TypeScript. Builds with Vite SSR to CommonJS and can run locally or be packaged for AWS Lambda via `serverless-http`. The service publishes authenticated heartbeat analytics events to EventBridge and resolves infrastructure details from CDKTF outputs at runtime.

## Quick Start

- Install dependencies at the repo root: `npm install`
- Ensure AWS credentials are available for DynamoDB/EventBridge access (environment variables or a configured profile)
- Pull CDK outputs for dev (required for table/log names):
  - `npm -w @cdk/backend-server-cdk run cdk:output:dev api-stack`
  - `npm -w @cdk/backend-server-cdk run cdk:output:dev api-security-stack`
- (Optional) Pull analytics outputs if you plan to emit heartbeat events locally:
  - `npm -w @cdk/backend-server-cdk run cdk:output:dev analytics-stack`
- Start the dev server: `npm -w node-server run dev`

The `dev` script orchestrates a Vite SSR watch build and runs `node --watch dist/index.cjs`, copying env files and CDK outputs into `dist/` before booting.

## Scripts

- `dev`: Copies CDK outputs, prepares `dist/`, merges `.env` + `.env.dev`, watches the build, and runs the server.
- `prebuild`: Runs `tsc` to type-check the project.
- `build`: Executes the Vite SSR production build under `.env.production`.
- `postbuild`: Bundles native dependencies (`argon2`), copies CDK outputs, and writes a production `.env` into `dist/`.
- `preview`: Runs `node --watch dist/index.cjs` using the production env.
- `copy-env-dev` / `copy-env-prod`: Merge env files into `dist/.env` for the specified stage.
- `copy-cdk-outputs`: Syncs CDK outputs into `dist/cdktf-outputs`.
- `clean`: Removes `dist/`, `node_modules/`, and `.turbo`.
- `test` / `test:coverage`: Run the Vitest suite (unit + integration) and collect coverage.
- `lint` / `lint:fix` / `lint:no-cache`: ESLint with the shared flat config.
- `encrypt-envs` / `decrypt-envs`: Manage `.env.dev` and `.env.production` via dotenvx (do not commit decrypted files).

Run scripts from the repo root with the workspace flag, e.g. `npm -w node-server run test`.

## Environment

Environment variables are validated at startup using Zod ([src/types/environment.ts](src/types/environment.ts)). Required inputs:

- `PORT`: positive number used by the HTTP server.
- `JWT_SECRET`: secret for signing/verifying auth tokens.
- `PEPPER`: additional secret mixed into password hashes before storage.
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`: AWS SDK v3 credentials/region for DynamoDB, CloudWatch, and EventBridge.
- `APP_ENV`: environment label (defaults to `development`).
- `APP_VERSION`: semantic version surfaced in heartbeat analytics (defaults to `npm_package_version`).

Env files:

- [`.env`](.env): shared non-sensitive defaults (optional).
- [`.env.dev`](.env.dev): encrypted dev secrets (dotenvx).
- [`.env.production`](.env.production): encrypted production secrets (dotenvx).

Encrypted env workflow:

- Decrypt to edit locally (prints a warning): `npm -w node-server run decrypt-envs`
- Re-encrypt after edits: `npm -w node-server run encrypt-envs`
- If you lack the private key, delete the encrypted files and create your own `.env.dev` / `.env.production`.

## Helpers

- [scripts/copy-env.ts](scripts/copy-env.ts): merges environment files into `dist/.env`.
- [scripts/copy-cdk-outputs.ts](scripts/copy-cdk-outputs.ts): copies outputs from [`../../cdk/backend-server-cdk/cdktf-outputs`](../../cdk/backend-server-cdk/cdktf-outputs) into `dist/cdktf-outputs`.
- Tip: if `copy-cdk-outputs` fails, re-run the `cdk:output:dev` commands listed in the quick start section.

## Lambda Packaging

The app can run as a Lambda (via [src/lambda.ts](src/lambda.ts)). Build-time behavior is gated by the boolean `LAMBDA` env var.

To produce Lambda-ready artifacts:

1. Set `LAMBDA=true` (and any prod secrets) in `.env.production`.
2. Build the app: `npm -w node-server run build`
3. Copy and zip artifacts from the CDK package: `npm -w @cdk/backend-server-cdk run copy-assets-for-cdk`
   - Produces [`../../cdk/backend-server-cdk/dist/lambda.zip`](../../cdk/backend-server-cdk/dist/lambda.zip)

## API Endpoints

- `GET /heartbeat`: Requires `Authorization: Bearer <JWT>`. Returns `{ status: 'ok' }` and emits an EventBridge analytics event (user id, timestamp, platform, env, app version). Partial EventBridge failures return `500`.
- `POST /register`: Validates input with Zod, hashes credentials with `PEPPER`, and persists to DynamoDB.
- `GET /user/:identifier`: Fetches a user by `id` or `email`; returns `404` if not found.

Routes are defined in [src/index.ts](src/index.ts); handlers live under [src/handlers](src/handlers) and rely on middleware in [src/middleware](src/middleware).

## Analytics & Observability

- Heartbeat events target the analytics EventBridge bus defined in CDKTF outputs (`analytics-stack`). The handler logs and fails fast when `FailedEntryCount > 0`.
- Structured logs flow through the shared `LoggerService` (CloudWatch Logs in production).
- Ensure analytics outputs exist locally before exercising the heartbeat route; otherwise, EventBridge publishes will fail.

## Project Structure

- [src/index.ts](src/index.ts): Express entrypoint for local/server execution.
- [src/lambda.ts](src/lambda.ts): Lambda wrapper via `serverless-http`.
- [src/handlers](src/handlers): Effectful request handlers.
- [src/middleware](src/middleware): JSON error handling, authentication, and IP rate limiting.
- [src/services](src/services): DynamoDB, EventBridge, and logging services.
- [src/clients/cdkOutputs.ts](src/clients/cdkOutputs.ts): Reads CDK outputs (tables, logs, EventBridge bus).
- [src/layers/app.layer.ts](src/layers/app.layer.ts): Effect layer wiring dependencies for handlers.
- [vite.config.ts](vite.config.ts): SSR build to CommonJS; selects entry via `LAMBDA`.

## Testing

- Run the full suite: `npm -w node-server run test`
- Collect coverage: `npm -w node-server run test:coverage`
- Suites cover handlers, middleware, Express integration slices (supertest), and analytics failure handling.

## Troubleshooting

- Missing CDK outputs: run `cdk:output:dev` for `api-stack`, `api-security-stack`, and `analytics-stack`.
- Vite errors referencing `PORT`, `LAMBDA`, or other env vars: confirm `.env` (or the stage-specific encrypted files) include the required values and rerun `copy-env-dev`.
- EventBridge access denied: ensure credentials allow `events:PutEvents` on the analytics bus and that outputs resolve the bus ARN.
- DynamoDB credential issues: verify AWS region/keys or use an attached IAM role; confirm local network access when talking to AWS directly.

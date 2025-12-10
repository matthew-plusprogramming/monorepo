# analytics-lambda

EventBridge handler that records heartbeat analytics into DynamoDB. The lambda consumes EventBridge `UserAction` events, dedupes user activity, and updates daily/monthly aggregates using stack outputs from `@cdk/platform-cdk`.

## Quick Start

- Install deps at the repo root: `npm install`
- Ensure analytics CDK outputs exist locally: `npm -w @cdk/platform-cdk run cdk:output:dev analytics-stack`
- Run the dev build/watch loop: `npm -w analytics-lambda run dev`
- Build for production: `npm -w analytics-lambda run build`

Env management uses dotenvx with encrypted `.env.dev` / `.env.production` examples:

- Decrypt to edit locally: `npm -w analytics-lambda run decrypt-envs` (do not commit decrypted files)
- Re-encrypt after edits: `npm -w analytics-lambda run encrypt-envs`

## Scripts

- `dev`: Copy CDK outputs, prepare `dist/`, and run Vite SSR watch + `node --watch dist/index.cjs`.
- `preview`: Run the compiled lambda locally with production env.
- `build`: Vite production build under `.env.production`.
- `postbuild`: Copy CDK outputs and production env into `dist/`.
- `copy-cdk-outputs`: Sync analytics outputs from `cdktf-outputs`.
- `copy-env-dev` / `copy-env-prod`: Merge env files into `dist/.env` for the selected stage.
- `clean`: Remove `dist/`, `node_modules/`, and `.turbo`.
- `test`: Placeholder (`echo 'No tests configured yet'`); add coverage when analytics logic grows.
- `lint` / `lint:fix` / `lint:no-cache`: ESLint via the shared config.
- `encrypt-envs` / `decrypt-envs`: Manage encrypted env files with dotenvx (scripts warn after decrypt).

Run scripts from the repo root with the workspace flag, e.g. `npm -w analytics-lambda run lint`.

## Runtime Behavior

- Handler entry: `src/index.ts` wires AWS SDK DynamoDB client and delegates to `AnalyticsProcessor`.
- Processor (`src/analyticsProcessor.ts`) dedupes events per user/day/month and increments aggregate counts; conditional DynamoDB writes are idempotent per period.
- CDK outputs (table names) load via `@cdk/platform-cdk` (`src/clients/cdkOutputs.ts`); when bundled for Lambda, outputs are expected alongside the build artifacts.

## Troubleshooting

- Missing CDK outputs: rerun `cdk:output:dev analytics-stack` and retry `copy-cdk-outputs`.
- DynamoDB permission errors: ensure AWS credentials + `AWS_REGION` are present in the selected `.env` or inherited from the environment.
- Invalid analytics payloads: the processor requires `userId` and an ISO `timestamp` and will throw if either is missing/invalid.

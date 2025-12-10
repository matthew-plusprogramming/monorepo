# @cdk/platform-cdk

Infrastructure for the monorepo using CDK for Terraform (CDKTF). Targets AWS (DynamoDB, CloudWatch Logs, Lambda packaging) and supports OpenTofu/Terraform.

Stacks ([src/stacks.ts](src/stacks.ts)):
- `bootstrap`: CDKTF backend/state resources (WIP migration helper)
- `api-stack`: Application DynamoDB tables (users, verification, rate limit, deny list)
- `api-lambda-stack`: Lambda packaging, IAM role, and analytics permissions
- `analytics-stack`: EventBridge bus, DLQ, DynamoDB tables, and log groups for analytics

## Quick Start

- Install deps at the repo root: `npm install`
- Ensure envs are available (decrypt if you have the key, otherwise create your own `.env.dev` / `.env.production`)
- Synthesize all stacks for dev: `npm -w @cdk/platform-cdk run cdk:synth:dev`
- Deploy dev stacks: `npm -w @cdk/platform-cdk run cdk:deploy:dev`
- Export outputs for app consumption:
  - API stack: `npm -w @cdk/platform-cdk run cdk:output:dev api-stack`
  - Analytics stack: `npm -w @cdk/platform-cdk run cdk:output:dev analytics-stack`

## Prerequisites

- Node.js (repo uses workspaces)
- AWS credentials and `AWS_REGION`
- Dotenvx (provided via devDependency)
- One of: OpenTofu or Terraform. For OpenTofu, you may set `TERRAFORM_BINARY_NAME=tofu` when needed.

Install deps (root): `npm install`

## Environment

Encrypted env files provide AWS settings:
- [`.env.dev`](.env.dev): keys/region for dev
- [`.env.production`](.env.production): keys/region for prod

Scripts set `ENV=dev|production` and load `.env.$ENV` with `dotenvx`. You can prefix any command with `STACK=<prefixed stack name from src/stacks.ts>` to operate on a single stack.

Encrypted envs (dotenvx):
- The checked-in encrypted files are examples. If you don't have the private key, decryption will fail. In that case, delete the existing [`.env.dev`](.env.dev) and [`.env.production`](.env.production) and create your own with the required variables.
- Manage secrets with scripts:
  - Decrypt to edit locally: `npm -w @cdk/platform-cdk run decrypt-envs` (do not commit decrypted files)
  - Re-encrypt after edits: `npm -w @cdk/platform-cdk run encrypt-envs`
  - Note: the decrypt script prints a warning. Ensure decrypted `.env` files are excluded from commits.

## Common Tasks

- Synthesize: `npm -w @cdk/platform-cdk run cdk:synth:dev`
- Deploy all (interactive): `npm -w @cdk/platform-cdk run cdk:deploy:dev`
- Deploy one stack: `STACK=myapp-api-stack npm -w @cdk/platform-cdk run cdk:deploy:dev`
- Destroy: `npm -w @cdk/platform-cdk run cdk:destroy:dev`
- Output JSON for app consumption:
  - `npm -w @cdk/platform-cdk run cdk:output:dev myapp-api-stack`
  - `npm -w @cdk/platform-cdk run cdk:output:dev myapp-analytics-stack`

Outputs are written under [`cdktf-outputs/stacks`](cdktf-outputs/stacks) and validated by schemas in [src/consumer/output](src/consumer/output). The app reads these via `@cdk/platform-cdk`’s `loadCDKOutput` ([src/consumer/consumers.ts](src/consumer/consumers.ts)).

## Lambda Artifact

To package the app Lambda:
1) Build the app with `LAMBDA=true`: `npm -w node-server run build`
2) Copy + zip artifacts here: `npm -w @cdk/platform-cdk run copy-assets-for-cdk`
   - Produces [dist/lambda.zip](dist/lambda.zip)

The copy script ([scripts/copy-lambda-artifacts.ts](scripts/copy-lambda-artifacts.ts)) also brings `cdktf-outputs/**/outputs.json` alongside the bundle so runtime discovery works when `__BUNDLED__` is true.

## Bootstrap/Migration (WIP)

- `npm -w @cdk/platform-cdk run cdk:bootstrap:migrate:dev`
- Use when migrating to a bootstrapped backend; review script [scripts/cdk-bootstrap-migrate.ts](scripts/cdk-bootstrap-migrate.ts) before use.

## Cleaning

- `npm -w @cdk/platform-cdk run clean` removes local deps, `cdktf.out`, `cdktf-outputs`, `.turbo`, `dist`

## Troubleshooting

- Credentials/region errors: verify `.env.$ENV` contains `AWS_REGION`, access key and secret, or rely on instance role
- OpenTofu vs Terraform: if using OpenTofu, export `TERRAFORM_BINARY_NAME=tofu`
- Missing outputs for the app: run the `cdk:output:<stage> <stack>` commands above

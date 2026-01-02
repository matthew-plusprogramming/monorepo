Scripts that may help during development:

> Looking for automation details? See [scripts/README.md](scripts/README.md) for bundle options and deeper guidance.

Aspect ejection

- Preview backend-only tear‑out: `npm run eject:backend-only -- --dry-run`
- Apply backend-only tear‑out: `npm run eject:backend-only`
- Preview analytics tear‑out: `npm run eject:analytics -- --dry-run`
- Apply analytics tear‑out: `npm run eject:analytics`
- Preview users tear‑out: `npm run eject:users -- --dry-run`
- Apply users tear‑out: `npm run eject:users`

Command sequences (configurable via `scripts/sequences.config.json`)

- List available sequences: `npm run sequence -- list`
- Run a sequence: `npm run sequence -- run <name> [--dry-run]`
- Current names: `build-deploy-node-server`, `outputs-after-clean`, `full-clean-and-test`

Build and deploy lambda (node-server) — `build-deploy-node-server`

```
npm -w node-server run decrypt-envs
npm -w node-server run build
npm -w @cdk/platform-cdk run copy-assets-for-cdk
npm -w @cdk/platform-cdk run cdk:deploy:dev myapp-api-lambda-stack
npm -w node-server run encrypt-envs
```

Get outputs for myapp-api-stack after clean — `outputs-after-clean`

```
npm run build
npm -w @cdk/platform-cdk run cdk:output:dev myapp-api-stack
```

Full clean and test — `full-clean-and-test`

```
npm run clean
npm i
npm run build
npm -w @cdk/platform-cdk run cdk:output:dev myapp-api-stack
npm -w @cdk/platform-cdk run cdk:output:dev myapp-analytics-stack
npm -w node-server run decrypt-envs
npm -w node-server run build
npm -w @cdk/platform-cdk run copy-assets-for-cdk
npm -w @cdk/platform-cdk run cdk:deploy:dev myapp-api-lambda-stack
npm -w node-server run encrypt-envs
npm run test
```

Scaffold a repository service workflow skeleton

```
node scripts/create-repository-service.mjs <entity-slug>
# Optional flags:
#   --with handler           Include optional scaffolding bundles (comma separated or "all")
#   --dry-run  Preview generated files without writing
#   --force    Overwrite existing files created in a previous run
```

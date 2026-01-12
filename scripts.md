Scripts that may help during development:

> Looking for automation details? See [scripts/README.md](scripts/README.md) for bundle options and deeper guidance.

## CDK Orchestrator

The unified CDK orchestration script handles all CDKTF operations:

```bash
# Show current state
node scripts/cdk.mjs status

# Deploy infrastructure stacks (api-stack, analytics-stack)
node scripts/cdk.mjs deploy infra --auto-approve

# Deploy all stacks to production
node scripts/cdk.mjs deploy all --prod --auto-approve

# Pull outputs from deployed stacks
node scripts/cdk.mjs outputs infra

# Full preparation: build + copy assets + pull outputs
node scripts/cdk.mjs prepare

# Bootstrap the CDKTF backend (S3 + DynamoDB)
node scripts/cdk.mjs bootstrap --auto-approve
```

**Commands:**
- `status` - Show current state of outputs and artifacts
- `deploy <stack|group>` - Deploy stacks with dependency handling
- `outputs <stack|group>` - Pull outputs for deployed stacks
- `build` - Build all apps and copy assets
- `prepare` - Full preparation: build + copy + pull outputs
- `synth` - Synthesize Terraform configuration
- `list` - List available stacks
- `destroy <stack|group>` - Destroy stacks
- `bootstrap` - Bootstrap the CDKTF backend

**Groups:** `infra`, `lambdas`, `website`, `all`

**Flags:**
- `--prod` - Target production environment
- `--auto-approve` - Skip interactive prompts (required for CI/agents)
- `--dry-run` - Preview without executing
- `--force` - Force deployment even if validation fails

## Command sequences (via `scripts/sequences.config.json`)

- List available sequences: `npm run sequence -- list`
- Run a sequence: `npm run sequence -- run <name> [--dry-run]`
- Current names: `build-deploy-api-lambda`, `deploy-infra`, `deploy-lambdas`, `full-deploy`, `clean-and-deploy`, `refresh-outputs`

### Build and deploy lambda (node-server) — `build-deploy-api-lambda`

```
npm -w node-server run decrypt-envs
node scripts/cdk.mjs deploy myapp-api-lambda-stack --auto-approve
npm -w node-server run encrypt-envs
```

### Deploy infrastructure — `deploy-infra`

```
node scripts/cdk.mjs deploy infra --auto-approve
```

### Full deploy — `full-deploy`

```
node scripts/cdk.mjs prepare
node scripts/cdk.mjs deploy all --auto-approve
```

### Clean and deploy — `clean-and-deploy`

```
npm run clean
npm i
node scripts/cdk.mjs prepare
node scripts/cdk.mjs deploy all --auto-approve
npm run test
```

## Aspect ejection

- Preview backend-only tear‑out: `npm run eject:backend-only -- --dry-run`
- Apply backend-only tear‑out: `npm run eject:backend-only`
- Preview analytics tear‑out: `npm run eject:analytics -- --dry-run`
- Apply analytics tear‑out: `npm run eject:analytics`
- Preview users tear‑out: `npm run eject:users -- --dry-run`
- Apply users tear‑out: `npm run eject:users`

## Scaffold a repository service workflow skeleton

```
node scripts/create-repository-service.mjs <entity-slug>
# Optional flags:
#   --with handler           Include optional scaffolding bundles (comma separated or "all")
#   --dry-run  Preview generated files without writing
#   --force    Overwrite existing files created in a previous run
```

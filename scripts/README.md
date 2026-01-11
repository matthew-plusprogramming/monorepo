# Automation Scripts

This repository ships a small collection of automation helpers that keep long-lived workflows consistent. Each script lives alongside its templates under `scripts/` and is safe to run from the repository root.

## Command Sequence Runner

Run named command chains defined in `scripts/sequences.config.json` without copying from docs.

```
node scripts/run-sequence.mjs list
node scripts/run-sequence.mjs run <name> [--dry-run]
npm run sequence -- list
npm run sequence -- run <name> [--dry-run]
```

- Config shape: `{ sequences: [{ name, description, steps[] }] }`; steps run from the repo root and stop on the first failure.
- Current names: `build-deploy-node-server`, `outputs-after-clean`, `full-clean-and-test` (mirrors scripts.md).
- Add/edit sequences by updating `scripts/sequences.config.json`; keep names kebab-case and steps ordered as they should execute. Use `--dry-run` to verify new sequences without running commands.

## Repository Service Scaffolder

```
node scripts/create-repository-service.mjs <entity-slug> [--with handler] [--dry-run] [--force]
```

### What it does

- Generates starter files for the Repository Service workflow: Zod schemas, CDK table stubs, an Effect repository service, and a matching fake for tests.
- Writes a tailored follow-up checklist to `scripts/output/repository-service/<entity-slug>-checklist.md` so you can track the remaining TODOs from the workflow.
- Supports optional bundles so you can stack extra scaffolding (e.g., HTTP handlers) on top of the base templates.

### Required arguments

- `<entity-slug>` — Kebab-case identifier for the domain entity (for example, `group-chat` or `time-entry`). The script derives camelCase/PascalCase/CONSTANT_CASE variants automatically.

### Flags

- `--with bundleA,bundleB` — Include optional bundles. Use `handler` today, or `all` to pull every available bundle. If omitted and you run the command in an interactive terminal, the script prompts you to select bundles.
- `--dry-run` — Preview which files would be written without creating them. Helpful for checking paths/bundles before committing.
- `--force` — Overwrite files that already exist. Use with care; the script refuses to clobber files unless this flag is present.

### Available bundles

- `base` (always on) — Schemas, constants, CDK table stub, repository service, and test fake.
- `handler` — Express handler skeleton plus a Vitest stub wired to the generated repository fake.

### Typical workflow

1. Run `node scripts/create-repository-service.mjs time-entry --with handler`.
2. Open the generated checklist under `scripts/output/repository-service/time-entry-checklist.md`.
3. Work through the TODOs, tailoring schemas, CDK resources, service logic, and tests to match the domain.
4. Update `apps/node-server/src/layers/app.layer.ts`, register the handler, and complete any checklist follow-ups before moving to the verify phase of the workflow.

### Customising templates

- Bundle templates live under `scripts/templates/repository-service/bundles/<bundle-name>/`.
- Keep placeholders (e.g., `__ENTITY_PASCAL__`) intact; the CLI replaces them automatically.
- If you add a new bundle, declare it in `scripts/templates/repository-service/manifest.json` so the CLI can discover it.
- CLI behaviour (flags, hook order, token resolvers) is driven by `scripts/scaffolds/repository-service.config.json`; reusable utilities live under `scripts/utils/**`.

### Rerunning safely

- Running the same command twice without `--force` leaves existing files untouched, which is useful when you only want the checklist regenerated.
- Use `--force` sparingly to refresh a template; remember to diff the changes afterwards to avoid losing manual edits.

---

## Node Server Handler Scaffolder

```
node scripts/create-node-server-handler.mjs <handler-slug> [options]
```

### What it does

- Creates a handler under `apps/node-server/src/handlers/<name>.handler.ts` and a matching Vitest suite under `apps/node-server/src/__tests__/handlers`.
- Registers the handler automatically in `apps/node-server/src/index.ts` (import + `app.<method>(route, handler)` call).
- Powers the Repository Service workflow's optional handler bundle so we only maintain handler boilerplate in one place.

### Required arguments

- `<handler-slug>` — Kebab-case identifier for the handler (for example, `get-user` => `getUser.handler.ts`).

### Flags

- `--route <path>` — Route to register. Defaults to `/<handler-slug>`.
- `--method <verb>` — HTTP method (`get`, `post`, `put`, `patch`, `delete`). Default: `get`.
- `--middlewares <list>` — Comma-separated middleware identifiers inserted before the handler.
- `--template <name>` — Template to render (`basic` or `repo-get-by-id` today).
- `--entity <slug>` — Entity slug required by templates that need repository/schema context.
- `--dry-run` — Preview without writing files or touching `index.ts`.
- `--force` — Overwrite existing handler/test files (refused otherwise).

### Template catalog

- `basic` — Minimal Effect handler with a placeholder payload.
- `repo-get-by-id` — Repository-backed GET handler wired to `<Entity>Repo.getById`; mirrors the previous repository-service bundle template.

The repository service scaffolder calls this CLI whenever the `handler` bundle is selected, passing along `--dry-run` and `--force` so the handler/test/index wiring stays in sync with schema/service scaffolding.

---

Have an idea for a new automation bundle? Add templates under `scripts/templates/repository-service/bundles/<bundle>` and register the bundle in the manifest—then document it in this file so other contributors can discover it.

## CDK Deploy Orchestrator

```
node scripts/deploy-orchestrator.mjs <command> [options]
npm run deploy -- <command> [options]
```

### What it does

- Smart orchestration for the CDKTF build/deploy flow that detects current state and determines minimum steps needed.
- Handles stack dependencies automatically and validates prerequisites before deployment.
- Supports deploying individual stacks, groups of stacks, or all stacks in the correct order.

### Commands

- `status` — Show current state of outputs and artifacts.
- `validate <stack|group>` — Check if prerequisites are met for deployment.
- `plan <stack|group>` — Show what steps would be executed.
- `deploy <stack|group>` — Deploy with automatic prerequisite handling.
- `outputs <stack|group>` — Pull outputs for deployed stacks.
- `build` — Build all apps with no cache.
- `prepare` — Full preparation: build, copy assets, pull outputs.

### Stack groups

- `infra` — Infrastructure stacks (api-stack, analytics-stack).
- `lambdas` — Lambda stacks (api-lambda-stack, analytics-lambda-stack).
- `website` — Client website stack.
- `all` — All stacks in correct dependency order.

### Flags

- `--prod` — Target production environment.
- `--dry-run` — Show what would be done without executing.
- `--force` — Force rebuild even if artifacts exist.
- `--no-cache` — Disable Turborepo cache for builds.
- `--auto-approve` — Skip interactive approval prompts (see below).

### Examples

```bash
# Deploy all stacks to dev
npm run deploy -- deploy all

# Deploy lambdas to production without prompts
npm run deploy -- deploy lambdas --prod --auto-approve

# Check what would be deployed
npm run deploy -- plan all --dry-run
```

---

## CDKTF State Manager

```
node scripts/manage-cdktf-state.mjs <command> [options]
```

### What it does

- Automates the sanctioned bootstrap sequence for the CDKTF backend: toggles the bootstrap stack flag, deploys the bootstrap stack, restores the flag, synthesizes stacks, runs the state migration helper, and deletes the local Terraform state file.

### Commands

- `bootstrap-backend` — Deploy the bootstrap stack and migrate Terraform state.
- `copy-assets-for-cdk` — Run the asset copy script for platform CDK stacks.
- `cdk list` — List available stacks with descriptions.
- `cdk deploy <stack> [--prod]` — Deploy the specified stack.
- `cdk output <stack> [--prod]` — Write CDK outputs for the specified stack.

### Flags

- `--prod` — Target production environment (for `cdk deploy` and `cdk output`).
- `--auto-approve` — Skip interactive approval prompts (see below).

### Usage notes

- Run from the repository root with credentials configured for the target environment.
- The script derives the stack name from `cdk/platform-cdk/src/constants.ts`, removes `cdk/platform-cdk/terraform.<stack>.tfstate` (plus the legacy `.terraform/terraform.tfstate` copy), and restores `migrateStateToBootstrappedBackend` to its original value even if a command fails.
- Command output streams directly to your terminal; rerun once issues are resolved.
- Omitting `<stack>` in an interactive terminal opens a picker so you can select and confirm one or more stacks; the script runs each deploy/output sequentially with the same flags. Append `--` before any extra CDK arguments (for example, `-- --context stage=dev`) to forward them to every selected stack.

### Examples

```bash
# Bootstrap the backend interactively
node scripts/manage-cdktf-state.mjs bootstrap-backend

# Bootstrap without prompts (for CI)
node scripts/manage-cdktf-state.mjs bootstrap-backend --auto-approve
```

---

## Auto-Approve Flag

The `--auto-approve` flag is available on both CDK deployment scripts to skip interactive confirmation prompts. This is essential for non-interactive environments where stdin is not a TTY.

### When to use --auto-approve

| Environment | Use --auto-approve? | Reason |
|-------------|---------------------|--------|
| CI/CD pipelines (GitHub Actions, etc.) | Yes | No TTY available for prompts |
| Automated scripts | Yes | Cannot respond to interactive prompts |
| Claude Code / AI agents | Yes | Non-interactive execution environment |
| Local development (interactive) | No | Review prompts catch mistakes |
| Production deployments (manual) | No | Human verification is a safety check |

### Behavior

When `--auto-approve` is passed:

- **deploy-orchestrator.mjs**: Skips the "Would you like to run preparation steps first?" prompt when validation fails. The script exits with an error instead of offering interactive recovery. The flag is also forwarded to the underlying CDKTF deploy command.
- **manage-cdktf-state.mjs**: The `bootstrap-backend` command passes `--auto-approve` to the CDKTF deploy step, allowing unattended bootstrap operations.

### Usage examples

```bash
# Deploy all stacks without prompts (CI/CD)
npm run deploy -- deploy all --auto-approve

# Deploy to production without prompts
npm run deploy -- deploy all --prod --auto-approve

# Bootstrap backend in CI environment
node scripts/manage-cdktf-state.mjs bootstrap-backend --auto-approve

# Combine with other flags
npm run deploy -- deploy lambdas --prod --auto-approve --force
```

### Safety considerations

- Always use `--dry-run` first in new environments to preview changes.
- In CI pipelines, ensure proper branch protections and approval gates before deployment steps.
- The `--auto-approve` flag does not bypass validation checks—it only skips interactive prompts. If prerequisites are missing, the script still fails.

---

## Convert Functions to Arrow Expressions

```
tsx scripts/convert-to-arrows.ts
```

### What it does

- Scans TypeScript/TSX files and rewrites eligible function declarations/expressions into arrow functions.
- Skips functions that rely on `this`, `super`, `arguments`, `new.target`, overloads, or hoisted references to avoid semantic changes.

### Usage notes

- Runs against the repo by default (honors `.gitignore` and skips `dist/`, `.next/`, etc.).
- Save your work before running; the codemode writes changes in place and reports how many functions were converted.

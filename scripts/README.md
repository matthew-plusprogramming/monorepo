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
- Current names: `build-deploy-api-lambda`, `deploy-infra`, `deploy-lambdas`, `full-deploy`, `clean-and-deploy`, `refresh-outputs` (mirrors scripts.md).
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

## CDK Orchestrator

```
node scripts/cdk.mjs <command> [options]
npm run cdk -- <command> [options]
```

### What it does

- Unified orchestration for all CDKTF operations: deploy, outputs, build, synth, list, destroy, bootstrap.
- Loads environment variables from `.env.{dev|prod}` using dotenvx programmatically.
- Runs cdktf commands directly with proper argument handling.
- Handles stack dependencies automatically and validates prerequisites before deployment.

### Commands

- `status` — Show current state of outputs and artifacts.
- `validate <stack|group>` — Check if prerequisites are met for deployment.
- `deploy <stack|group>` — Deploy with automatic prerequisite handling.
- `outputs <stack|group>` — Pull outputs for deployed stacks.
- `build` — Build all apps and copy assets.
- `prepare` — Full preparation: build, copy assets, pull outputs.
- `synth` — Synthesize Terraform configuration.
- `list` — List available stacks.
- `destroy <stack|group>` — Destroy stacks.
- `bootstrap` — Bootstrap the CDKTF backend (S3 + DynamoDB).

### Stack groups

- `infra` — Infrastructure stacks (api-stack, analytics-stack).
- `lambdas` — Lambda stacks (api-lambda-stack, analytics-lambda-stack).
- `website` — Client website stack.
- `all` — All stacks in correct dependency order.

### Flags

- `--prod` — Target production environment.
- `--dry-run` — Show what would be done without executing.
- `--force` — Force deployment even if validation fails.
- `--auto-approve` — Skip interactive approval prompts (required for CI/agents).

### Examples

```bash
# Check current state
node scripts/cdk.mjs status

# Deploy infrastructure stacks to dev
node scripts/cdk.mjs deploy infra --auto-approve

# Deploy all stacks to production
node scripts/cdk.mjs deploy all --prod --auto-approve

# Pull outputs from deployed stacks
node scripts/cdk.mjs outputs infra

# Full preparation: build + copy assets + pull outputs
node scripts/cdk.mjs prepare

# Bootstrap the CDKTF backend
node scripts/cdk.mjs bootstrap --auto-approve
```

### Auto-approve flag

The `--auto-approve` flag skips interactive confirmation prompts. This is essential for non-interactive environments.

| Environment | Use --auto-approve? | Reason |
|-------------|---------------------|--------|
| CI/CD pipelines | Yes | No TTY available for prompts |
| Automated scripts | Yes | Cannot respond to interactive prompts |
| Claude Code / AI agents | Yes | Non-interactive execution environment |
| Local development | Optional | Review prompts catch mistakes |
| Production deployments | Recommended with `--dry-run` first | Preview before committing |

### Safety considerations

- Always use `--dry-run` first in new environments to preview changes.
- In CI pipelines, ensure proper branch protections and approval gates before deployment steps.
- The `--auto-approve` flag does not bypass validation checks—it only skips interactive prompts.

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

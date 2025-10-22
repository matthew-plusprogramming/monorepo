# Automation Scripts

This repository ships a small collection of automation helpers that keep long-lived workflows consistent. Each script lives alongside its templates under `scripts/` and is safe to run from the repository root.

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

### Rerunning safely

- Running the same command twice without `--force` leaves existing files untouched, which is useful when you only want the checklist regenerated.
- Use `--force` sparingly to refresh a template; remember to diff the changes afterwards to avoid losing manual edits.

---

Have an idea for a new automation bundle? Add templates under `scripts/templates/repository-service/bundles/<bundle>` and register the bundle in the manifest—then document it in this file so other contributors can discover it.

## CDKTF State Manager

```
node scripts/manage-cdktf-state.mjs bootstrap-backend
```

### What it does

- Automates the sanctioned bootstrap sequence for the CDKTF backend: toggles the bootstrap stack flag, deploys the bootstrap stack, restores the flag, synthesizes stacks, runs the state migration helper, and deletes the local Terraform state file.

### Usage notes

- Run from the repository root with credentials configured for the target environment.
- The script derives the stack name from `cdk/backend-server-cdk/src/constants.ts`, removes `cdk/backend-server-cdk/terraform.<stack>.tfstate` (plus the legacy `.terraform/terraform.tfstate` copy), and restores `migrateStateToBootstrappedBackend` to its original value even if a command fails.
- Command output streams directly to your terminal; rerun once issues are resolved.

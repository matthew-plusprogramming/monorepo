---
title: Manifest Validation And Migration
last_reviewed: 2026-04-26
---

# Manifest Validation And Migration

Current reference for spec-group manifests at
`.claude/specs/groups/<sg-id>/manifest.json`, the strict validator, and the
legacy migration utility.

`validate-manifest.mjs` is the authoritative blocker. `migrate-manifest.mjs`
exists to repair legacy-flat manifests; it is not part of normal authoring.
`manifest-post-edit-hook.mjs` remains an advisory wrapper and is not wired as a
live PostToolUse hook.

## Quick Reference

| Task | Command |
| --- | --- |
| Validate one manifest | `node .claude/scripts/validate-manifest.mjs <path>` |
| Validate all active spec-group manifests | `find .claude/specs/groups -name manifest.json -exec node .claude/scripts/validate-manifest.mjs {} \;` |
| Dry-run legacy manifest migration | `node .claude/scripts/migrate-manifest.mjs --all --dry-run` |
| Migrate all legacy manifests | `node .claude/scripts/migrate-manifest.mjs --all` |
| Migrate specific manifests | `node .claude/scripts/migrate-manifest.mjs <path1> [path2 ...]` |
| Review migration conflicts | `cat .claude/coordination/migration-conflicts.json` |
| Clear shape-lint async sentinel | `node .claude/scripts/session-checkpoint.mjs clear-async-mode` |

## Canonical Manifest Shape

Manifests must conform to the schema at
`.claude/specs/schema/spec-group.schema.json`.

```json
{
  "id": "sg-example",
  "title": "Example Spec Group",
  "prd": {
    "source": "local-file",
    "file_path": ".claude/prds/example/prd.md",
    "version": "1.0",
    "content_hash": "a1b2c3d4"
  },
  "review_state": "DRAFT",
  "work_state": "NOT_STARTED",
  "created_at": "2026-04-18T00:00:00Z",
  "updated_at": "2026-04-18T00:00:00Z",
  "updated_by": "agent",
  "requirements": { "source": "prd" },
  "convergence": { "spec_complete": false },
  "decision_log": []
}
```

Required top-level fields:

| Field | Notes |
| --- | --- |
| `id` | Must match the directory basename. |
| `title` | Human-readable name. |
| `prd` | Object or `null` for bootstrap / infra specs with no linked PRD. |
| `review_state` | `DRAFT`, `APPROVED`, or `SUPERSEDED`. |
| `work_state` | `NOT_STARTED`, `IMPLEMENTING`, `VERIFYING`, or `READY_TO_MERGE`. |
| `created_at`, `updated_at` | ISO 8601 strings. |
| `updated_by` | `agent` or `human`. |

`prd.file_path` is validated by `lib/path-validate.mjs`: repo-relative POSIX
path, no `..`, no absolute paths, no symlinks. Missing files are allowed for
transitional or bootstrap states. `prd.content_hash`, when present, must be an
8-character lowercase hex string.

## Rejected Legacy Fields

The strict validator rejects legacy-flat fields and names the canonical nested
equivalent:

| Legacy field | Canonical field |
| --- | --- |
| `prd_id` | `prd.id` |
| `prd_path` | `prd.file_path` |
| `prd_version` | `prd.version` |
| `prd_content_hash` | `prd.content_hash` |
| `spec_group_id` | Duplicate of `id`; remove it. |

Run `migrate-manifest.mjs` when these appear.

## Migration Utility

Use migration only to repair old manifests or consumer repos that still carry
legacy-flat shape.

```bash
node .claude/scripts/migrate-manifest.mjs --all --dry-run
node .claude/scripts/migrate-manifest.mjs --all
```

Rules applied by the utility:

- Move legacy `prd_*` fields into `prd.*`.
- Remove `spec_group_id`.
- Remove non-canonical `convergence.*_clean_pass_count` fields; clean-pass
  state belongs in `session.json`.
- Backfill missing `updated_by` with `agent`.
- Rewrite `updated_by: "user"` to `updated_by: "human"`.
- Preserve unrelated fields.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Conflict report written to `.claude/coordination/migration-conflicts.json`. |
| `2` | Invocation, disk, permission, or malformed-input error. |
| `3` | Conflict plus conflict-report write failure. |

`--all` scans active spec groups only. Archive manifests under
`.claude/specs/archive/**` are excluded.

## Validator And Wrapper

`validate-manifest.mjs <path>` runs the strict schema with:

- `additionalProperties: false` at the top level.
- Required `prd` and `updated_by`.
- Enum enforcement for review/work state and `updated_by`.
- 8-hex validation for `prd.content_hash` when present.

Exit codes: `0` valid, `1` validation failure.

`manifest-post-edit-hook.mjs` is advisory and no longer on the live hook path.
If invoked manually, it:

- skips archive paths,
- honors `.claude/coordination/shape-lint-disabled` or
  `DISABLE_SHAPE_LINT=1`,
- runs `validate-manifest.mjs`,
- optionally runs `shape-lint-hook.mjs`, and
- emits `manifest-shape-lint: PASS|FAIL|SKIP|STRUCTURAL_ERROR`.

The wrapper always exits `0`; the validator is the blocker. Wrapper kill
switches do not affect the validator CLI.

## Troubleshooting

### CI Or Sync Blocks On Manifest Shape

Read the validator error, run:

```bash
node .claude/scripts/migrate-manifest.mjs --all
```

Review the diff and commit the canonical shape.

### Migration Reports Conflicts

Open `.claude/coordination/migration-conflicts.json`. Resolve each manifest by
keeping the intended nested value, removing the legacy-flat field, and rerunning
the migration.

### Advisory Wrapper Is Bypassed

Check both bypass inputs:

```bash
ls -la .claude/coordination/shape-lint-disabled 2>/dev/null
echo "DISABLE_SHAPE_LINT=${DISABLE_SHAPE_LINT:-unset}"
```

If either is present, the wrapper short-circuits. The validator CLI still runs
normally.

### Async Sentinel Is Present

The wrapper wrote `.claude/coordination/shape-lint-async-mode` after sustained
slow validation. Investigate disk/corpus slowness, then clear it:

```bash
node .claude/scripts/session-checkpoint.mjs clear-async-mode
```

## See Also

- [HOOKS.md § manifest-post-edit-hook.mjs](./HOOKS.md#manifest-post-edit-hookmjs)
- [HOOKS.md § shape-lint-hook.mjs](./HOOKS.md#shape-lint-hookmjs)
- [HOOKS.md § migrate-manifest.mjs](./HOOKS.md#migrate-manifestmjs)
- [HOOKS.md § validate-manifest.mjs](./HOOKS.md#validate-manifestmjs)
- [ENFORCEMENT-FLOW.md](./ENFORCEMENT-FLOW.md)
- [WORKFLOW-ENFORCEMENT.md](./WORKFLOW-ENFORCEMENT.md)

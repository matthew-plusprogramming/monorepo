---
_source_modules: ['validation-scripts']
---

# Sync System

`metaclaude-assistant` is the canonical source for shared `.claude`
artifacts. Consumer repos receive those artifacts through a one-way sync driven
by the registry, project config, and lock files.

This is the operator guide. Internal validator design lives in
[SYNC-SYSTEM-INTERNALS.md](SYNC-SYSTEM-INTERNALS.md).

---

## Commands

Run from `metaclaude-assistant`:

```bash
node .claude/scripts/metaclaude-cli.mjs list
node .claude/scripts/metaclaude-cli.mjs status [project]
node .claude/scripts/metaclaude-cli.mjs sync [project]
node .claude/scripts/metaclaude-cli.mjs verify [project]
node .claude/scripts/metaclaude-cli.mjs add <name> [--path=<path>] [--bundle=<bundle>]
node .claude/scripts/metaclaude-cli.mjs remove <name>
```

Useful flags:

| Flag                  | Use                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `--force`             | Overwrite local modifications and force-delete locally modified obsolete artifacts.        |
| `--resolve-conflicts` | Accept upstream only for artifacts currently in conflict.                                  |
| `--ack-drift`         | For `never-overwrite` artifacts, advance the lock hash without touching the consumer file. |
| `--base-dir=<path>`   | Override the default sibling-repo base directory.                                          |

Run hash commands directly:

```bash
node .claude/scripts/compute-hashes.mjs --verify
node .claude/scripts/compute-hashes.mjs --update
```

`--update` recomputes registry hashes and runs the sync validation gates before
writing `.claude/metaclaude-registry.json`.

---

## Files

| File                                     | Role                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `.claude/metaclaude-registry.json`       | Canonical artifact metadata, hashes, bundles, and orphan records.      |
| `.claude/projects.json`                  | Consumer list, default bundle, and per-project overrides.              |
| `.claude/locks/<project>.lock.json`      | Last synced artifact versions and hashes for each consumer.            |
| `.claude/scripts/metaclaude-cli.mjs`     | Sync/status/verify/project-management CLI.                             |
| `.claude/scripts/compute-hashes.mjs`     | Registry hash updater and validation-gate entry point.                 |
| `.claude/scripts/lib/sync-constants.mjs` | Code-owned bundle ancestry, roots, whitelist, and skip-gate constants. |

Not everything in the registry is synced. `compute-hashes.mjs` is hash-tracked
with `_sync: false`; artifacts marked `_sync_policy: "never-sync"` are skipped;
test files and fixtures are validated as leaves rather than shipped.

---

## Registry Contract

Artifacts live at:

```text
artifacts.<category>.<name>
```

The sync artifact id is `category/name`, for example `agents/implementer`.
Current registry categories include `agents`, `config`, `core`, `docs`,
`infrastructure`, `memory-bank`, `prompts`, `schemas`, `scripts`, `skills`,
`structured-docs-templates`, and `templates`.

Each artifact entry needs:

| Field            | Required | Meaning                                                                           |
| ---------------- | -------- | --------------------------------------------------------------------------------- |
| `version`        | Yes      | Semver string.                                                                    |
| `hash`           | Yes      | First 8 chars of the SHA-256 hash of UTF-8 file content.                          |
| `path`           | Yes      | Source path relative to this repo.                                                |
| `description`    | Yes      | Human description.                                                                |
| `target_path`    | No       | Destination path in the consumer; defaults to `path`.                             |
| `dependencies`   | No       | Informational dependency list.                                                    |
| `merge_strategy` | No       | Special merge behavior. Current live values: `settings-merge`, `gitignore-merge`. |
| `_sync_policy`   | No       | Per-artifact sync policy: `agent-assisted`, `never-overwrite`, or `never-sync`.   |

`target_path` is load-bearing for root files. `core/claude-md-base` sources from
`.claude/templates/claude-md-base.md` and installs to `CLAUDE.md`.

---

## Bundles

Bundles decide which artifacts a consumer receives. Current bundles:

```text
minimal -> core-workflow -> full-workflow
```

`projects.json` defaults all consumers to `full-workflow`.

| Bundle          | Purpose                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `minimal`       | Core config, scripts, schemas, hooks, infrastructure, and base prompt.                                |
| `core-workflow` | Adds implement/test/unify/atomize/enforce agents, skills, templates, and docs.                        |
| `full-workflow` | Adds review, routing, docs, PRD, security, trace, structured-docs, and specialist workflow artifacts. |

Child bundles inherit parent artifacts. Put each artifact in the lowest bundle
that needs it. A registered artifact that is not in a bundle, project
`additional`, or another target set will not sync.

Per-project config:

```json
{
  "projects": {
    "my-project": {
      "bundle": "core-workflow",
      "additional": ["agents/explore"],
      "excluded": ["scripts/workspace-eslint"],
      "protected": [".claude/settings.json"],
      "sync_overrides": {
        "docs/traces": "agent-assisted"
      }
    }
  }
}
```

| Key              | Effect                                                 |
| ---------------- | ------------------------------------------------------ |
| `additional`     | Adds artifacts outside the bundle.                     |
| `excluded`       | Removes artifacts from the resolved target set.        |
| `protected`      | Prevents overwrite and automatic deletion.             |
| `sync_overrides` | Per-project policy override, usually `agent-assisted`. |

Cross-bundle closure is enforced: a script in bundle `X` may import only files
from `X` or an ancestor bundle. A `minimal` script cannot import a
`full-workflow` helper.

---

## Sync Behavior

For each target artifact, sync compares:

1. The registry hash.
2. The source file hash.
3. The consumer file hash.
4. The recorded lock hash.

Default behavior:

| State                                                | Result                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| Missing consumer file                                | Copy source and record lock.                                |
| Registry hash changed, local file still matches lock | Copy source and update lock.                                |
| Local file differs from lock                         | Conflict unless `--force` or `--resolve-conflicts` is used. |
| Artifact is protected                                | Skip overwrite and deletion.                                |
| Source path fails containment                        | Skip artifact and report conflict/warning.                  |

Special policies:

| Policy            | Behavior                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `settings-merge`  | Replaces metaclaude-owned hooks in settings and preserves project-owned hooks.                                                |
| `gitignore-merge` | Maintains the metaclaude-managed `.gitignore` block without replacing local content.                                          |
| `never-overwrite` | Copies only when absent; later local content is preserved. If upstream hash changes, sync warns about shadow-file divergence. |
| `never-sync`      | Registry hash is tracked, but the artifact is never copied to consumers.                                                      |
| `agent-assisted`  | Stages upstream into `.claude/sync-pending/<target_path>` for manual merge and records the seen upstream hash.                |

After resolving an agent-assisted merge, delete `.claude/sync-pending/` in the
consumer and commit the merged target file.

---

## Deletions

Deletion propagation is lock-driven.

When a lock contains an installed artifact that is no longer in the resolved
target set, `status` reports:

```text
no longer targeted (deletion pending)
```

The next `sync` deletes the consumer file and prunes the lock entry only when
the local file hash still matches the lock hash. If the consumer file was
modified, sync reports a deletion conflict and leaves the file in place unless
`--force` is used.

Deletion cases:

| Case                                                    | Result                                       |
| ------------------------------------------------------- | -------------------------------------------- |
| Locked artifact removed from bundle/registry target set | `sync` deletes if local hash matches lock.   |
| Consumer file already absent                            | `sync` prunes the obsolete lock entry.       |
| Locked artifact locally modified                        | Conflict; `--force` deletes and prunes.      |
| Protected artifact                                      | Deletion skipped.                            |
| Artifact has no target path in lock                     | Lock entry pruned; no file delete attempted. |

Manually copied files that were never locked are not deletion candidates. Do not
use `clean` for normal upstream deletions; the supported propagation path is
`status` followed by `sync`.

---

## Adding Or Updating Artifacts

Add a syncable artifact:

1. Create the file under a sync-scoped root.
2. Add a registry entry with `"hash": "placeholder"`.
3. Add `category/name` to the lowest correct bundle, or to a project
   `additional` list for a project-only artifact.
4. Run `node .claude/scripts/compute-hashes.mjs --update`.
5. Run a targeted `sync <project>`.
6. Diff the consumer copy against the source or verify the resulting hash.

Update an existing artifact:

1. Edit the source file.
2. Run `compute-hashes --update`.
3. Run focused tests for the artifact class.
4. Run `metaclaude-cli sync [project]`.
5. Normalize generated lock timestamp churn before committing source, unless the
   lock hash change is the intended source diff.

Remove a synced artifact:

1. Remove it from bundle `includes`, project `additional`, or the registry target
   set.
2. Run `compute-hashes --update`.
3. Run `status` and confirm deletion-pending output.
4. Run `sync`.
5. Confirm consumer file deletion and lock pruning.

Do not rely on registry-only presence. Registry entry plus bundle membership is
what makes an artifact targetable.

---

## Validation Gates

`compute-hashes --update` blocks registry writes when validation finds drift.
`metaclaude-cli sync` runs the same drift checks in warning mode so consumers are
not stranded by an upstream authoring mistake.

Author-side gates:

| Gate                   | Blocks                                                                          |
| ---------------------- | ------------------------------------------------------------------------------- |
| Orphan detector        | Sync-scoped files that are neither registered, whitelisted, nor in `orphans[]`. |
| Import-graph validator | Registered `.mjs` files importing missing or unregistered relative modules.     |
| Cross-bundle closure   | Imports from descendant or sibling bundle tiers.                                |

Sync-scoped roots:

```text
.claude/scripts/     .claude/agents/     .claude/skills/
.claude/templates/   .claude/docs/       .claude/memory-bank/
.claude/hooks/       .claude/specs/schema/
```

Excluded roots:

```text
.claude/traces/      .claude/locks/       .claude/coordination/
.claude/journal/     .claude/specs/groups/ .claude/specs/archive/
.claude/prds/        .claude/context/     .claude/audit/
.claude/scripts/archive/
```

Global whitelist:

```text
**/__tests__/**      **/__fixtures__/**   **/.gitkeep
```

Whitelisted test and fixture files are leaves. Registered runtime code may not
import from them.

Structured findings use JSON lines with `file`, `bundle`, `importer`,
`missingImport`, `rule`, and `remediation`. Rule examples include `orphan`,
`import-unregistered`, `cross-bundle-closure`, `parse-error`,
`import-target-missing`, `import-target-unresolvable`, `path-escape`, and
`test-leaf-violation`.

Use `--skip-gates="<reason>"` only for an intentional short-lived bypass. The
reason must be substantive, no environment bypass exists, and each use appends
to `.claude/audit/skip-gates.jsonl`. That audit file is append-only; the
pre-commit hook rejects mutation of existing lines.

---

## Hashes And Locks

Artifact hashes are:

```javascript
createHash('sha256').update(content).digest('hex').slice(0, 8);
```

Lock entries record `version`, `hash`, `path`, and `installed_at`. The sync CLI
uses the lock to distinguish upstream updates from local modifications and to
know which obsolete consumer files are safe to delete.

`verify [project]` checks locked artifacts against consumer files. Merge-managed
files are treated as merge-managed rather than exact source hash matches.

---

## Safety Model

All artifact source and target paths are resolved through realpath containment
under the expected `.claude` root. The separator in the containment prefix is
required: `/repo/.claude-evil` must not satisfy a `/repo/.claude` prefix check.

`metaclaude-cli sync` re-checks containment immediately before reading each
source artifact. This reduces the time-of-check/time-of-use window; it does not
try to defeat a concurrent hostile filesystem writer.

`.husky/pre-commit` runs:

1. `validate-orphans.mjs`
2. `skip-gates-append-only-check.mjs`
3. sync validation through `compute-hashes`

The hook can be bypassed with `git commit --no-verify`. That is accepted under
the current sole-developer trust model; do not treat it as a multi-developer
security boundary.

---

## Common Failures

| Symptom                                   | Cause                                                                 | Fix                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Artifact never appears in consumers       | Missing bundle membership                                             | Add `category/name` to the lowest correct bundle.                                            |
| `ERR_MODULE_NOT_FOUND` in a consumer      | Imported helper was not registered or not in the same/ancestor bundle | Register helper and place it in the right bundle tier.                                       |
| Local edits overwritten                   | Used `--force` or file lacked protection/policy                       | Restore from git; add `protected`, `never-overwrite`, or `agent-assisted` where appropriate. |
| `compute-hashes --verify` mismatch        | Artifact changed without hash refresh                                 | Run `compute-hashes --update`.                                                               |
| `settings.json` hooks duplicate/disappear | Hook ownership marker wrong                                           | Only sync-owned hooks use `"_source": "metaclaude"`.                                         |
| Deleted source file remains in consumer   | File is locally modified, protected, or never locked                  | Check `status`; resolve conflict, use `--force`, or delete manual local copy intentionally.  |
| `never-overwrite` warning repeats         | Consumer has intentionally diverged from upstream                     | Review local file, then use `sync --ack-drift` if divergence is accepted.                    |

---

## Notable Artifacts

Most artifacts are routine and need no specific note. The artifacts listed here
have operator-visible behavior worth calling out separately.

### `config/mcp` (Playwright MCP server config)

Propagates the project-scoped MCP server configuration to consumer projects so
Claude Code sessions there can use the Playwright MCP for browser automation.

| Field              | Value                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| Source             | `.claude/templates/mcp.json`                                             |
| Target             | `.mcp.json` (consumer repo root)                                         |
| Sync policy        | `never-overwrite`                                                        |
| Bundle             | `minimal` (inherits to `core-workflow` and `full-workflow`)              |
| Underlying package | `@playwright/mcp@0.0.70` (pinned, fetched via `npx -y` at session start) |

The hub keeps two byte-identical copies: `.mcp.json` at repo root (used by the
hub's own Claude Code sessions) and `.claude/templates/mcp.json` (the sync
source, located under `.claude/` so it satisfies the cli's TOCTOU containment
guard). Byte equality between the two files is enforced by an invariant test
at `.claude/scripts/__tests__/mcp-registry-sync.test.mjs`. When updating the
Playwright pin, update both files in lockstep, run `compute-hashes --update`,
and let sync propagate.

#### First-rollout behavior

On the first sync after `config/mcp` is registered, two distinct outcomes are
expected per consumer, depending on whether the consumer already has an
`.mcp.json` at its repo root:

| Consumer state              | First-sync outcome                                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No pre-existing `.mcp.json` | Receives a byte-identical copy from the hub source. Lock records the install.                                                                                                                        |
| Pre-existing `.mcp.json`    | File is preserved unchanged. Stderr contains one `Skip config/mcp: never-overwrite` line and, if the local content's hash differs from the registry hash, one `shadow-file divergence` WARNING line. |

Both outcomes are designed `never-overwrite` behavior, not defects. See `metaclaude-cli.mjs` lines 756-787 for the enforcement source.

#### Opting out

Consumers that do not want Playwright MCP have two options:

1. **Pre-create** `.mcp.json` at the consumer repo root before first sync. The
   `never-overwrite` policy preserves it.
2. **Mark protected**: add `protected: ['.mcp.json']` for that project in
   `.claude/projects.json`. Sync skips overwrite and deletion for protected
   targets unconditionally.

#### Supply-chain note

`@playwright/mcp@0.0.70` is fetched at session startup from the public npm
registry. The version pin is exact and is verified by the SEC-001 test in
`.claude/scripts/__tests__/mcp-json-shape.test.mjs`. Bumping the pin is a
hub-side edit followed by a sync; existing consumers with locally customized
`.mcp.json` files retain their version under the `never-overwrite` policy.

---

## See Also

- [SYNC-SYSTEM-INTERNALS.md](SYNC-SYSTEM-INTERNALS.md) - validation pipeline and extension points
- [HOOKS.md](HOOKS.md) - live hook inventory
- [STRUCTURED-DOCS.md](STRUCTURED-DOCS.md) - structured docs artifact rules
- `.claude/metaclaude-registry.json` - artifact and bundle registry
- `.claude/projects.json` - consumer project configuration
- `.claude/audit/legacy-orphans-backlog.md` - resolved historical orphan inventory

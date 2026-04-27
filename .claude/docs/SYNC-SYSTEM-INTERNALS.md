# Sync System Internals

Developer reference for the sync validation pipeline. This document describes the internal architecture of the gates that protect `.claude/metaclaude-registry.json` from drift. For the operational guide (how to use the sync system), see `.claude/docs/SYNC-SYSTEM.md`.

---

## Validator Pipeline Architecture

The sync validation pipeline runs inside `compute-hashes --update` before the registry is written to disk. Three gates run in sequence against a single in-memory registry object. All findings are collected; the registry is written only if the gate set is empty (or `--skip-gates` is set).

### Pipeline Stages

1. Parse CLI flags and validate `--skip-gates` reason.
2. Read `.claude/metaclaude-registry.json`.
3. Validate registry shape via `lib/registry-schema.mjs`; schema failure emits `provenance-invalid`.
4. Run orphan detector over sync-scoped roots.
5. Run import-graph validator and cross-bundle closure checks over registered `.mjs` files.
6. Aggregate findings.
7. If clean or skipped, write registry through temp file + atomic rename; otherwise emit JSONL findings and exit without registry write.

### Module Layout

| Module                                             | Purpose                                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `.claude/scripts/compute-hashes.mjs`               | Entry point; orchestrates pipeline, parses flags, writes registry, emits findings              |
| `.claude/scripts/lib/orphan-detector.mjs`          | Walks the sync-scoped root list, emits `orphan` findings for unregistered files                |
| `.claude/scripts/lib/import-graph-validator.mjs`   | Acorn AST parser, import specifier extractor, per-edge resolver + closure check                |
| `.claude/scripts/lib/path-containment.mjs`         | TOCTOU-safe `realpath + sep-suffixed startsWith` containment helper                            |
| `.claude/scripts/lib/registry-schema.mjs`          | Zod schemas: `artifactEntrySchema` (passthrough), `orphansEntrySchema`, `registrySchema`       |
| `.claude/scripts/lib/sync-constants.mjs`           | Code-constants: `BUNDLE_INHERITANCE`, `WHITELIST_GLOBS`, `SKIP_GATES_OVERUSE_THRESHOLD`, roots |
| `.claude/scripts/validate-orphans.mjs`             | Pre-commit hook wrapper that runs Zod validation against `orphans[]` only                      |
| `.claude/scripts/skip-gates-append-only-check.mjs` | Pre-commit hook wrapper that enforces append-only semantics on `skip-gates.jsonl`              |
| `.claude/scripts/rollout-resync.mjs`               | Opt-in → staged → default-on rollout driver, used at M4 to sync all 11 consumers               |
| `.claude/scripts/migrate-orphans-shape.mjs`        | One-shot migration from `string[]` orphans to object form; archived after M1                   |

---

## Trust Root: Code-Constants Over Registry Metadata

The validator's trust root is `lib/sync-constants.mjs`, not the registry itself. Every configurable value that affects security-sensitive decisions is a JavaScript `const` in source code, not a field in `metaclaude-registry.json`.

### Why This Matters

A compromised registry must not be able to silently relax its own enforcement. If `SKIP_GATES_OVERUSE_THRESHOLD` were read from the registry, an attacker with registry-write access could raise the threshold to hide abuse. If `BUNDLE_INHERITANCE` were derived from registry `bundles[].extends` links, a malicious `extends` chain could create false "allowed" edges.

### Trust-Root Constants

| Constant family | Why it is code-owned |
| --- | --- |
| `BUNDLE_INHERITANCE` | Enforces cross-bundle closure. `minimal: []` means minimal can import only minimal unless same-bundle short-circuit applies. |
| `WHITELIST_GLOBS` | Defines non-shipped leaves: `**/__tests__/**`, `**/__fixtures__/**`, `**/.gitkeep`. |
| `SKIP_GATES_*` | Controls skip-gates reason validation and overuse warnings outside registry control. |
| `SYNC_SCOPED_ROOTS` | Defines roots whose files must be registered or explicitly orphaned. |

Any change to these constants requires a source-code diff that is visible in code review. This is the difference between a security-relevant decision and a data-driven one.

---

## Zod Schema Extension Points

The registry schema lives at `lib/registry-schema.mjs`. It is the single source of truth for what a valid registry looks like, imported by `compute-hashes`, the pre-commit hook wrappers, and any future registry validator.

### Core Schemas

| Schema | Contract |
| --- | --- |
| `orphansEntrySchema` | Object-form orphan entries with `path`, substantive `reason`, `added_by`, and `added_date`. |
| `artifactEntrySchema` | Semver `version`, 8-hex `hash`, `path`, optional metadata, `_sync_policy`, `_sync`, and `.passthrough()` forward compatibility. |

### Adding a New Optional Artifact Field

`artifactEntrySchema` uses `.passthrough()` so any new optional field flows through unvalidated. This is the **default** for forward compatibility -- per REQ-028, schema evolution is additive-only.

If you want the field to be **validated**, extend the schema:

```javascript
export const artifactEntrySchema = z
  .object({
    // ... existing fields ...
    my_new_field: z.string().optional(), // added here
  })
  .passthrough();
```

If the new field carries security-relevant semantics (affects gate decisions), **do not add it to the registry**. Add it as a code constant to `sync-constants.mjs` instead.

### Legacy Sentinel Exception

`orphansEntrySchema` accepts `reason: "legacy"` as a valid value, bypassing the `.min(20)` requirement, so migrated registries and test fixtures remain parseable. The source registry has resolved its legacy entries; `.claude/audit/legacy-orphans-backlog.md` is the migration record.

---

## Import-Graph Validator Internals

### AST Walk Targets

The validator extracts relative import specifiers from these acorn node types:

| Node type                  | Example                       | Source of specifier              |
| -------------------------- | ----------------------------- | -------------------------------- |
| `ImportDeclaration`        | `import x from './y.mjs'`     | `node.source.value`              |
| `ExportNamedDeclaration`   | `export { x } from './y.mjs'` | `node.source.value` (if present) |
| `ExportAllDeclaration`     | `export * from './y.mjs'`     | `node.source.value`              |
| `CallExpression` (dynamic) | `await import('./y.mjs')`     | `node.arguments[0].value`        |

Dynamic imports with a non-literal argument (`await import(variableName)`, template-literal-with-expression) are **skipped with a warning**. They are not errors -- static analysis cannot resolve them, and failing loudly would block legitimate runtime-resolved plugin patterns.

Bare specifiers (`'node:fs'`, `'zod'`) are skipped silently. Only specifiers starting with `./` or `../` are checked.

### Resolution Precedence

For a relative specifier like `./helper`, the validator tries extensions in this order:

1. `./helper.mjs`
2. `./helper.js`
3. `./helper.json`

If the specifier already has an extension (`./helper.mjs`), precedence does not apply -- the literal path is used. If both `./helper.mjs` and `./helper.js` exist and the specifier is `./helper` (no extension), the `.mjs` wins.

### Per-Edge Check

For each resolved import target:

1. Call `realpath(target)`. On `ENOENT`, emit `import-target-missing` and continue.
2. Run `assertContainment(resolved, claudeRoot)`. On failure, emit `path-escape` and continue.
3. Check if `resolved` is in the set of paths that failed to parse earlier. If so, emit `import-target-unresolvable` and continue.
4. Check if `resolved` matches a whitelist glob. If so, this is a test-leaf violation (registered non-test importing test code) -- emit `test-leaf-violation` and continue.
5. Check if `resolved` is in the set of registered paths. If not, emit `import-unregistered` and continue.
6. Run the cross-bundle closure check. If the importee's bundle is not the importer's bundle or an ancestor, emit `cross-bundle-closure`.

### Cross-Bundle Closure Check

The rule is: same-bundle imports pass; imports from ancestor bundles pass; imports from descendant/sibling bundles fail with `cross-bundle-closure`. The `minimal: []` base case is critical: an empty ancestor list means "minimal can import only minimal", not "any bundle allowed".

### Parse Error Handling

If acorn throws a `SyntaxError` on a registered `.mjs`:

1. Emit `{rule: "parse-error", file, line, column}`.
2. Add the file's realpath to `parse_errored_files` set.
3. Continue parsing remaining files (a single parse error does not abort the phase).
4. At phase end, if `parse_errored_files` is non-empty, exit non-zero.
5. Any file that imports a parse-errored file gets a distinct `import-target-unresolvable` finding (so the reader can see "this import chain is broken because its target failed to parse").

### Performance Bound

Serial acorn parse is used; there is no worker pool or AST cache. If registry size makes validation slow, add a worker pool first, then an mtime-keyed extracted-specifier cache. `--verbose` emits per-phase wall time.

---

## Append-Only Check: Archive-Detection Exception

`.claude/audit/skip-gates.jsonl` is append-only. The pre-commit hook (`skip-gates-append-only-check.mjs`) parses the git diff of `skip-gates.jsonl` and rejects any change that modifies an existing line -- only pure appends are allowed.

### The Archive-Detection Exception

Intentional rotation of the audit log is sometimes necessary (e.g., rolling to a new file at year boundary, archiving before a major refactor). The hook detects archive events by:

1. Checking if the old file content is **entirely absent** from the new content (i.e., the diff is "replace file wholesale").
2. Checking if a sibling file matching `skip-gates.jsonl.archive-YYYY-MM-DD` exists and contains the old content verbatim.

If both conditions hold, the hook allows the change. Any other mutation (line modification, partial deletion, out-of-order append) is rejected.

### Tamper Detection Scope

The append-only check fires only at commit time. `git commit --no-verify` or out-of-band filesystem writes bypass runtime detection under the current sole-developer trust model. Use `git log -p .claude/audit/skip-gates.jsonl` for post-hoc inspection.

---

## Rollout Driver Internals

`.claude/scripts/rollout-resync.mjs` iterates projects from `.claude/projects.json` and runs `metaclaude-cli sync <project> --force`.

### Lifecycle

| Phase        | Behavior                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `opt-in`     | Sync only projects explicitly listed on command line                                                 |
| `staged`     | Sync projects in a pre-defined canary set first, wait for operator confirmation, then sync remainder |
| `default-on` | Sync all projects listed in `projects.json` in sequence                                              |

### Missing Directory Detection

Missing consumer directories emit `TARGET_MISSING_MARKER` and are marked skipped, distinguishing deleted/unavailable consumers from sync crashes.

### Failure Capture

Failures are written to `.claude/audit/rollout-failures.jsonl` as `{timestamp, project, exit_code, stderr_excerpt}`. `stderr_excerpt` uses allowlist redaction: known error codes, paths, JSON violations, and known stack frames pass; unknown content becomes `[REDACTED]`.

### Consecutive-Failure Exit

If the same consumer fails 3 times consecutively across rollout runs, the driver exits non-zero with `SYNC FAILED (3x): <consumer>, last error: <message>`. This prevents infinite-retry loops on a persistently broken consumer.

---

## Adding a New Artifact to the Registry

Pipeline correctness checklist:

1. Put the file under a sync-scoped root.
2. Add an artifact entry with `"hash": "placeholder"`.
3. Add `category/name` to the correct bundle `includes`.
4. Run `compute-hashes --update`; fix findings or add an explicit `orphans[]` rationale.
5. Sync at least one consumer and diff the shipped copy.

### Why Imports Can't "Just Work"

Missing registry entry emits `orphan`; missing imported helper emits `import-unregistered`; wrong tier emits `cross-bundle-closure`. All fail before registry write.

---

## Adding a New Bundle

Adding a bundle requires three changes:

1. **`metaclaude-registry.json`** -- add a new `bundles.<name>` entry with `description`, optional `extends`, and `includes: []`.
2. **`lib/sync-constants.mjs`** -- add the new bundle to `BUNDLE_INHERITANCE` with its fully-expanded ancestor list. The closure check reads this, not the registry's `extends` field. If you omit this step, the closure check will throw when asked to look up the new bundle's ancestors.
3. **Documentation** -- update `SYNC-SYSTEM.md` § Bundle Definitions and this file.

The registry describes bundle inheritance; `BUNDLE_INHERITANCE` enforces it.

---

## TOCTOU Model

### What Is Protected

Every path resolution under `.claude/` passes through `lib/path-containment.mjs`:

```javascript
export function assertContainment(target, claudeRoot) {
  const real = fs.realpathSync(target); // follows symlinks
  if (real === claudeRoot) return real;
  if (real.startsWith(claudeRoot + path.sep)) return real;
  throw new PathEscapeError({ target, real, claudeRoot });
}
```

The `path.sep` suffix is **required**. Naive `startsWith(claudeRoot)` without the separator allows `/foo/.claude-evil/x.mjs` to pass containment (it starts with `/foo/.claude`). The prefix-collision attack is defeated by requiring `/foo/.claude/` as the prefix.

### What Is NOT Protected

The residual time-of-check/time-of-use window between `realpathSync()` and the actual `readFileSync()` call is not eliminated. An attacker with concurrent filesystem write access could replace a file in the microsecond window.

`metaclaude-cli sync` mitigates this by re-running `assertContainment()` immediately before each `readFileSync()` -- so there are two checks (compute time and sync time) with a smaller window between sync-time check and sync-time read. This is **shrinking**, not eliminating, the window.

The residual is accepted under the sole-developer trust model. `fd`-reuse (resolving path to an open file descriptor and passing the fd through to the read) is out of scope.

### Source-Code Grep Rule

`target.startsWith(claudeRoot)` without the trailing separator is prohibited in source code. An AC enforces this via grep at test time -- the literal pattern must not appear in any `.mjs` file under `.claude/scripts/`. Use `assertContainment()` from `lib/path-containment.mjs` instead.

---

## See Also

- `.claude/docs/SYNC-SYSTEM.md` -- Operational guide (how to use the sync system)
- `.claude/docs/HOOKS.md` -- Live hook inventory and hook placement reference
- `.claude/metaclaude-registry.json` and `.claude/schemas/metaclaude-registry.schema.json` -- Registry artifact model
- `.claude/audit/legacy-orphans-backlog.md` -- Resolved legacy orphan migration record
- `.claude/memory-bank/org-context.md` -- Trust model and multi-developer hardening triggers

# Sync System Internals

Developer reference for the sync validation pipeline. This document describes the internal architecture of the gates that protect `.claude/metaclaude-registry.json` from drift. For the operational guide (how to use the sync system), see `.claude/docs/SYNC-SYSTEM.md`.

---

## Validator Pipeline Architecture

The sync validation pipeline runs inside `compute-hashes --update` before the registry is written to disk. Three gates run in sequence against a single in-memory registry object. All findings are collected; the registry is written only if the gate set is empty (or `--skip-gates` is set).

### Pipeline Stages

```
compute-hashes --update
  |
  v
1. Parse CLI flags, validate --skip-gates reason if present
  |
  v
2. Read .claude/metaclaude-registry.json
  |
  v
3. Validate registry shape via lib/registry-schema.mjs (Zod)
     on failure: emit {rule: "provenance-invalid"}, exit 1
  |
  v
4. Orphan detector (lib/orphan-detector.mjs)
     Walks sync-scoped roots, flags unregistered files
  |
  v
5. Import-graph validator (lib/import-graph-validator.mjs)
     Parses every registered .mjs with acorn
     For each relative import: realpath + containment + registry lookup + closure check
  |
  v
6. Aggregate findings
  |
  +-- findings empty OR --skip-gates set
  |     v
  |     Write registry to .claude/metaclaude-registry.json.<pid>.tmp
  |     Atomic rename to final path
  |     Append skip-gates audit entry if applicable
  |     Emit overuse WARNING if >= 5 skip-gates in 7 days
  |     exit 0
  |
  +-- findings non-empty AND GATE_MODE === 'block'
        v
        Write findings as JSON lines to stderr
        exit 1 (no registry write)
```

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

```javascript
// lib/sync-constants.mjs

// Bundle inheritance chain. `minimal: []` is the explicit base case --
// empty ancestor list means "only minimal-tier imports allowed", NOT
// "any bundle allowed".
export const BUNDLE_INHERITANCE = {
  minimal: [],
  'core-workflow': ['minimal'],
  'full-workflow': ['core-workflow', 'minimal'],
};

// Global orphan-detector whitelist. Files matching these globs are
// per-consumer leaves and never shipped via the registry.
export const WHITELIST_GLOBS = [
  '**/__tests__/**',
  '**/__fixtures__/**',
  '**/.gitkeep',
];

// Skip-gates overuse threshold: N uses in 7-day rolling window emit
// WARNING. A code constant, not a registry field.
export const SKIP_GATES_OVERUSE_THRESHOLD = 5;
export const SKIP_GATES_WINDOW_DAYS = 7;
export const SKIP_GATES_MIN_REASON_LENGTH = 10;

// Sync-scoped root list. Files under these roots must be registered
// (or in orphans[], or whitelist-matched). Files under any other root
// are not checked by the orphan detector.
export const SYNC_SCOPED_ROOTS = [
  '.claude/scripts/',
  '.claude/agents/',
  '.claude/skills/',
  '.claude/templates/',
  '.claude/docs/',
  '.claude/memory-bank/',
  '.claude/hooks/',
  '.claude/specs/schema/',
];
```

Any change to these constants requires a source-code diff that is visible in code review. This is the difference between a security-relevant decision and a data-driven one.

---

## Zod Schema Extension Points

The registry schema lives at `lib/registry-schema.mjs`. It is the single source of truth for what a valid registry looks like, imported by `compute-hashes`, the pre-commit hook wrappers, and any future registry validator.

### Core Schemas

```javascript
// Orphans entry: object form with full provenance
export const orphansEntrySchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(20), // substantive rationale required
  added_by: z.string().min(2),
  added_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// Artifact entry: passthrough-enabled for forward compatibility
export const artifactEntrySchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    hash: z.string().regex(/^[a-f0-9]{8}$/),
    path: z.string().min(1),
    description: z.string().optional(),
    dependencies: z.array(z.string()).optional(),
    target_path: z.string().optional(),
    _sync_policy: z.enum(SYNC_POLICY_VALUES).optional(),
    _sync: z.boolean().optional(),
  })
  .passthrough();
```

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

`orphansEntrySchema` accepts `reason: "legacy"` as a valid value, bypassing the `.min(20)` requirement, because M1 migrated pre-existing orphan entries without historical rationale. Legacy entries are tracked in `.claude/audit/legacy-orphans-backlog.md` with a 2026-09-30 deadline -- after that date, `compute-hashes` emits a non-blocking WARNING for every remaining legacy entry. See the `legacy-orphans-inventory-missing` rule.

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

```javascript
function closureCheck(importerBundle, importeeBundle) {
  // Base case: minimal -> minimal, core -> core, full -> full all pass
  if (importerBundle === importeeBundle) return { ok: true };

  // Look up ancestor list from code constant (NOT from registry)
  const ancestors = BUNDLE_INHERITANCE[importerBundle]; // may be []
  if (ancestors.includes(importeeBundle)) return { ok: true };

  return {
    ok: false,
    rule: 'cross-bundle-closure',
    importer: importerPath,
    importee: importeePath,
    importerBundle,
    importeeBundle,
  };
}
```

The `minimal: []` base case is critical. An empty ancestor list means "only minimal-tier imports allowed", not "any bundle allowed". The short-circuit on `importerBundle === importeeBundle` handles the `minimal → minimal` case without touching the ancestor list, which is the anchor-case edge: `spec-validate.mjs` (minimal) imports `lib/spec-utils.mjs` (minimal).

### Parse Error Handling

If acorn throws a `SyntaxError` on a registered `.mjs`:

1. Emit `{rule: "parse-error", file, line, column}`.
2. Add the file's realpath to `parse_errored_files` set.
3. Continue parsing remaining files (a single parse error does not abort the phase).
4. At phase end, if `parse_errored_files` is non-empty, exit non-zero.
5. Any file that imports a parse-errored file gets a distinct `import-target-unresolvable` finding (so the reader can see "this import chain is broken because its target failed to parse").

### Performance Bound

- Serial acorn parse, no worker pool.
- ~150 registered `.mjs` files × ~10 ms per file ≈ 1.5 s wall-clock baseline.
- Budget: ≤ 5 s. Headroom for growth to ~500 artifacts before the budget tightens.
- No AST cache in the initial implementation. If future measurements show > 5 s wall-clock or the artifact count exceeds ~500, add an mtime-keyed cache at `.claude/audit/ast-cache.json`. Key by `{path, mtime}`, value is the extracted specifier list (not the raw AST).

Wall-clock duration is emitted to stderr at `--verbose` level.

---

## Append-Only Check: Archive-Detection Exception

`.claude/audit/skip-gates.jsonl` is append-only. The pre-commit hook (`skip-gates-append-only-check.mjs`) parses the git diff of `skip-gates.jsonl` and rejects any change that modifies an existing line -- only pure appends are allowed.

### The Archive-Detection Exception

Intentional rotation of the audit log is sometimes necessary (e.g., rolling to a new file at year boundary, archiving before a major refactor). The hook detects archive events by:

1. Checking if the old file content is **entirely absent** from the new content (i.e., the diff is "replace file wholesale").
2. Checking if a sibling file matching `skip-gates.jsonl.archive-YYYY-MM-DD` exists and contains the old content verbatim.

If both conditions hold, the hook allows the change. Any other mutation (line modification, partial deletion, out-of-order append) is rejected.

### Tamper Detection Scope

The append-only check fires **only at commit time**. Once the hook is bypassed via `git commit --no-verify`, or once an adversary with write access modifies the file outside the commit path, there is **no runtime detection mechanism** that surfaces the tampering at read time.

This is an explicit security-risk acknowledgment in the spec. Future hardening (hash chain, append-only fmode, CI-enforced check) is deferred and documented in `org-context.md`. Out-of-band tamper detection is available via `git log -p .claude/audit/skip-gates.jsonl` -- the commit history provides post-hoc visibility.

---

## Rollout Driver Internals

`.claude/scripts/rollout-resync.mjs` is the M4 driver that iterates over all projects in `.claude/projects.json` and runs `metaclaude-cli sync <project> --force` against each.

### Lifecycle

| Phase        | Behavior                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `opt-in`     | Sync only projects explicitly listed on command line                                                 |
| `staged`     | Sync projects in a pre-defined canary set first, wait for operator confirmation, then sync remainder |
| `default-on` | Sync all projects listed in `projects.json` in sequence                                              |

### Missing Directory Detection

Consumer directories are resolved relative to the metaclaude-assistant repo via `projects.json`. If a consumer directory does not exist, the driver emits a structured `TARGET_MISSING_MARKER` line to stderr and marks the project as skipped. This is how the rollout distinguishes "consumer repo was deleted" from "consumer sync crashed" -- a missing directory is recoverable state (add it back, re-run), while a crash needs investigation.

### Failure Capture

Per-consumer failures are captured to `.claude/audit/rollout-failures.jsonl`. Each line contains `{timestamp, project, exit_code, stderr_excerpt}`. The `stderr_excerpt` is filtered through `redactStderr`, which uses an **allowlist** (not a blocklist) to prevent accidental secret leakage:

- Allowlist matches: error codes, file paths, JSON violation objects, stack frames from known source files.
- Everything else is redacted to `[REDACTED]`.

The allowlist approach is safer than a blocklist because blocklists fail open on novel secret formats. An allowlist fails closed -- unknown content is redacted by default.

### Consecutive-Failure Exit

If the same consumer fails 3 times consecutively across rollout runs, the driver exits non-zero with `SYNC FAILED (3x): <consumer>, last error: <message>`. This prevents infinite-retry loops on a persistently broken consumer.

---

## Adding a New Artifact to the Registry

This supplements the operational checklist in `SYNC-SYSTEM.md`. From a pipeline correctness perspective:

1. **Place the file** under a sync-scoped root. If the file is under an excluded root (e.g., `.claude/journal/`), it will never be checked by the gates and never synced.
2. **Add the artifact entry** to `metaclaude-registry.json` under the right category. Use `"hash": "placeholder"` -- `compute-hashes --update` fills it in.
3. **Add the artifact's `category/name` to the correct bundle's `includes` array**. If the file imports from a more-restricted bundle (e.g., a `core-workflow` script importing a `minimal` library), the closure check passes. If it imports from a more-permissive bundle (e.g., a `minimal` script importing a `full-workflow` library), the check fails -- either downgrade the importee's bundle or upgrade the importer's.
4. **Run `compute-hashes --update`**. Gates run. If they pass, the registry is written atomically with the real hash. If they fail, fix the findings or append the file to `orphans[]` with a real rationale (not a legacy sentinel).
5. **Run `metaclaude-cli sync <project>`** against at least one consumer to verify the artifact ships.
6. **Verify** with `diff` between source and consumer copy.

### Why Imports Can't "Just Work"

If step 3 is skipped, step 4 will emit `import-unregistered` findings for every relative import from an already-registered file. If step 2 is skipped (file on disk, not in registry), step 4 will emit `orphan`. If the bundle tier is wrong, step 4 will emit `cross-bundle-closure`. All three failures happen **before** the registry is written, so they cannot ship to consumers.

---

## Adding a New Bundle

Adding a new bundle requires coordinated changes in **three** places:

1. **`metaclaude-registry.json`** -- add a new `bundles.<name>` entry with `description`, optional `extends`, and `includes: []`.
2. **`lib/sync-constants.mjs`** -- add the new bundle to `BUNDLE_INHERITANCE` with its fully-expanded ancestor list. The closure check reads this, not the registry's `extends` field. If you omit this step, the closure check will throw when asked to look up the new bundle's ancestors.
3. **Documentation** -- update `SYNC-SYSTEM.md` § Bundle Definitions and this file.

The duplication between `registry.bundles[].extends` and `BUNDLE_INHERITANCE` is intentional -- the registry describes the inheritance chain for documentation, the code constant enforces it. A mismatch between them is a source-code diff visible in review.

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
- `.claude/docs/HOOKS.md` -- Full documentation of the validation hooks system
- `.claude/specs/groups/sg-sync-registry-gaps/spec.md` -- Source of truth for gate semantics, ACs, and rollout phases
- `.claude/audit/legacy-orphans-backlog.md` -- Current legacy orphan entries
- `.claude/memory-bank/org-context.md` -- Trust model and multi-developer hardening triggers

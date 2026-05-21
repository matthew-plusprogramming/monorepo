# Sync System Internals

Developer reference for registry validation and sync safety internals. For
operator commands, bundle behavior, deletion propagation, and common failures, see
[SYNC-SYSTEM.md](SYNC-SYSTEM.md).

## Pipeline

`compute-hashes --update` validates before writing
`.claude/metaclaude-registry.json`. It writes only when all gates are clean, or
when an explicit audited `--skip-gates="<reason>"` bypass is accepted.

Order:

1. Parse flags and validate any `--skip-gates` reason.
2. Read `.claude/metaclaude-registry.json`.
3. Validate registry shape.
4. Run orphan detection over sync-scoped roots.
5. Run import-graph validation over registered `.mjs` artifacts.
6. Run cross-bundle closure checks on each resolved relative import.
7. Emit JSONL findings and exit non-zero, or write by temp-file + atomic rename.

`metaclaude-cli sync` runs the same drift checks in warn-only mode before the
sync walk, performs a second containment check immediately before each artifact
read, then provisions consumer-local runtime dependencies for synced
`.claude/scripts/*.mjs` or hook settings under `.claude/node_modules/`.

## Module Map

- `.claude/scripts/compute-hashes.mjs`: CLI entry, gate orchestration,
  skip-gates audit, registry write.
- `.claude/scripts/metaclaude-cli.mjs`: consumer status, sync, verify, and
  sync-time warnings; also provisions `.claude/node_modules` for synced hook
  runtime imports.
- `.claude/scripts/lib/orphan-detector.mjs`: scoped-root walk and `orphan`
  findings.
- `.claude/scripts/lib/import-graph-validator.mjs`: Acorn parse, relative import
  extraction, target resolution, closure checks.
- `.claude/scripts/lib/path-containment.mjs`: `realpath + path.sep` containment.
- `.claude/scripts/lib/registry-schema.mjs`: Zod schemas for registry, artifact,
  and orphan entries.
- `.claude/scripts/lib/sync-constants.mjs`: code-owned bundle ancestry, scoped
  roots, whitelist, skip-gates constants, rule enum.
- `.claude/scripts/validate-orphans.mjs`: pre-commit orphan schema wrapper.
- `.claude/scripts/skip-gates-append-only-check.mjs`: pre-commit append-only
  audit guard.
- `.claude/scripts/rollout-resync.mjs`: multi-consumer rollout driver.

## Code-Owned Policy

Security-relevant sync decisions live in code constants, not in registry data.
The registry describes artifacts; it must not be able to weaken the validator
that protects it.

- `BUNDLE_INHERITANCE`: owned by `lib/sync-constants.mjs`, mirrored in
  `compute-hashes.mjs` with a parity check, and used for allowed import edges.
- `SYNC_SCOPED_ROOTS` / `EXCLUDED_ROOTS`: define what orphan detection polices.
- `WHITELIST_GLOBS`: keeps tests and fixtures as non-shipped leaves.
- `SKIP_GATES_*`: prevents registry edits from hiding bypass abuse.
- `VIOLATION_RULES`: keeps finding names closed and test-pinned.

`minimal: []` is load-bearing: minimal has no ancestors; it does not mean
"import from any bundle."

## Schema Extension

`artifactEntrySchema` is intentionally `.passthrough()` for additive metadata.
Add a field to `registry-schema.mjs` only when validation matters.

Rules:

- Non-security optional metadata can be passthrough.
- Validated metadata belongs in `artifactEntrySchema`.
- Security-relevant behavior belongs in `sync-constants.mjs`, not in the
  registry.
- `orphansEntrySchema` accepts `reason: "legacy"` only for migrated fixtures and
  old consumers; source migration status is tracked in
  `.claude/audit/legacy-orphans-backlog.md`.

## Import Validator

The validator extracts relative specifiers from `ImportDeclaration`,
`ExportNamedDeclaration`, `ExportAllDeclaration`, and literal dynamic
`import()`. Bare and non-relative specifiers are skipped. Dynamic imports with a
non-literal argument are warning-only because static resolution is impossible.

Extensionless relative imports resolve in this order: `.mjs`, `.js`, `.json`.

Per-edge checks:

1. Missing target -> `import-target-missing`.
2. Path escapes `.claude` containment -> `path-escape`.
3. Target parse failed earlier -> `import-target-unresolvable`.
4. Target matches test/fixture whitelist -> `test-leaf-violation`.
5. Target is not registered -> `import-unregistered`.
6. Target bundle is not same bundle or ancestor -> `cross-bundle-closure`.

Parse errors emit `parse-error` with file, line, and column. The validator keeps
scanning so one bad file does not hide other findings.

Performance model: serial Acorn parse, no AST cache. If this becomes slow, add
a worker pool first; add an mtime-keyed extracted-specifier cache only after
parallelism is insufficient. `--verbose` prints phase timing.

## Skip-Gates Audit

`--skip-gates="<reason>"` is the only supported author-side gate bypass.

Contracts:

- Reason must meet the minimum substantive length in `SKIP_GATES_MIN_REASON_LENGTH`.
- No environment-variable bypass is honored.
- Each accepted bypass appends one JSONL entry to
  `.claude/audit/skip-gates.jsonl`.
- Five or more recent uses within `SKIP_GATES_OVERUSE_WINDOW_MS` emits a
  non-blocking warning.
- `.claude/audit/skip-gates.jsonl` is append-only at commit time.

Archive exception: a staged empty-or-absent `skip-gates.jsonl` may be paired
with a staged `.claude/audit/archive/skip-gates.<YYYY-MM-DD>.jsonl` whose
content is byte-equal to the HEAD audit log. Any other deletion, mutation,
partial rewrite, or out-of-order change is rejected.

## Bundle Changes

New bundle:

1. Add `bundles.<name>` to `.claude/metaclaude-registry.json`.
2. Add the fully expanded ancestor list to `BUNDLE_INHERITANCE`.
3. Update [SYNC-SYSTEM.md](SYNC-SYSTEM.md) and this file.

The registry's `extends` field is descriptive for sync resolution; the closure
gate reads `BUNDLE_INHERITANCE`.

New syncable artifact:

1. Put the file under a sync-scoped root.
2. Add registry entry with `"hash": "placeholder"`.
3. Add `category/name` to the lowest correct bundle.
4. Run `compute-hashes --update`.
5. Sync a consumer and diff the shipped copy.

Finding map: missing registry entry -> `orphan`; missing imported helper ->
`import-unregistered`; wrong tier -> `cross-bundle-closure`.

## Containment Model

Containment checks use realpath plus a separator-suffixed prefix:

```javascript
if (real === claudeRoot) return real;
if (real.startsWith(claudeRoot + path.sep)) return real;
throw new PathEscapeError({ target, real, claudeRoot });
```

The separator is required. A naive `startsWith(claudeRoot)` check would allow
prefix collisions such as `/repo/.claude-evil`.

Protected: symlinks resolving outside `.claude`, prefix-collision escapes, and
source replacement before final artifact read because sync re-runs containment
immediately before `readFileSync`.

Not protected: a hostile concurrent writer swapping a file after final realpath
and before read. That residual race is accepted under the sole-developer trust
model. `fd` reuse would be the harder model, but is not implemented.

## Rollout Driver

`rollout-resync.mjs` runs `metaclaude-cli sync <project> --force` across
configured consumers.

- Missing consumer directory emits `TARGET_MISSING_MARKER` and is counted as
  skipped, not a sync crash.
- Failures are appended to `.claude/audit/rollout-failures.jsonl` with
  allowlist-redacted stderr excerpts.
- Three consecutive failures for the same consumer exit non-zero with the last
  error.

## See Also

- [SYNC-SYSTEM.md](SYNC-SYSTEM.md) - operator guide
- [HOOKS.md](HOOKS.md) - live hook inventory
- `.claude/metaclaude-registry.json` - registry artifact model
- `.claude/audit/legacy-orphans-backlog.md` - historical orphan migration record
- `.claude/memory-bank/org-context.md` - trust model and hardening triggers

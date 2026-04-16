# Sync System

How metaclaude-assistant artifacts are synced to consumer projects.

---

## How the Sync System Works

**metaclaude-assistant** is the canonical source of truth for all shared agents, skills, templates, hooks, scripts, schemas, and documentation. Consumer projects (ai-eng-dashboard, monorepo, engineering-assistant, etc.) receive artifacts via a one-way sync.

### The Sync Command

```bash
node .claude/scripts/metaclaude-cli.mjs sync <project> [--force]
```

This copies artifacts from metaclaude-assistant to the target project, based on:

1. Which **bundle** the project uses (determines the set of artifacts)
2. Which artifacts have changed since last sync (tracked via lock files)
3. Any per-project `additional` or `excluded` overrides

### Other CLI Commands

```bash
node .claude/scripts/metaclaude-cli.mjs list              # Show all configured projects
node .claude/scripts/metaclaude-cli.mjs status [project]   # Check what needs updating
node .claude/scripts/metaclaude-cli.mjs verify [project]   # Verify installed artifacts match lock
node .claude/scripts/metaclaude-cli.mjs add <name>         # Add a new project
node .claude/scripts/metaclaude-cli.mjs remove <name>      # Remove a project
```

### Key Files

| File                                 | Purpose                                                    |
| ------------------------------------ | ---------------------------------------------------------- |
| `.claude/metaclaude-registry.json`   | Central registry: all artifacts, versions, hashes, bundles |
| `.claude/projects.json`              | Target projects and their configurations                   |
| `.claude/locks/<project>.lock.json`  | Tracks what is installed in each project                   |
| `.claude/scripts/metaclaude-cli.mjs` | The sync CLI                                               |
| `.claude/scripts/compute-hashes.mjs` | Hash computation and verification                          |

---

## Registry Structure

`metaclaude-registry.json` is the single source of truth for every syncable artifact. Artifacts are nested by category:

```
artifacts.<category>.<name>
```

Categories: `core`, `config`, `agents`, `skills`, `templates`, `docs`, `scripts`, `infrastructure`, `memory-bank`, `schemas`

### Artifact Entry Fields

Each artifact has these fields:

| Field            | Required | Description                                                         |
| ---------------- | -------- | ------------------------------------------------------------------- |
| `version`        | Yes      | Semver version string                                               |
| `hash`           | Yes      | First 8 chars of SHA-256 hash of file content                       |
| `path`           | Yes      | Path to source file in metaclaude-assistant (relative to repo root) |
| `description`    | Yes      | What the artifact does                                              |
| `target_path`    | No       | Override destination path in consumer (defaults to `path`)          |
| `dependencies`   | No       | Other artifacts this depends on (informational)                     |
| `merge_strategy` | No       | Special merge behavior (only `"settings-merge"` currently)          |

### Concrete Example

Here is the `implementer` agent entry from the registry:

```json
"implementer": {
  "version": "1.4.0",
  "hash": "90bdb5d4",
  "path": ".claude/agents/implementer.md",
  "dependencies": [
    "skills/implement"
  ],
  "description": "Implement from approved specs"
}
```

The artifact path for referencing this in bundles is `agents/implementer` (category + name).

### The `target_path` Override

Most artifacts keep their source path in the target repo. The `target_path` field overrides this. For example, `core/claude-md-base` has:

```json
"path": ".claude/templates/claude-md-base.md",
"target_path": "CLAUDE.md"
```

This means the source lives at `.claude/templates/claude-md-base.md` in metaclaude-assistant but gets copied to `CLAUDE.md` (repo root) in consumer projects.

---

## Bundles (What Gets Synced)

Bundles define which artifacts a project receives. There are four bundles with an inheritance chain:

```
minimal -> core-workflow -> full-workflow -> orchestrator
```

### Bundle Definitions

**minimal** -- Core scripts, schemas, infrastructure. The foundation every project needs.

- Validation scripts (eslint, tsc, spec-validate, hook-wrapper, etc.)
- Infrastructure directories (coordination, journal/decisions)
- Core schemas (spec-group, session)
- `core/claude-md-base` and `config/settings`

**core-workflow** -- Extends minimal. Adds the implement/test/unify cycle.

- Agents: implementer, test-writer, unifier, atomizer, atomicity-enforcer
- Skills: implement, test, unify, atomize, enforce
- Templates: task-spec, atomic-spec, requirements, evidence-table
- Memory-bank files, docs/hooks

**full-workflow** -- Extends core-workflow. Adds all review agents and remaining skills. **This is the default bundle for all projects** (set in `projects.json` defaults).

- Agents: explore, spec-author, code-reviewer, security-reviewer, documenter, browser-tester, interface-investigator, facilitator, refactorer, prd-writer, prd-critic, prd-reader, prd-amender
- Skills: route, spec, code-review, security, docs, browser-test, investigate, prd, orchestrate, refactor
- Templates: prd, spec-group-summary, qa-checklist, integration-testing, git-issue, fix-report, investigation-report, decision-record, agent

**orchestrator** -- Extends full-workflow. Adds multi-workstream orchestration.

- Templates: workstream-spec, refactor-proposal
- Schemas: master-spec, workstream-spec, contract-registry

### Bundle Inheritance

A bundle includes all artifacts from its parent. You do NOT need to repeat parent artifacts in a child bundle's `includes` array. For example, `full-workflow` extends `core-workflow`, so every artifact in `core-workflow` (and `minimal`) is automatically included in `full-workflow`.

### CRITICAL: Artifact Must Be in a Bundle to Sync

**If an artifact exists in the registry but is NOT listed in any bundle's `includes` array, it will NOT be synced to any project.**

This is the single most common source of sync bugs. The registry and bundles are separate concerns:

- **Registry** = "this artifact exists and here is its metadata"
- **Bundle includes** = "this artifact should be synced to projects using this bundle"

Both are required. Adding an artifact to the registry without adding it to a bundle means it will sit in metaclaude-assistant and never reach consumer projects.

**Past bugs caused by this:**

- The `facilitator` and `refactorer` agents were in the registry but missing from the `full-workflow` bundle includes, so they never synced to consumer projects despite being registered.
- Convergence-related scripts were registered but not added to any bundle, silently missing from all targets.
- `scripts/spec-utils` (a shared library imported by `spec-validate.mjs`) was missing from the registry entirely -- consumers crashed with `ERR_MODULE_NOT_FOUND` at runtime. This class of "half-wired artifact" is now caught by the preventive gates (see Sync Validation Gates below).

The fix is always the same: add the artifact's path (`category/name`) to the appropriate bundle's `includes` array.

### Per-Project Overrides

In `projects.json`, individual projects can customize their artifact set:

```json
{
  "projects": {
    "my-project": {
      "bundle": "core-workflow",
      "additional": ["agents/explore"],
      "excluded": ["scripts/workspace-eslint"],
      "protected": [".claude/settings.json"]
    }
  }
}
```

- `additional`: Artifacts added beyond the bundle (useful for cherry-picking from higher bundles)
- `excluded`: Artifacts removed from the resolved set
- `protected`: Files that sync will never overwrite (even with `--force`)

---

## Adding a New Artifact (Checklist)

Follow every step. Skipping step 3 is the most common mistake.

### 1. Create the file in metaclaude-assistant

Write the artifact file in its proper location (e.g., `.claude/agents/my-agent.md`, `.claude/scripts/my-script.mjs`).

### 2. Add entry to `metaclaude-registry.json`

Add under the appropriate category. Example for a new agent:

```json
"agents": {
  "my-agent": {
    "version": "1.0.0",
    "hash": "placeholder",
    "path": ".claude/agents/my-agent.md",
    "dependencies": ["skills/my-skill"],
    "description": "What this agent does"
  }
}
```

### 3. Add to the correct bundle's `includes` array

This is the step people forget. Add `"agents/my-agent"` to the `includes` array of the appropriate bundle in the `bundles` section of `metaclaude-registry.json`.

Choose the right bundle level:

- `minimal` -- Infrastructure, validation scripts, core config
- `core-workflow` -- Implement/test/unify pipeline artifacts
- `full-workflow` -- All review agents, all skills, all templates (most artifacts go here)
- `orchestrator` -- Multi-workstream-specific artifacts only

Remember: child bundles inherit from parents. If you add to `core-workflow`, it is automatically in `full-workflow` and `orchestrator`.

**Cross-bundle closure rule**: An importer at bundle level `X` may only import files registered at bundle level `X` or any ancestor of `X`. A `minimal`-tier script cannot import a `full-workflow`-tier module, because consumers running `minimal` would not receive the importee. This rule is enforced by the import-graph gate at `compute-hashes --update` (see Sync Validation Gates).

### 4. Compute the hash

```bash
node .claude/scripts/compute-hashes.mjs --update
```

This replaces the `"placeholder"` hash with the real SHA-256 prefix. It also runs the sync validation gates -- see Sync Validation Gates below.

### 5. Test the sync

```bash
node .claude/scripts/metaclaude-cli.mjs sync <project> --force
```

### 6. Verify

Compare the synced file in the target project to the source. Check line counts or run `diff`:

```bash
diff .claude/agents/my-agent.md ../target-project/.claude/agents/my-agent.md
```

---

## Common Pitfalls

### Artifact in registry but not in bundle

**Symptom**: Artifact exists in metaclaude-assistant, is in the registry, but never appears in consumer projects.

**Cause**: Missing from the bundle's `includes` array.

**Fix**: Add `"category/name"` to the appropriate bundle. This has caused bugs with facilitator, refactorer, and convergence scripts.

### Bundle inheritance confusion

**Symptom**: Artifact added to `minimal` bundle but someone also adds it to `full-workflow`.

**Cause**: Misunderstanding that `full-workflow` extends `core-workflow` extends `minimal`.

**Fix**: Only add to the lowest bundle level where the artifact belongs. Child bundles automatically include parent artifacts. Duplicating entries is harmless but creates maintenance confusion.

### Local modifications overwritten

**Symptom**: Consumer project had local changes to a synced file, sync overwrites them.

**Cause**: `--force` flag was used, or the file was not in the `protected` list.

**Fix**: Add the file to the project's `protected` array in `projects.json`, or avoid `--force`. Without `--force`, the CLI detects local modifications and reports conflicts instead of overwriting.

### Hash mismatch after editing

**Symptom**: `compute-hashes.mjs --verify` fails after editing an artifact.

**Cause**: The file content changed but the registry hash was not updated.

**Fix**: Run `node .claude/scripts/compute-hashes.mjs --update` after any artifact edit.

### settings.json merge surprises

**Symptom**: Hooks appear duplicated or project-specific hooks disappear.

**Cause**: Misunderstanding the merge strategy (see section below).

**Fix**: Ensure project-specific hooks do NOT have `"_source": "metaclaude"`. Only metaclaude-managed hooks should have this field.

### `ERR_MODULE_NOT_FOUND` on consumer after sync

**Symptom**: Running a synced `.mjs` script on a consumer throws `ERR_MODULE_NOT_FOUND` for a relative import.

**Cause**: The script imports a shared library (e.g., `./lib/helper.mjs`) that exists in metaclaude-assistant but was never added to the registry. The script ships, the helper does not, and the consumer crashes at runtime.

**Fix**: Register the helper in `metaclaude-registry.json`, add it to a bundle with the same-or-lower tier as the importer, and re-sync. To prevent this from happening again, the import-graph gate at `compute-hashes --update` now hard-blocks this class of drift at the author.

---

## What Is NOT Synced

These files stay in metaclaude-assistant and are never copied to consumer projects:

| File/Directory                       | Reason                                                              |
| ------------------------------------ | ------------------------------------------------------------------- |
| `metaclaude-registry.json`           | Canonical registry, not a target artifact                           |
| `projects.json`                      | Internal config for the sync system                                 |
| `.claude/locks/`                     | Per-project lock files, stored in metaclaude-assistant              |
| `.claude/scripts/compute-hashes.mjs` | Sync infrastructure (`_sync: false` in registry, not in any bundle) |
| `test-hooks.mjs`, `__fixtures__/`    | Testing infrastructure                                              |
| Repo-specific agents                 | e.g., `deployer.md` that only exists in ai-eng-dashboard            |

Note: `compute-hashes.mjs` is in the registry (for hash tracking, with `_sync: false`) but not in any bundle. `metaclaude-cli.mjs` IS in the `minimal` bundle and syncs to consumers -- they need it to run `metaclaude-cli sync` themselves.

---

## settings.json Merge Strategy

The `config/settings` artifact uses `merge_strategy: "settings-merge"` instead of simple file copy. This preserves project-specific hooks while updating metaclaude-managed hooks.

### How It Works

1. **If no existing settings.json** in the target: copy source directly.
2. **If existing settings.json** in the target:
   - Parse both source and target as JSON
   - For each hook type (PostToolUse, Stop, etc.) and matcher group:
     - **Remove** hooks with `"_source": "metaclaude"` from the target
     - **Add** all hooks from the source (which all have `"_source": "metaclaude"`)
     - **Preserve** project-specific hooks (those without `_source` field)
   - Also preserve entire hook groups that exist only in the target (project-specific matchers)

### The `_source` Field

The `_source: "metaclaude"` field on hooks is the key to the merge strategy:

- **metaclaude hooks** (`_source: "metaclaude"`) -- Managed by sync. Replaced on every sync with the latest version from metaclaude-assistant.
- **Project hooks** (no `_source` field) -- Owned by the consumer project. Never touched by sync.

### Example

Target project has a custom hook for database migrations:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*.sql",
        "hooks": [
          {
            "type": "command",
            "command": "sqlfluff lint $file",
            "_source": "metaclaude"
          },
          { "type": "command", "command": "run-migration-check $file" }
        ]
      }
    ]
  }
}
```

After sync:

- The `sqlfluff lint` hook (metaclaude) gets replaced with whatever the current metaclaude version is
- The `run-migration-check` hook (project-specific, no `_source`) is preserved untouched

For full hook documentation, see `.claude/docs/HOOKS.md`.

---

## Lock Files

Lock files at `.claude/locks/<project>.lock.json` track what was installed in each project.

### Lock File Structure

```json
{
  "lock_version": "1.0.0",
  "project": "ai-eng-dashboard",
  "synced_at": "2026-02-13T16:36:08.211Z",
  "registry_version": "1.1.0",
  "installed": {
    "agents/implementer": {
      "version": "1.4.0",
      "hash": "90bdb5d4",
      "installed_at": "2026-02-13T16:36:08.199Z"
    }
  }
}
```

### How Lock Files Are Used

- **During sync**: The CLI compares the lock hash against the registry hash and the local file hash. If the registry has a newer hash, the artifact is synced. If the local file hash differs from the lock hash (local modification), sync reports a conflict unless `--force` is used.
- **During status**: Shows which artifacts are current, have updates available, are missing, or have been locally modified.
- **During verify**: Confirms every locked artifact still exists and matches its recorded hash in the target project.
- **Pruning**: When an artifact is removed from a bundle, the next sync removes it from the lock file.

### The `--force` Flag

`--force` overrides conflict detection. Use it when:

- You intentionally want to overwrite local modifications
- You are doing a clean re-sync of all artifacts
- A previous sync was interrupted and left inconsistent state

Without `--force`, locally modified files are reported as conflicts and skipped.

### The `--resolve-conflicts` Flag

`--resolve-conflicts` accepts upstream versions for conflicting artifacts only. It has the same effect as `--force` for artifacts that have local modifications, but leaves non-conflicting artifacts untouched. This provides clearer intent than `--force` when you specifically want to accept upstream changes for known conflicts rather than doing a blanket overwrite.

```bash
node .claude/scripts/metaclaude-cli.mjs sync <project> --resolve-conflicts
```

The output includes a resolved count showing how many conflicting artifacts were updated:

```
Synced: 3 updated, 2 resolved, 0 skipped
```

Use `--resolve-conflicts` instead of `--force` when you have reviewed the conflicts (via `status`) and decided to accept upstream versions. Use `--force` when you want a clean slate regardless of local state.

---

## Hash System

Hashes provide content-addressable integrity checking for all artifacts.

### How Hashes Are Computed

```javascript
createHash('sha256').update(content).digest('hex').slice(0, 8);
```

The hash is the first 8 characters of the SHA-256 hex digest of the file's UTF-8 content.

### Hash Commands

```bash
# Display all hashes and check for mismatches
node .claude/scripts/compute-hashes.mjs

# Verify all registry hashes match file content (exits 1 on failure)
node .claude/scripts/compute-hashes.mjs --verify

# Update registry with current file hashes (runs sync validation gates)
node .claude/scripts/compute-hashes.mjs --update
```

### When to Update Hashes

Run `compute-hashes.mjs --update` after:

- Editing any artifact file
- Adding a new artifact (to replace the `"placeholder"` hash)
- Any change to a file tracked in the registry

The `--verify` flag is useful in CI or pre-sync checks to ensure the registry is consistent.

---

## Sync Validation Gates

`compute-hashes --update` runs three validation gates before touching the registry. These gates catch registry drift (files on disk that are not registered, imports that point at nothing) at the author, not at the consumer's runtime.

### Why Gates Exist

A half-wired artifact -- a registered `.mjs` that imports a relative module that is not itself registered -- ships successfully from metaclaude-assistant but crashes at the consumer with `ERR_MODULE_NOT_FOUND` when the script runs. The gates make this impossible to commit.

### The Three Gates

| Gate                           | What it checks                                                                                                                                                 | Failure rule           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **Orphan detector**            | Every file under the sync-scoped roots (`scripts/`, `agents/`, `skills/`, `templates/`, `docs/`, `memory-bank/`, `hooks/`, `specs/schema/`) must be registered | `orphan`               |
| **Import-graph validator**     | Every relative import (`./foo.mjs`, `../lib/bar.mjs`) in a registered `.mjs` must resolve to a registered file                                                 | `import-unregistered`  |
| **Cross-bundle closure check** | An importer at bundle `X` may only import files at bundle `X` or any ancestor                                                                                  | `cross-bundle-closure` |

Additional rules emitted by these gates: `parse-error`, `import-target-missing`, `import-target-unresolvable`, `legacy-orphans-inventory-missing`, `provenance-invalid`, `path-escape`, `toctou-containment`, `test-leaf-violation`.

### Sync-Scoped Roots

The orphan detector walks these roots exhaustively:

```
.claude/scripts/     .claude/agents/     .claude/skills/
.claude/templates/   .claude/docs/       .claude/memory-bank/
.claude/hooks/       .claude/specs/schema/
```

And excludes these (they are not sync destinations):

```
.claude/journal/       .claude/locks/        .claude/coordination/
.claude/specs/groups/  .claude/specs/archive/ .claude/prds/
.claude/context/       .claude/audit/        .claude/traces/
.claude/scripts/archive/
```

A file under a sync-scoped root that is neither registered in `artifacts.*` nor listed in `orphans[]` and not matched by the global whitelist is flagged as an orphan.

### Whitelist

Three globs are whitelisted globally (hard-coded in `scripts/lib/sync-constants.mjs`):

```
**/__tests__/**       # Per-consumer tests, not shipped
**/__fixtures__/**    # Test fixtures, not shipped
**/.gitkeep           # Directory placeholders
```

Tests and fixtures are **leaves** -- a registered non-test script that imports `./__tests__/helpers.mjs` triggers `test-leaf-violation`.

### Two-Tier Enforcement

| Surface                            | Mode      | On violation                                             |
| ---------------------------------- | --------- | -------------------------------------------------------- |
| `compute-hashes --update` (author) | **block** | Exit non-zero, stderr structured JSON, no registry write |
| `metaclaude-cli sync` (consumer)   | **warn**  | Print `WARNING:` line to stderr, exit 0, sync continues  |

The author-side surface hard-blocks because the developer is keyboard-active and can fix immediately. The consumer-side surface warns because stranding consumers on briefly-drifted upstreams is worse than printing a warning. Both surfaces share the same three gates and same violation shape.

### Structured Violations

Every violation is a JSON line with this shape:

```json
{
  "file": ".claude/scripts/foo.mjs",
  "bundle": "minimal",
  "importer": ".claude/scripts/spec-validate.mjs",
  "missingImport": "./lib/helper.mjs",
  "rule": "import-unregistered",
  "remediation": "node .claude/scripts/compute-hashes.mjs --add .claude/scripts/lib/helper.mjs"
}
```

At the author, these are written to stderr and the process exits non-zero. At the consumer, the same JSON is prefixed with `WARNING:` and the sync continues.

### Performance Budgets

- **Orphan detector**: ≤ 2 seconds wall-clock. Pure `fs.readdirSync` walk, no child processes.
- **Import-graph validator**: ≤ 5 seconds wall-clock. Serial `acorn` AST parse of ~150 registered `.mjs` files. No worker pool, no AST cache. If the budget is exceeded on a larger repo, add a worker pool before adding caching.

`--verbose` prints per-phase wall-clock to stderr.

### Escape Hatch: `--skip-gates`

If a gate blocks a commit and you need to bypass it (e.g., mid-refactor, fix in next commit), use:

```bash
node .claude/scripts/compute-hashes.mjs --update --skip-gates="refactor: moving helper to lib, fix in next commit"
```

**Rules**:

- Reason must be **≥ 10 chars of substantive text** (whitespace-only is rejected).
- No environment variable bypass. The only accepted bypass is the `--skip-gates` flag.
- Every use appends one line to `.claude/audit/skip-gates.jsonl` with `{timestamp, reason, author, command}`.
- The `skip-gates.jsonl` file is append-only. The pre-commit hook rejects any diff that modifies an existing line (only appends permitted).
- **Overuse warning**: 5 or more uses within a rolling 7-day window emits a non-blocking WARNING listing the recent entries. Threshold is a code constant, not a registry field -- a compromised registry cannot raise the threshold to hide abuse.

### Atomicity

`compute-hashes --update` never leaves the registry in a half-written state:

1. Parse `--skip-gates` flag if present, validate reason.
2. Read registry, validate via Zod.
3. Run orphan detector, import-graph validator, cross-bundle closure check.
4. If any gate fails (and `--skip-gates` is not set), write findings to stderr and **exit without touching the registry** (file mtime unchanged).
5. Otherwise, write to `.claude/metaclaude-registry.json.<pid>.tmp` then `rename()` atomically.
6. Clean up any `.tmp` siblings older than 1 hour at script start.

### Sync-Time Drift Warning

When `metaclaude-cli sync <project>` runs and detects registry drift (an unregistered sync-scoped file, or a dangling relative import in a registered `.mjs`), it prints a `WARNING:` line per finding to stderr but still exits 0. The sync continues and the consumer is not stranded. The author sees the drift immediately at their next `compute-hashes --update`.

---

## TOCTOU Protection

All path resolution under `.claude/` uses `fs.realpathSync()` followed by sep-suffixed prefix containment:

```javascript
const real = fs.realpathSync(target);
if (real === claudeRoot) return real;
if (real.startsWith(claudeRoot + path.sep)) return real;
throw new PathEscapeError({ target, real });
```

**The trailing-separator requirement is load-bearing**. Without it, `/foo/.claude-evil/x.mjs` would pass `startsWith('/foo/.claude')` and escape containment. The helper lives at `.claude/scripts/lib/path-containment.mjs` and is used by both `compute-hashes` and `metaclaude-cli sync`.

**Sync-time re-validation**: `metaclaude-cli sync` re-runs `realpathSync` + containment immediately before every `readFileSync` on an artifact source. This shrinks (but does not eliminate) the time-of-check/time-of-use window between the validator's canonicalization and the actual read. The residual microsecond window is accepted under the sole-developer trust model.

Naive `target.startsWith(claudeRoot)` without the trailing separator is prohibited in source code and would trip the containment check at test time.

---

## Legacy Orphans Backlog

During the M1 migration (spec group `sg-sync-registry-gaps`), the `orphans[]` array was migrated from legacy `string[]` form to object form `{path, reason, added_by, added_date}`. Entries that existed before the migration were backfilled with `reason: "legacy"` because their original rationale was not recorded.

Legacy entries are tracked in `.claude/audit/legacy-orphans-backlog.md` with a deadline of **2026-09-30**. Before that date, each legacy entry must be either:

- **Resolved**: file is archived, deleted, or registered with a real rationale string (≥ 20 chars)
- **Acknowledged**: entry's `reason` is rewritten with a real rationale and `added_by`/`added_date` are updated

After 2026-09-30, `compute-hashes --update` emits a non-blocking WARNING for every remaining `reason: "legacy"` entry. See `.claude/audit/legacy-orphans-backlog.md` for the current list.

---

## Pre-Commit Hook

A composite Husky v9 pre-commit hook at `.husky/pre-commit` runs before every commit. It short-circuits on first failure:

1. **`validate-orphans.mjs`** -- Zod-validates every `orphans[]` entry against the object schema.
2. **`skip-gates-append-only-check.mjs`** -- Rejects any diff that modifies an existing line in `.claude/audit/skip-gates.jsonl`. Appends are permitted. Intentional rotation (archiving the full file) is detected via an archive-detection exception.
3. **`import-graph-validator.mjs`** (invoked via `compute-hashes`) -- Runs the three sync validation gates.

If step 1 fails, steps 2 and 3 do not run. The hook exits with the first failing step's exit code.

Husky v9 uses a simplified hook format -- hooks are plain shell scripts with a shebang. The legacy `. "$(dirname -- "$0")/_/husky.sh"` loader is not used.

### Bypassing the hook

The client-side pre-commit hook can be bypassed via `git commit --no-verify`. This is accepted under the sole-developer trust model. Future hardening (CI-enforced append-only check, signed commits, CODEOWNERS, branch protection) is documented in `org-context.md` under "Multi-developer hardening" and activates when a second committer joins, external consumers appear, or the project acquires remote CI.

### Bootstrap on fresh clone

Husky installs via the `prepare` script in `package.json`. On a fresh clone:

```bash
npm install               # Runs `prepare: husky` and installs hooks
```

If you need to install dependencies without running the prepare script (e.g., CI builds that do not commit):

```bash
npm install --ignore-scripts
```

### Rollback

If the sync validation gates produce unexpected false positives, roll back by reverting the `.husky/pre-commit` file (or flipping `GATE_MODE = 'block'` back to `'warn'` in `compute-hashes.mjs`) and committing. The gates themselves are not hot-pluggable -- rollback requires a source edit, visible in review.

---

## See Also

- `.claude/docs/SYNC-SYSTEM-INTERNALS.md` -- Developer reference for the validation pipeline, Zod schemas, trust root, and extension points
- `.claude/docs/HOOKS.md` -- Full documentation of the validation hooks system
- `.claude/audit/legacy-orphans-backlog.md` -- Current legacy orphan entries with remediation deadline
- `.claude/memory-bank/org-context.md` -- Sole-developer trust model and multi-developer hardening triggers

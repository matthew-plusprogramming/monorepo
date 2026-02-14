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

- Agents: explore, product-manager, spec-author, code-reviewer, security-reviewer, documenter, browser-tester, interface-investigator, facilitator, refactorer, prd-author, prd-reader, prd-writer
- Skills: route, pm, spec, code-review, security, docs, browser-test, investigate, prd, orchestrate, refactor
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

### 4. Compute the hash

```bash
node .claude/scripts/compute-hashes.mjs --update
```

This replaces the `"placeholder"` hash with the real SHA-256 prefix.

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

---

## What Is NOT Synced

These files stay in metaclaude-assistant and are never copied to consumer projects:

| File/Directory                       | Reason                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `metaclaude-registry.json`           | Canonical registry, not a target artifact                              |
| `projects.json`                      | Internal config for the sync system                                    |
| `.claude/locks/`                     | Per-project lock files, stored in metaclaude-assistant                 |
| `.claude/scripts/compute-hashes.mjs` | Sync infrastructure (not in any bundle, despite being in the registry) |
| `.claude/scripts/metaclaude-cli.mjs` | The sync CLI itself (not in any bundle)                                |
| `test-hooks.mjs`, `__fixtures__/`    | Testing infrastructure                                                 |
| Repo-specific agents                 | e.g., `deployer.md` that only exists in ai-eng-dashboard               |

Note: `compute-hashes.mjs` and `metaclaude-cli.mjs` ARE in the registry (for hash tracking) but are NOT in any bundle's includes, so they never sync. This is intentional -- they are metaclaude-internal tools.

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

# Update registry with current file hashes
node .claude/scripts/compute-hashes.mjs --update
```

### When to Update Hashes

Run `compute-hashes.mjs --update` after:

- Editing any artifact file
- Adding a new artifact (to replace the `"placeholder"` hash)
- Any change to a file tracked in the registry

The `--verify` flag is useful in CI or pre-sync checks to ensure the registry is consistent.

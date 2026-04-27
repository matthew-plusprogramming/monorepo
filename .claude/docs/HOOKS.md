---
_source_modules: ['validation-scripts']
---

# Validation Hooks System

This document describes the PostToolUse hooks system that validates agent work in real-time, catching issues immediately after file edits rather than during code review or CI.

---

## Overview

The hooks system provides automated validation that runs after every Edit or Write operation. Hooks are defined in `.claude/settings.json` and execute validation scripts that catch common issues early.

**Key Benefits**:

- Immediate feedback on type errors, linting issues, and schema violations
- Consistent validation across all projects synced from metaclaude-assistant
- Workspace-aware scripts for monorepo support

---

## Hook Input Mechanism

Claude Code hooks receive input via **stdin as JSON**, not environment variables. The JSON includes information about the tool that was used and its parameters.

### Input Format for Edit/Write Hooks

```json
{
  "session_id": "abc123",
  "cwd": "/path/to/project",
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "/path/to/edited/file.ts",
    "old_string": "...",
    "new_string": "..."
  }
}
```

The key field is `tool_input.file_path` which contains the absolute path to the file that was edited or written.

### Available Environment Variables

| Variable             | Availability      | Purpose                                      |
| -------------------- | ----------------- | -------------------------------------------- |
| `CLAUDE_PROJECT_DIR` | All hooks         | Project root directory                       |
| `CLAUDE_CODE_REMOTE` | All hooks         | Whether running remotely (`"true"` or unset) |
| `CLAUDE_ENV_FILE`    | SessionStart only | Path to persist env vars for session         |

**Note**: There is no `CLAUDE_FILE_PATHS` environment variable. File paths must be extracted from stdin JSON.

---

## Hook Architecture

### Trigger Points

| Hook Event     | When Triggered                | Matchers      | Use Case                                                                       |
| -------------- | ----------------------------- | ------------- | ------------------------------------------------------------------------------ |
| `PreToolUse`   | Before tool execution         | Agent, Write, Bash, Read, Edit\|Write | Workflow, file-protection, and e2e isolation gates                  |
| `PostToolUse`  | After Edit or Write completes | `Edit\|Write` | File validation                                                                |
| `SubagentStop` | When a subagent completes     | (none)        | Automated pass evidence recording and dispatch accounting                      |
| `Stop`         | When session ends             | (none)        | Session logging and finalization                                               |

### Configuration Location

Hooks are configured in `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "_source": "metaclaude",
            "_id": "hook-id",
            "type": "command",
            "command": "..."
          }
        ]
      }
    ]
  }
}
```

### Hook Identification

Each metaclaude hook includes:

- `_source`: Always `"metaclaude"` to identify hooks managed by this system
- `_id`: Unique identifier for the hook (used for merging during sync)

---

## The Hook Wrapper Script

Since hooks receive JSON via stdin, we use `hook-wrapper.mjs` to handle the parsing and pattern matching.

### Location

`.claude/scripts/hook-wrapper.mjs`

### Usage

```bash
node .claude/scripts/hook-wrapper.mjs '<pattern>' '<command>'
```

The wrapper:

1. Reads JSON from stdin
2. Extracts `tool_input.file_path`
3. Checks if the file matches the pattern
4. If it matches, runs the command with `{{file}}` replaced by the actual file path
5. Outputs results (limited to 50 lines)

### Pattern Syntax

| Pattern               | Matches                              |
| --------------------- | ------------------------------------ |
| `*.ts`                | Files ending in .ts                  |
| `*.json`              | Files ending in .json                |
| `*CLAUDE.md`          | Files named CLAUDE.md                |
| `.claude/agents/*.md` | MD files directly in .claude/agents/ |
| `.claude/**`          | Any file under .claude/              |
| `.claude/templates/*` | Files directly in .claude/templates/ |

Root-scoped `.claude/...` patterns intentionally ignore nested `.claude`
copies under `.claude/worktrees/`. Generic suffix patterns such as `*.json`
still match there.

### Example Hook

```json
{
  "_source": "metaclaude",
  "_id": "json-validate",
  "type": "command",
  "command": "node .claude/scripts/hook-wrapper.mjs '*.json' 'node validate-json.mjs {{file}}'"
}
```

---

## Current Hooks

Live hook count: 17. No remaining live hook is classified as legacy or purely
advisory. Latency is not currently recorded in repo telemetry, so this table
does not invent averages; add timing before making latency-based cuts.

| Hook ID | Event | Class | Scope | Blocking / failure mode | Keep rationale |
| --- | --- | --- | --- | --- | --- |
| `workflow-gate-enforcement` | PreToolUse | damage-prevention | enforced Agent dispatches | Blocks with exit 2; structural errors fail open, missing convergence fails closed | Prevents out-of-order gate dispatches |
| `workflow-file-protection` | PreToolUse | damage-prevention | Write to protected enforcement files | Blocks with exit 2 | Prevents agents from mutating enforcement state directly |
| `workflow-file-protection-bash` | PreToolUse | damage-prevention | Bash write intent for protected files | Blocks with exit 2; ambiguous write intent fails closed | Covers shell bypasses of protected-file writes |
| `e2e-blackbox-enforcement-agent` | PreToolUse | damage-prevention | e2e-test-writer dispatch | Blocks implementation-bearing dispatches | Starts black-box sentinel for e2e isolation |
| `e2e-blackbox-enforcement-read` | PreToolUse | damage-prevention | e2e-test-writer Read | Blocks reads outside allowlist | Enforces black-box test authoring after dispatch |
| `e2e-blackbox-enforcement-write` | PreToolUse | damage-prevention | e2e-test-writer Edit/Write | Blocks writes outside `tests/e2e/` | Prevents e2e agent from modifying implementation |
| `json-validate` | PostToolUse | lightweight validation | `*.json` | Blocks invalid JSON after writes | Cheap syntax check; intentionally broad |
| `convergence-field-validate` | PostToolUse | state-integrity | active spec manifests | Blocks unknown convergence fields | Protects manifest/session convergence contract |
| `template-validate` | PostToolUse | lightweight validation | `.claude/templates/*` | Blocks invalid templates | Keeps synced templates structurally valid |
| `agent-frontmatter-validate` | PostToolUse | lightweight validation | `.claude/agents/*.md` | Blocks invalid agent frontmatter | Catches broken dispatch metadata at edit time |
| `skill-frontmatter-validate` | PostToolUse | lightweight validation | `.claude/skills/*/SKILL.md` | Blocks invalid skill frontmatter | Scoped to canonical skills, not worktree copies |
| `spec-schema-validate` | PostToolUse | state-integrity | active spec markdown | Blocks schema/frontmatter violations | Keeps active spec contracts machine-readable |
| `spec-validate` | PostToolUse | state-integrity | active spec markdown | Blocks structural/e2e/env AC violations | Preserves executable spec semantics |
| `structured-docs-validate` | PostToolUse | lightweight validation | `.claude/docs/**/*.yaml` | Blocks structured-doc schema drift | Keeps generated structured docs coherent |
| `convergence-pass-recorder` | SubagentStop | state-integrity | convergence agent completions | Exit 0; parse failures record streak-breaking evidence | Maintains convergence evidence without manual writes |
| `dispatch-record-hook` | SubagentStop | state-integrity | subagent completion payloads | Always fail open | Backfills dispatch records when PreToolUse cannot record them |
| `workflow-stop-enforcement` | Stop | damage-prevention | session completion | Blocks via stdout JSON; many structural errors fail open | Prevents incomplete sessions from being marked complete |

### PreToolUse Hooks (Agent)

| Hook ID                     | Trigger Pattern | Script                          | Purpose                                                                       |
| --------------------------- | --------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| `workflow-gate-enforcement` | `Agent`         | `workflow-gate-enforcement.mjs` | Block dispatch of enforced subagent types when workflow prerequisites not met |

### PreToolUse Hooks (E2E Black-Box Enforcement)

Enforces Practice 2.4: the `e2e-test-writer` subagent sees only spec/contracts, never implementation. Three variants (same script, different matchers) provide defense-in-depth across dispatch, read, and write surfaces.

| Hook ID                          | Trigger Pattern | Script                         | Purpose                                                                   |
| -------------------------------- | --------------- | ------------------------------ | ------------------------------------------------------------------------- |
| `e2e-blackbox-enforcement-agent` | `Agent`         | `e2e-blackbox-enforcement.mjs` | Block e2e-test-writer dispatches that include implementation file paths   |
| `e2e-blackbox-enforcement-read`  | `Read`          | `e2e-blackbox-enforcement.mjs` | Block e2e-test-writer reads outside spec/contract/template/test/docs dirs |
| `e2e-blackbox-enforcement-write` | `Edit\|Write`   | `e2e-blackbox-enforcement.mjs` | Block e2e-test-writer writes outside `tests/e2e/`                         |

### PreToolUse Hooks (Write / Bash - Enforcement File Protection)

| Hook ID                         | Trigger Pattern | Script                         | Purpose                                                                                       |
| ------------------------------- | --------------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| `workflow-file-protection`      | `Write`         | `workflow-file-protection.mjs` | Block agent writes to gate-override.json, kill switch, session.json, and session.log          |
| `workflow-file-protection-bash` | `Bash`          | `workflow-file-protection.mjs` | Block destructive Bash writes (`rm`, `mv`, `truncate`, redirection) targeting protected files |

### PostToolUse Hooks (Edit|Write)

| Hook ID                      | Trigger Pattern                        | Script                            | Purpose                                                                                                                                                               |
| ---------------------------- | -------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `json-validate`              | `*.json`                               | inline JSON.parse                 | JSON syntax validation                                                                                                                                                |
| `structured-docs-validate`   | `.claude/docs/**/*.yaml`               | `docs-validate.mjs --hook`        | Validate structured docs YAML schema and cross-references                                                                                                             |
| `template-validate`          | `.claude/templates/*`                  | `template-validate.mjs`           | Validate template structure and placeholders                                                                                                                          |
| `agent-frontmatter-validate` | `.claude/agents/*.md`                  | `validate-agent-frontmatter.mjs`  | Agent frontmatter schema validation                                                                                                                                   |
| `skill-frontmatter-validate` | `.claude/skills/*/SKILL.md`            | `validate-skill-frontmatter.mjs`  | Canonical skill frontmatter schema validation; ignored worktree copies are excluded                                                                                    |
| `spec-schema-validate`       | `.claude/specs/groups/**/*.md`         | `spec-schema-validate.mjs`        | JSON schema validation for active specs (incl. e2e_skip); archived specs are validated by explicit checks, not live edit hooks                                         |
| `spec-validate`              | `.claude/specs/groups/**/*.md`         | `spec-validate.mjs`               | Active spec markdown structure, e2e opt-out, and env-dependent AC enforcement; archived specs are excluded from live edit hooks                                        |
| `convergence-field-validate` | `.claude/specs/groups/**/manifest.json` | `validate-convergence-fields.mjs` | Validate active manifest convergence field names against canonical set; archived and worktree manifests are excluded                                                  |

### SubagentStop Hooks

| Hook ID                     | Script                          | Purpose                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `convergence-pass-recorder` | `convergence-pass-recorder.mjs` | Automatically record pass evidence when convergence check agents complete                                                                                                                                                                                                                               |
| `dispatch-record-hook`      | `dispatch-record-hook.mjs`      | Record Task-tool dispatches via session-checkpoint.mjs (sole writer). Uses SubagentStop per sg-enforcement-layer-gaps Task 22 fallback outcome — Claude Code does not support PostToolUse+Agent. Fail-open on any error; never blocks subagent completion. Type-mismatch rejection generic per AC-11.8. |

### Stop Hooks

| Hook ID                     | Script / Command                | Purpose                                                          |
| --------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| `workflow-stop-enforcement` | `workflow-stop-enforcement.mjs` | Block session completion when mandatory dispatches are missing   |

---

## Validation Scripts

All hook scripts live in `.claude/scripts/`. This section documents only the operational contract needed to use or maintain live hooks. Implementation evidence and historical rollout details belong in specs, tests, or subsystem docs.

### hook-wrapper.mjs

Routes Claude Code hook stdin to a command when `tool_input.file_path` matches a glob. It substitutes `{{file}}` with the edited path and trims command output. Used by the live `PostToolUse Edit|Write` validators.

### validate-agent-frontmatter.mjs

Validates `.claude/agents/*.md` frontmatter: `name`, `description`, `tools`, and `model`; optional `skills` and `exit_validation` are accepted.

### validate-skill-frontmatter.mjs

Validates canonical skill frontmatter under `.claude/skills/*/SKILL.md`: `name`, `description`, `allowed-tools`, and `user-invocable`.

### template-validate.mjs

Validates template structure and placeholders for files under `.claude/templates/*`.

### spec-schema-validate.mjs

Validates active spec markdown frontmatter against the spec schemas. It also enforces strict boolean `e2e_skip` and valid `e2e_skip_rationale` values. Archived specs are not on the live edit-hook path.

### spec-validate.mjs

Validates active spec markdown structure and E2E opt-out consistency. The env-dependent AC scan is advisory: it can warn when referenced implementation files read env vars without a default/unset AC, but it does not change the exit code.

### validate-convergence-fields.mjs

Validates active manifest `convergence` field names against the canonical gate set. Misspelled or non-canonical fields block the edit.

### docs-validate.mjs

Validates structured docs YAML and trace cross-references. Wired as `structured-docs-validate` for `.claude/docs/**/*.yaml`.

### validate-manifest.mjs

Strict CLI validator for spec-group manifests. Rejects legacy-flat fields, requires canonical nested `prd` shape, requires `updated_by`, and strips support for non-canonical convergence clean-pass counters. Use it directly when validating migrated manifests.

### migrate-manifest.mjs

One-shot manifest migration utility:

```bash
node .claude/scripts/migrate-manifest.mjs --all [--dry-run]
node .claude/scripts/migrate-manifest.mjs <path...> [--dry-run]
```

It skips archived specs, writes atomically, preserves file mode, backfills `updated_by`, moves legacy PRD fields into nested `prd`, strips non-canonical convergence counters, and writes conflicts to `.claude/coordination/migration-conflicts.json`.

### shape-lint-hook.mjs

Retained for manual diagnostics only. It is no longer a live `PostToolUse` hook. The former wrapper was advisory, always exited 0, and added latency without enforcing a boundary. Manual controls still exist:

| Control | Scope |
| --- | --- |
| `.claude/coordination/shape-lint-disabled` | Persistent wrapper skip |
| `DISABLE_SHAPE_LINT=1` | Per-process wrapper skip |
| `.claude/coordination/shape-lint-async-mode` | Detached validation mode |

The authoritative blocker is `validate-manifest.mjs`, not this wrapper.

### manifest-post-edit-hook.mjs

Retained as an ad-hoc manifest wrapper. It sequences manifest validation and shape lint, but is not wired as a live hook and always exits 0. Current live manifest checks are `convergence-field-validate`, `spec-schema-validate`, and `spec-validate`.

### import-graph-check.mjs

Completion-verifier utility, not a hook. It checks static import reachability and wiring-task coverage from explicit CLI inputs. Use [TRACES.md](TRACES.md) for the trace-backed path; this script is the direct source fallback.

### session-validate.mjs

Validates `.claude/context/session.json` against the session schema. It is an explicit CLI check, not a live hook.

### convergence-pass-recorder.mjs

Live `SubagentStop` hook. It records trusted convergence pass evidence when convergence agents finish. It resolves the agent type from the Claude Code event envelope, classifies the final response as clean or dirty, and writes through `session-checkpoint.mjs`'s module API. All failures are fail-open so subagent completion is never blocked.

Manual evidence contract: Legacy values `manual` and `hook_manual` are INVISIBLE to convergence streaks. `record-pass --source` rejects CLI-authored pass sources with `SOURCE_FORBIDDEN_VIA_CLI`; programmatic records use `hook`, `parse_failed`, or `manual_fallback`.

### session-checkpoint.mjs

Sole trusted writer for `.claude/context/session.json`. Hook-facing responsibilities:

- record convergence pass evidence via imported `recordPass()`
- derive `clean_pass_count` and `iteration_count` from evidence arrays
- transition workflow phases and challenger substages
- update per-gate circuit-breaker state
- toggle protected kill-switches through auditable CLIs

Direct agent edits to `session.json` are blocked by `workflow-file-protection.mjs`.

### workflow-gate-enforcement.mjs

Live `PreToolUse Agent` hook. It blocks dispatch of enforced subagent types until workflow prerequisites are met, unless the workflow is exempt or a human override applies. Missing convergence fields fail closed as zero clean passes; missing or malformed session state fails open.

### workflow-file-protection.mjs

Live `PreToolUse Write` and `PreToolUse Bash` hook. It blocks direct writes to protected enforcement state, session state, and protected audit-log families. Bash commands are classified with `bash-intent-classifier.mjs`; ambiguous protected-file write intent fails closed. Audit-log writes are permitted only through the attested `audit-append.mjs` path.

### workflow-stop-enforcement.mjs

Live `Stop` hook. It blocks session completion via stdout JSON when mandatory dispatches, manifest obligations, completion invariants, or deployment verification are missing. It checks the kill switch before reading `session.json`, uses a re-entry sentinel, and always exits 0 because blocking is communicated through Claude Code's Stop-hook JSON contract.

#### E2E Opt-Out Enforcement

The Stop hook requires `e2e-test-writer` dispatch for spec-based workflows unless the spec has strict `e2e_skip: true` and a valid rationale from `VALID_E2E_SKIP_RATIONALES`. Invalid or non-boolean opt-outs fail closed.

#### Completion-Invariant Checks

When `shouldRunChecks(session)` is true, Stop runs five checks from `lib/stop-hook-checks.mjs`: convergence depth, challenger stage coverage, phase DAG predecessors, artifact inventory, and manifest/session convergence-field sanity. Convergence depth, artifact inventory, and convergence-field sanity always block; challenger stages and phase predecessors honor warn-only mode.

#### Deployment Verification Gate

When `session.deployment.detected === true`, Stop requires `deployment.verify_deploy_passed === true` unless `deployment.failed === true`. Build verification is advisory; deploy verification is the blocking completion gate.

## SubagentStop Dispatch Record Hook (sg-enforcement-layer-gaps M2)

Live `SubagentStop` hook `dispatch-record-hook.mjs` backfills Task-tool dispatch records through `session-checkpoint.mjs` so Stop-hook mandatory-dispatch checks have complete state. It exists because Claude Code does not support `PostToolUse+Agent` as a post-completion hook. It never writes `session.json` directly and fails open on malformed stdin, missing session state, or CLI failure.

Key invariants:

- matched in-flight dispatches are completed by agent id
- missing prior dispatch records are created then completed
- duplicate dispatch ids are last-write-wins with history
- type mismatches are rejected and counted without leaking expected type hints

## Vibe-Mode Positive Assertion (sg-enforcement-layer-gaps M2)

`/route` starts exempt workflows (`oneoff-vibe`, `refactor`, `journal-only`) with an explicit `active_work.workflow` assertion. Gate and Stop hooks can then distinguish an initialized exempt workflow from a missing or corrupt session. Vibe-mode still cannot bypass edits to trust-bearing enforcement files listed in the Stop-hook allowlist.

## Pipeline-Efficiency Enforcement Primitives

Pipeline-efficiency governance is owned by [PIPELINE-EFFICIENCY-OPERATOR-RUNBOOK.md](PIPELINE-EFFICIENCY-OPERATOR-RUNBOOK.md), [AUDIT-LOG-INSPECTION.md](AUDIT-LOG-INSPECTION.md), and [WORKTREE-CANON.md](WORKTREE-CANON.md). Hook-relevant surfaces are:

| Surface | Canonical path | Hook interaction |
| --- | --- | --- |
| enforcement flag | `.claude/config/pipeline-efficiency-enforcement.json` | `FULL_BLOCK`; direct writes require signed-commit authorization (`git commit -S`) |
| kill-switch sentinel | `.claude/coordination/pipeline-efficiency-disabled` | `FULL_BLOCK`; direct create/delete blocked |
| genesis anchor | `.claude/audit/pipeline-efficiency-genesis.json` | `FULL_BLOCK`; protected audit root |
| audit log | `.claude/audit/pipeline-efficiency-changes.log` | append-only protected write path plus chain verification |
| session-override flow | `.claude/context/session.json` | written through `session-checkpoint.mjs` |
| worktree pin | active repo root | enforced at hook entry and protected-file writes |

Audit event classes retained in the hook-facing contract: `flag_flip`, `test_writer_unlock`, `test_writer_unlock_refence`, `test_writer_unlock_misuse`, `atomizer_cleanup`, `session_override_flip`, `worktree_path_violation`, `sentinel_lifecycle`, `compute_hashes`.

## compute-hashes post-impl -> pre-unify gate

`compute-hashes.mjs --verify` runs at the post-implementation to pre-unify phase transition through `workflow-dag.mjs`. The gate is synchronous: drift aborts the transition before downstream review or convergence recording can consume stale hashes. `compute-hashes --update` remains the author-side repair path.

Operational surfaces:

- `COMPUTE_HASHES_DRIFT`: thrown when verification exits non-zero
- `COMPUTE_HASHES_LOCK_TIMEOUT`: thrown when the advisory lock cannot be acquired
- `.claude/coordination/compute-hashes.lock`: empty advisory lock marker
- `.claude/audit/pipeline-efficiency-changes.log`: receives `compute_hashes` audit entries

## Worktree-canon integration points

Worktree-canon is owned by [WORKTREE-CANON.md](WORKTREE-CANON.md). Hook-relevant rule: session start captures `session.active_work.project_dir_pin`; hook entry or file-target logic rejects symlink components, path escapes, env mutation, and case-FS mismatch before acting on sensitive state.

Live hook consumers:

| Consumer | Check |
| --- | --- |
| `workflow-gate-enforcement.mjs` | env parity at hook entry |
| `workflow-stop-enforcement.mjs` | env parity at hook entry |
| `workflow-file-protection.mjs` | target containment before protected-file decision |
| `validate-convergence-fields.mjs` | env parity before manifest-field validation |

## Status Obligation Enforcement

Status obligations are owned by [WORKFLOW-ENFORCEMENT.md](WORKFLOW-ENFORCEMENT.md). Hook-relevant rule: `session-checkpoint.mjs` validates obligations on phase transitions; `workflow-stop-enforcement.mjs` validates them only at `currentPhase === 'complete'`. Non-complete active phases skip Stop-hook obligation validation to avoid false blocks during normal work.

## Hook Execution Flow

```
Tool request
  |
  |-- PreToolUse: may block before Agent, Write, Bash, or Read
  |
  |-- Tool executes
  |
  |-- PostToolUse Edit|Write: hook-wrapper runs scoped validators
  |
  |-- SubagentStop: convergence and dispatch records update session state
  |
  `-- Stop: may block session completion via stdout JSON
```

---

## Adding New Hooks

### Step 1: Create Validation Script

Create a new script in `.claude/scripts/`:

```javascript
#!/usr/bin/env node

// .claude/scripts/my-validator.mjs

import { readFileSync } from 'fs';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: my-validator.mjs <file>');
  process.exit(1);
}

try {
  const content = readFileSync(filePath, 'utf-8');
  // Perform validation
  const errors = [];
  // ...

  if (errors.length > 0) {
    console.error('Validation errors:');
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  process.exit(0);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
```

### Step 2: Add Hook to settings.json

Add the hook to `.claude/settings.json`:

```json
{
  "_source": "metaclaude",
  "_id": "my-validator",
  "type": "command",
  "command": "node .claude/scripts/hook-wrapper.mjs '*.myext' 'node .claude/scripts/my-validator.mjs {{file}}'"
}
```

### Hook Command Pattern

The standard pattern for hooks using the wrapper:

```bash
node .claude/scripts/hook-wrapper.mjs '<pattern>' '<command with {{file}}>'
```

**Components**:

- `'<pattern>'` - Glob pattern to match files (e.g., `*.ts`, `.claude/agents/*.md`)
- `'<command>'` - Command to run, with `{{file}}` as placeholder for the file path
- The wrapper handles stdin parsing, pattern matching, and output limiting

### Step 3: Register Script (If Syncing)

If the script should sync to consumer projects, add it to `metaclaude-registry.json`:

```json
{
  "artifacts": {
    "scripts": {
      "my-validator": {
        "source": ".claude/scripts/my-validator.mjs",
        "bundles": ["core-workflow", "full-workflow", "orchestrator"]
      }
    }
  }
}
```

---

## Sync and Merge Behavior

When syncing to consumer projects, settings.json uses a merge strategy:

### Merge Rules

1. **Metaclaude hooks** (identified by `_source: "metaclaude"`) are replaced with the latest version
2. **Project-specific hooks** (no `_source` field) are preserved
3. **Hook order**: Project hooks first, then metaclaude hooks

### Example Merge

**Source (metaclaude)**:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "_source": "metaclaude", "_id": "json-validate", "command": "..." }
        ]
      }
    ]
  }
}
```

**Target (consumer project)**:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "_id": "custom-lint", "command": "custom-lint-script" }]
      }
    ]
  }
}
```

**Result (merged)**:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "_id": "custom-lint", "command": "custom-lint-script" },
          { "_source": "metaclaude", "_id": "json-validate", "command": "..." }
        ]
      }
    ]
  }
}
```

---

## Troubleshooting

### Hook Not Running

1. **Check file pattern**: Ensure the file matches the hook's pattern in hook-wrapper.mjs
2. **Check script exists**: Verify the script exists at `.claude/scripts/<script>`
3. **Check wrapper**: Run the wrapper manually to debug:
   ```bash
   echo '{"tool_input":{"file_path":"/path/to/test.json"}}' | node .claude/scripts/hook-wrapper.mjs '*.json' 'echo {{file}}'
   ```

### Hook Errors

1. **Check script output**: Run the script manually with the file path
2. **Check dependencies**: Ensure required tools are installed
3. **Check working directory**: Some scripts require running from a specific directory

### Debugging the Wrapper

Test the wrapper with mock input:

```bash
# Test pattern matching
echo '{"tool_input":{"file_path":"src/test.ts"}}' | node .claude/scripts/hook-wrapper.mjs '*.ts' 'echo "Matched: {{file}}"'

# Test with actual script
echo '{"tool_input":{"file_path":".claude/agents/test.md"}}' | node .claude/scripts/hook-wrapper.mjs '.claude/agents/*.md' 'node .claude/scripts/validate-agent-frontmatter.mjs {{file}}'
```

### Disabling Hooks Temporarily

To temporarily disable hooks, rename settings.json:

```bash
mv .claude/settings.json .claude/settings.json.bak
# ... do work without hooks ...
mv .claude/settings.json.bak .claude/settings.json
```

---

## Related Documentation

- [Workflow Enforcement Architecture](WORKFLOW-ENFORCEMENT.md) - DAG enforcement, operator overrides, completion checklist, evidence-based convergence (derivation contract, 4-tier agent-type extractor, findings extraction pipeline, streak-reset tail-walk, legacy-source invisibility, atomic-write mechanics, circuit-breaker degraded mode), two-store convergence model, `active_work` switch reconciliation, structured log contract, challenger sub-stage tracking, workflow immutability
- [Enforcement Recovery Procedures](ENFORCEMENT-RECOVERY.md) - Operator recovery workflows including legacy convergence records, symlink at session.json, workflow immutability
- [Trace System](TRACES.md) - Trace generation, staleness, and the import-graph-check.mjs fallback for boot-path reachability
- [Completion Verifier Agent](../agents/completion-verifier.md) - Gate 7 (boot-path reachability) uses import-graph-check.mjs as trace fallback and wiring-task detector
- [Deployment Verification Contracts](deployment-verification-contracts.md) - Consumer contract interfaces (verify:build, verify:deploy), HTTP GET fallback, session state schema, CLI commands
- [Kill-Switch Audit Log](AUDIT-LOG.md) - Tamper-evident JSONL log (`audit-append.mjs` / `audit-verify.mjs`), SHA-256 prev-hash chain, PPID-attestation trust channel, rotation family, rate-limit state, BLOCK-mode recovery

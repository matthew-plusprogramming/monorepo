---
_source_modules: ['validation-scripts']
---

# Validation Hooks System

This document is the compact operator reference for `.claude/settings.json`
hooks and the scripts they invoke. It covers live behavior only; historical
rollout details belong in specs, tests, or subsystem docs.

## Hook Input Contract

Claude Code sends hook input on stdin as JSON. File hooks read
`tool_input.file_path`; there is no `CLAUDE_FILE_PATHS` environment variable.

```json
{
  "session_id": "abc123",
  "cwd": "/path/to/project",
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "/path/to/edited/file.ts"
  }
}
```

| Variable | Availability | Purpose |
| --- | --- | --- |
| `CLAUDE_PROJECT_DIR` | All hooks | Project root directory |
| `CLAUDE_CODE_REMOTE` | All hooks | Remote execution marker (`"true"` or unset) |
| `CLAUDE_ENV_FILE` | SessionStart only | Path for persisting session env vars |

## Trigger Points

| Hook Event | When Triggered | Matchers | Live Use |
| --- | --- | --- | --- |
| `PreToolUse` | Before tool execution | Agent, Write, Bash, Read, Edit\|Write | Workflow gates, protected-file gates, e2e isolation |
| `PostToolUse` | After file edits/writes | `Edit\|Write` | Scoped file validation |
| `SubagentStop` | When a subagent completes | (none) | Convergence evidence and dispatch accounting |
| `Stop` | When the session ends | (none) | Completion blocking through Stop-hook JSON |

Do not model `PostToolUse` for `Agent`; Claude Code does not provide that
post-completion surface. `dispatch-record-hook.mjs` exists because of this gap.

## Live Hook Inventory

Live hook count: 17. No remaining live hook is legacy-only or advisory-only.
Latency telemetry is not recorded in this repo, so latency cuts need separate
measurement.

| Hook ID | Event | Class | Scope | Blocking / Failure Mode |
| --- | --- | --- | --- | --- |
| `workflow-gate-enforcement` | PreToolUse | damage-prevention | enforced Agent dispatches | Blocks with exit 2; structural errors fail open; missing convergence fails closed |
| `workflow-file-protection` | PreToolUse | damage-prevention | Write to protected enforcement files | Blocks with exit 2 |
| `workflow-file-protection-bash` | PreToolUse | damage-prevention | Bash write intent for protected files | Blocks concrete protected writes with exit 2; ambiguous classifier results pass through |
| `e2e-blackbox-enforcement-agent` | PreToolUse | damage-prevention | e2e-test-writer dispatch | Blocks implementation-bearing dispatches |
| `e2e-blackbox-enforcement-read` | PreToolUse | damage-prevention | e2e-test-writer Read | Blocks reads outside allowlist |
| `e2e-blackbox-enforcement-write` | PreToolUse | damage-prevention | e2e-test-writer Edit/Write | Blocks writes outside `tests/e2e/` |
| `json-validate` | PostToolUse | lightweight validation | `*.json` | Blocks invalid JSON after writes |
| `convergence-field-validate` | PostToolUse | state-integrity | active spec manifests | Blocks unknown convergence fields |
| `template-validate` | PostToolUse | lightweight validation | `.claude/templates/*` | Blocks invalid templates |
| `agent-frontmatter-validate` | PostToolUse | lightweight validation | `.claude/agents/*.md` | Blocks invalid agent frontmatter |
| `skill-frontmatter-validate` | PostToolUse | lightweight validation | `.claude/skills/*/SKILL.md` | Blocks invalid skill frontmatter |
| `spec-schema-validate` | PostToolUse | state-integrity | active spec markdown | Blocks schema/frontmatter violations |
| `spec-validate` | PostToolUse | state-integrity | active spec markdown | Blocks structural/e2e/env AC violations |
| `structured-docs-validate` | PostToolUse | lightweight validation | `.claude/docs/**/*.yaml` | Blocks structured-doc schema drift |
| `convergence-pass-recorder` | SubagentStop | state-integrity | convergence agent completions | Fail-open; parse failures record streak-breaking evidence |
| `dispatch-record-hook` | SubagentStop | state-integrity | subagent completion payloads | Fail-open; records through `session-checkpoint.mjs` |
| `workflow-stop-enforcement` | Stop | damage-prevention | session completion | Blocks by stdout JSON; many structural errors fail open; runtime-validation specs require passing /manual-test evidence |

### PreToolUse Hooks (Agent)

| Hook ID | Script | Purpose |
| --- | --- | --- |
| `workflow-gate-enforcement` | `workflow-gate-enforcement.mjs` | Blocks enforced subagent dispatch until workflow prerequisites are met |
| `e2e-blackbox-enforcement-agent` | `e2e-blackbox-enforcement.mjs` | Blocks e2e-test-writer dispatches that include implementation paths |

### PreToolUse Hooks (E2E Black-Box Enforcement)

Practice 2.4 isolation is enforced at dispatch, read, and write surfaces so the
`e2e-test-writer` can use specs/contracts but not implementation files.

| Hook ID | Matcher | Script | Purpose |
| --- | --- | --- | --- |
| `e2e-blackbox-enforcement-agent` | `Agent` | `e2e-blackbox-enforcement.mjs` | Reject implementation-bearing dispatch |
| `e2e-blackbox-enforcement-read` | `Read` | `e2e-blackbox-enforcement.mjs` | Reject implementation reads outside allowlist |
| `e2e-blackbox-enforcement-write` | `Edit\|Write` | `e2e-blackbox-enforcement.mjs` | Reject writes outside `tests/e2e/` |

### PreToolUse Hooks (Write / Bash - Enforcement File Protection)

| Hook ID | Matcher | Script | Purpose |
| --- | --- | --- | --- |
| `workflow-file-protection` | `Write` | `workflow-file-protection.mjs` | Blocks direct writes to protected session, gate, kill-switch, and audit state |
| `workflow-file-protection-bash` | `Bash` | `workflow-file-protection.mjs` | Blocks destructive shell write intent against protected files |

### PostToolUse Hooks (Edit|Write)

| Hook ID | Pattern | Script | Purpose |
| --- | --- | --- | --- |
| `json-validate` | `*.json` | inline `JSON.parse` | JSON syntax validation |
| `structured-docs-validate` | `.claude/docs/**/*.yaml` | `docs-validate.mjs --hook` | Structured docs schema and references |
| `template-validate` | `.claude/templates/*` | `template-validate.mjs` | Template structure and placeholders |
| `agent-frontmatter-validate` | `.claude/agents/*.md` | `validate-agent-frontmatter.mjs` | Agent frontmatter schema |
| `skill-frontmatter-validate` | `.claude/skills/*/SKILL.md` | `validate-skill-frontmatter.mjs` | Canonical skill frontmatter schema |
| `spec-schema-validate` | `.claude/specs/groups/**/*.md` | `spec-schema-validate.mjs` | Active spec frontmatter/schema checks |
| `spec-validate` | `.claude/specs/groups/**/*.md` | `spec-validate.mjs` | Active spec structure, e2e opt-out, env AC checks |
| `convergence-field-validate` | `.claude/specs/groups/**/manifest.json` | `validate-convergence-fields.mjs` | Canonical convergence field names |

Archived specs and worktree copies are not on the live edit-hook path unless a
script is run explicitly.

### SubagentStop Hooks

| Hook ID | Script | Purpose |
| --- | --- | --- |
| `convergence-pass-recorder` | `convergence-pass-recorder.mjs` | Records convergence pass evidence from trusted convergence agents |
| `dispatch-record-hook` | `dispatch-record-hook.mjs` | Backfills Task-tool dispatch records through `session-checkpoint.mjs` |

### Stop Hooks

| Hook ID | Script | Purpose |
| --- | --- | --- |
| `workflow-stop-enforcement` | `workflow-stop-enforcement.mjs` | Blocks completion when mandatory dispatches, runtime manual-test evidence, obligations, invariants, or deploy verification are missing |

## Hook Wrapper

`hook-wrapper.mjs` routes file-based hook stdin to a validator command.

```bash
node .claude/scripts/hook-wrapper.mjs '<pattern>' '<command with {{file}}>'
```

Wrapper behavior:

- parse stdin JSON
- extract `tool_input.file_path`
- match the path against the supplied glob
- replace `{{file}}` in the command
- run only on match and trim output

Root-scoped `.claude/...` patterns intentionally ignore nested `.claude`
copies under `.claude/worktrees/`. Generic suffix patterns such as `*.json`
still match nested copies.

## Validation Scripts

All scripts live in `.claude/scripts/`.

| Script | Role |
| --- | --- |
| `validate-agent-frontmatter.mjs` | validates `name`, `description`, `tools`, `model`; accepts optional `skills` and `exit_validation` |
| `validate-skill-frontmatter.mjs` | validates canonical skill `SKILL.md` frontmatter |
| `template-validate.mjs` | validates template structure and placeholders |
| `spec-schema-validate.mjs` | validates active spec frontmatter/schema, strict `e2e_skip`, and rationale enums |
| `spec-validate.mjs` | validates active spec structure and e2e/env AC consistency; env-dependent AC scan warns without changing exit code |
| `validate-convergence-fields.mjs` | validates active manifest convergence field names |
| `docs-validate.mjs` | validates structured docs YAML and trace cross-references |
| `validate-manifest.mjs` | explicit CLI validator for spec-group manifests |
| `migrate-manifest.mjs` | one-shot manifest migration utility; writes conflicts to `.claude/coordination/migration-conflicts.json` |
| `shape-lint-hook.mjs` | manual diagnostics only; no longer a live hook |
| `manifest-post-edit-hook.mjs` | ad-hoc manifest wrapper only; no longer a live hook |
| `import-graph-check.mjs` | completion-verifier utility for static import reachability |
| `session-validate.mjs` | explicit CLI validation for `.claude/context/session.json` |
| `session-checkpoint.mjs` | sole trusted writer for workflow/session state |

`shape-lint-hook.mjs` still honors `.claude/coordination/shape-lint-disabled`,
`DISABLE_SHAPE_LINT=1`, and `.claude/coordination/shape-lint-async-mode`.
The authoritative manifest blocker is `validate-manifest.mjs`.

## Convergence Pass Recorder

`convergence-pass-recorder.mjs` is a live `SubagentStop` hook. It resolves the
agent type from the event envelope, classifies the final response as clean or
dirty, and writes through the `session-checkpoint.mjs` module API. It fails
open so subagent completion is not blocked.

The recorder first looks for a canonical `convergence-result` fenced block.
For robustness it also accepts canonical convergence JSON in a `json` fence or
as the whole assistant message. Malformed or missing machine output still
records `parse_failed` evidence.

Pass evidence is work-scoped when a stable id is available. Resolution order is
explicit payload `work_id`, `session.subagent_dispatches[agent_id].work_id`,
matching `subagent_tasks` metadata, then `active_work_id` as a fallback.

Manual evidence contract: Legacy values `manual` and `hook_manual` are
INVISIBLE to convergence streaks. `record-pass --source` rejects CLI-authored
pass sources with `SOURCE_FORBIDDEN_VIA_CLI`; programmatic records use `hook`,
`parse_failed`, or `manual_fallback`.

## Dispatch Record Hook

`dispatch-record-hook.mjs` is a live `SubagentStop` hook. It records Task-tool
dispatches through `session-checkpoint.mjs`, never direct `session.json` edits.
It creates missing prior records, completes matched in-flight records, keeps
history for duplicate ids, rejects type mismatches without leaking expected
types, and fails open on malformed stdin or missing state.

Dispatch records carry `work_id` when the payload or explicit CLI metadata
provides one. The hook runs before the convergence recorder so recorder routing
can use `subagent_dispatches[agent_id].work_id` instead of whichever work item
is active when the subagent returns.

## Workflow Enforcement Hooks

`workflow-gate-enforcement.mjs` blocks enforced Agent dispatch when workflow
prerequisites are missing. Exempt workflows must still have an explicit
`active_work.workflow` assertion so hooks can distinguish an initialized
one-off/refactor/journal workflow from corrupt state. When `active_work_id`
matches a stored `work_items` entry, gate checks read that work item's
convergence counters and filter subagent task prerequisites by `work_id`.

`workflow-file-protection.mjs` blocks direct `Write` and concrete destructive
`Bash` intent against protected enforcement state, session state, and audit-log
families. Bash classification uses `bash-intent-classifier.mjs`; ambiguous
classifier results are advisory and pass through at the hook boundary.
Audit-log writes are allowed only through the attested `audit-append.mjs` path.

`workflow-stop-enforcement.mjs` blocks completion through the Stop-hook JSON
contract when mandatory dispatches, runtime manual-test evidence, manifest
obligations, completion invariants, or deployment verification are missing. It
checks the kill switch before reading `session.json`, uses a re-entry sentinel,
and exits 0 because Claude Code reads the blocking decision from stdout JSON.

### E2E Opt-Out Enforcement

The Stop hook requires `e2e-test-writer` dispatch for spec workflows unless the
spec has strict `e2e_skip: true` plus a valid rationale from
`VALID_E2E_SKIP_RATIONALES`. Invalid or non-boolean opt-outs fail closed.

### Runtime Manual-Test Enforcement

The Stop hook promotes `/manual-test` to mandatory for specs whose frontmatter
declares `runtime_validation_required: true`. It requires a `manual-tester`
dispatch record and a structured passing result in
`session.active_work.manual_test_result`. Narrative reports and
`convergence.manual_tests_passed` are not enforcement sources.

### Completion-Invariant Checks

When `shouldRunChecks(session)` is true, Stop runs checks from
`lib/stop-hook-checks.mjs`: convergence depth, challenger coverage, phase DAG
predecessors, artifact inventory, and manifest/session convergence-field
sanity. Convergence depth, artifact inventory, and convergence-field sanity
always block; challenger coverage and phase predecessors honor warn-only mode.

### Deployment Verification Gate

When `session.deployment.detected === true`, Stop requires
`deployment.verify_deploy_passed === true` unless `deployment.failed === true`.
Build verification is advisory; deploy verification is blocking.

## Pipeline-Efficiency Enforcement Primitives

Pipeline-efficiency governance is owned by
[PIPELINE-EFFICIENCY-OPERATOR-RUNBOOK.md](PIPELINE-EFFICIENCY-OPERATOR-RUNBOOK.md),
[AUDIT-LOG-INSPECTION.md](AUDIT-LOG-INSPECTION.md), and
[WORKTREE-CANON.md](WORKTREE-CANON.md). Hook-facing surfaces:

| Surface | Canonical path | Hook interaction |
| --- | --- | --- |
| enforcement flag | `.claude/config/pipeline-efficiency-enforcement.json` | `FULL_BLOCK`; direct writes require signed-commit authorization (`git commit -S`) |
| kill-switch sentinel | `.claude/coordination/pipeline-efficiency-disabled` | `FULL_BLOCK`; direct create/delete blocked |
| genesis anchor | `.claude/audit/pipeline-efficiency-genesis.json` | `FULL_BLOCK`; protected audit root |
| audit log | `.claude/audit/pipeline-efficiency-changes.log` | append-only protected write path plus chain verification |
| session-override flow | `.claude/context/session.json` | written through `session-checkpoint.mjs` |
| worktree pin | active repo root | enforced at hook entry and protected-file writes |

Audit event classes retained in the hook-facing contract: `flag_flip`,
`test_writer_unlock`, `test_writer_unlock_refence`,
`test_writer_unlock_misuse`, `atomizer_cleanup` (legacy), `session_override_flip`,
`worktree_path_violation`, `sentinel_lifecycle`, `compute_hashes`.

## compute-hashes post-impl -> pre-unify gate

`compute-hashes.mjs --verify` runs at the post-implementation to pre-unify
phase transition through `workflow-dag.mjs`. The gate is synchronous: drift
aborts the transition before review or convergence recording can consume stale
hashes. `compute-hashes --update` is the repair path.

Operational surfaces:

- `COMPUTE_HASHES_DRIFT`: verification exited non-zero
- `COMPUTE_HASHES_LOCK_TIMEOUT`: advisory lock could not be acquired
- `.claude/coordination/compute-hashes.lock`: empty advisory lock marker
- `.claude/audit/pipeline-efficiency-changes.log`: receives `compute_hashes` audit entries

## Worktree-canon integration points

Worktree-canon is owned by [WORKTREE-CANON.md](WORKTREE-CANON.md). Hook-facing
rule: session start captures `session.active_work.project_dir_pin`; hook entry
or file-target logic rejects symlink components, path escapes, env mutation,
and case-FS mismatch before acting on sensitive state. Rejections surface as
`WORKTREE_PATH_VIOLATION`.

| Consumer | Check |
| --- | --- |
| `workflow-gate-enforcement.mjs` | env parity at hook entry |
| `workflow-stop-enforcement.mjs` | env parity at hook entry |
| `workflow-file-protection.mjs` | target containment before protected-file decision |
| `validate-convergence-fields.mjs` | env parity before manifest-field validation |

## Status Obligation Enforcement

Status obligations are owned by [WORKFLOW-ENFORCEMENT.md](WORKFLOW-ENFORCEMENT.md).
`session-checkpoint.mjs` validates obligations on phase transitions.
`workflow-stop-enforcement.mjs` validates them only when
`currentPhase === 'complete'`; non-complete active phases skip Stop-hook
obligation validation to avoid false blocks during normal work.

## Fail-Open Behavior

Fail-open is intentional for structural errors that would otherwise strand a
session: malformed or missing session files, malformed hook stdin, optional
state lookups, and dispatch-record write failures generally exit 0 or emit no
block. Fail-closed is reserved for trust-bearing cases: missing convergence
fields default to zero clean passes, protected-file write intent blocks, invalid
e2e opt-outs block, and completion invariants block at final completion.

## Hook Execution Flow

```text
Tool request
  |
  |-- PreToolUse: may block Agent, Write, Bash, Read, or Edit|Write
  |
  |-- Tool executes
  |
  |-- PostToolUse Edit|Write: hook-wrapper runs scoped validators
  |
  |-- SubagentStop: convergence and dispatch records update session state
  |
  `-- Stop: may block completion through stdout JSON
```

## Adding or Syncing Hooks

Add hooks only when they prevent a real failure mode on a common path. New
metaclaude-managed hooks need:

- a script in `.claude/scripts/` or a short inline command
- a `_source: "metaclaude"` and stable `_id` in `.claude/settings.json`
- a registry entry if the script or docs must sync to consumers
- focused tests for the blocked failure mode and the intended fail-open path

Sync merge rules for `.claude/settings.json`:

- metaclaude hooks (`_source: "metaclaude"`) are replaced by the latest source
- project hooks without `_source` are preserved
- project hooks stay before metaclaude hooks

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Hook did not run | matcher in `.claude/settings.json`; wrapper pattern; script path |
| File hook saw no file | stdin JSON shape; use `tool_input.file_path`, not env vars |
| Wrapper match is surprising | root-scoped `.claude/...` ignores `.claude/worktrees/` copies |
| Hook blocks unexpectedly | run the script directly with the target path and inspect stderr |
| Stop hook loops | check re-entry sentinel, kill switch, and stdout JSON payload |
| Consumer sync changed hooks | compare `_source: "metaclaude"` entries; project hooks should remain |

Minimal wrapper probe:

```bash
echo '{"tool_input":{"file_path":".claude/agents/test.md"}}' \
  | node .claude/scripts/hook-wrapper.mjs '.claude/agents/*.md' 'echo {{file}}'
```

## Related Documentation

- [WORKFLOW-ENFORCEMENT.md](WORKFLOW-ENFORCEMENT.md) - workflow DAG, checkpoints, overrides, kill switches, convergence, deployment verification
- [ENFORCEMENT-RECOVERY.md](ENFORCEMENT-RECOVERY.md) - operator recovery procedures
- [TRACES.md](TRACES.md) - trace generation, staleness, and import-graph fallback
- [../agents/completion-verifier.md](../agents/completion-verifier.md) - completion verification behavior
- [deployment-verification-contracts.md](deployment-verification-contracts.md) - build/deploy verification contracts
- [AUDIT-LOG.md](AUDIT-LOG.md) - tamper-evident audit log, append path, verification, rotation, recovery

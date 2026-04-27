# Pipeline-Efficiency Operator Runbook

Current operator entry point for pipeline-efficiency enforcement primitives:
mode flag, kill-switch sentinel, audit chain, coercive-flip preflight,
test-writer unlocks, worktree pinning, flow-verify diff scope, atomic-spec ID
validation, and hash verification.

Detailed contracts live in the narrower owner docs linked below. Keep this file
as the operator map, not a second implementation history.

## Quick Reference

| Primitive | Path / command | Current owner |
| --- | --- | --- |
| Enforcement flag | `.claude/config/pipeline-efficiency-enforcement.json` | `BASELINE-LIFECYCLE.md`, `SESSION-OVERRIDE-CLI.md` |
| Kill-switch sentinel | `.claude/coordination/pipeline-efficiency-disabled` | `HOOKS.md`, `WORKTREE-CANON.md` |
| Audit chain | `.claude/audit/pipeline-efficiency-genesis.json`, `.claude/audit/pipeline-efficiency-changes.log` | `AUDIT-LOG-INSPECTION.md` |
| Coercive flip preflight | `node .claude/scripts/pipeline-efficiency-coercive-flip-preflight.mjs` | `BASELINE-LIFECYCLE.md` |
| Session override | `node .claude/scripts/session-checkpoint.mjs override-enforcement <advisory|coercive>` | `SESSION-OVERRIDE-CLI.md` |
| Test-writer unlock | `node .claude/scripts/session-checkpoint.mjs record-test-writer-unlock <sg-id> ...` | `TEST-WRITER-UNLOCK-OPERATOR.md` |
| Worktree pin | `session.active_work.project_dir_pin` | `WORKTREE-CANON.md` |
| Flow-verify diff scope | `node .claude/scripts/flow-verify-checks.mjs --stage impl-verify --scope diff ...` | `FLOW-VERIFIER.md` |
| Atomic-spec ID validation | `node .claude/scripts/validate-atomic-filenames.mjs <sg-dir>` | `HOOKS.md`, validator source |
| Hash verification gate | `node .claude/scripts/compute-hashes.mjs --verify` | `HOOKS.md`, `AUDIT-LOG-INSPECTION.md` |

## Enforcement Mode

Modes:

- `advisory`: findings are emitted without merge block.
- `coercive`: findings block merge.
- `off`: gates skipped; cannot be set through session override.

Global mode lives in `.claude/config/pipeline-efficiency-enforcement.json`:

```json
{
  "mode": "advisory",
  "effective_at": "2026-04-22T00:00:00.000Z",
  "operator": "matthewlin",
  "substrate": "local-single-maintainer"
}
```

Changing the global file requires operator intent and signed commit
authorization. For a session-only flip, use:

```bash
node .claude/scripts/session-checkpoint.mjs override-enforcement coercive \
  --rationale "coercive validation run"
```

See `SESSION-OVERRIDE-CLI.md` for override scope and errors.

## Kill-Switch Sentinel

Presence of `.claude/coordination/pipeline-efficiency-disabled` halts
pipeline-efficiency gate logic and blocks advisory-to-coercive flips.

Create:

```bash
node .claude/scripts/session-checkpoint.mjs toggle-kill-switch create \
  --rationale "rollback: preserved-signal regression"
```

Remove:

```bash
node .claude/scripts/session-checkpoint.mjs toggle-kill-switch remove \
  --rationale "incident resolved"
```

Use the CLI. Direct file writes are blocked by file protection. Each lifecycle
change appends `sentinel_lifecycle` to the audit chain before filesystem
mutation.

Worktree caveat: the sentinel is git-tracked on `main`. A sentinel created on
`main` during an active worktree session is not visible inside that worktree
until the worktree sees the commit. The same visibility rule applies to
pipeline-efficiency audit appends and worktree-path violation emissions.

## Audit Chain

Inspect recent entries:

```bash
tail -5 .claude/audit/pipeline-efficiency-changes.log | jq
```

Verify integrity:

```bash
node .claude/scripts/verify-audit-chain.mjs --include-rotations
```

Canonical event classes:

- `flag_flip`
- `test_writer_unlock`
- `test_writer_unlock_refence`
- `test_writer_unlock_misuse`
- `atomizer_cleanup`
- `session_override_flip`
- `worktree_path_violation`
- `sentinel_lifecycle`
- `compute_hashes`

For repair and forensic workflow, use `AUDIT-LOG-INSPECTION.md`.

## Coercive Flip

Before changing global mode from `advisory` to `coercive`:

1. Confirm required per-workstream baselines exist.
2. Confirm the kill-switch sentinel is absent.
3. Run:

   ```bash
   node .claude/scripts/pipeline-efficiency-coercive-flip-preflight.mjs
   ```

4. If accepted, edit the enforcement flag to `"mode": "coercive"` and commit
   with a signed commit.
5. Confirm the audit log captured `flag_flip`.

Rejected flip attempts are also audited. See `BASELINE-LIFECYCLE.md` for error
codes, override files, and scoped preflights.

## Current Subsystems

### Test-Writer Unlocks

Bug-fix-mode specs can grant a time-limited test-writer unlock while feature
mode remains isolated. Operator commands:

```bash
node .claude/scripts/session-checkpoint.mjs record-test-writer-unlock <sg-id> \
  --dispatch-id <id> --first-failure-ref <ref>

node .claude/scripts/session-checkpoint.mjs fire-refence-trigger <sg-id> \
  --trigger <version-bump|workstream-rotate>
```

The full state machine, HMAC secret lifecycle, five re-fence triggers, and
error remediation live in `TEST-WRITER-UNLOCK-OPERATOR.md`.

### Flow-Verify Diff Scope

Flow-verifier uses diff scope at `impl-verify` and `post-impl` by default:

```bash
node .claude/scripts/flow-verify-checks.mjs \
  --sg <sg-id> --stage impl-verify --scope diff --diff-base main
```

`prd-review` and `spec-review` remain full-scope. New boundary-crossing symbols
degrade to full-scope. See `FLOW-VERIFIER.md`.

### Worktree Pin

`session-checkpoint.mjs start-work` captures
`session.active_work.project_dir_pin`. File-touching consumers compare later
paths to that pin. Legitimate relocation uses:

```bash
node .claude/scripts/session-checkpoint.mjs rotate-worktree <new-root> \
  --rationale "worktree relocation"
```

Unauthorized mid-session root changes emit `WORKTREE_PATH_VIOLATION` and abort.
See `WORKTREE-CANON.md`.

### Atomic-Spec IDs

Validate atomic-spec filenames:

```bash
node .claude/scripts/validate-atomic-filenames.mjs \
  .claude/specs/groups/<sg-id>
```

Canonical filename shape is `<ws-id>-as-NNN-<slug>.md` with per-workstream
uniqueness. Migration support remains in `migrate-manifest.mjs
--atomic-id-schema`, but normal operation should validate rather than migrate.

### Hash Verification Gate

`compute-hashes.mjs --verify` runs at the post-implementation to pre-unify
phase transition. Drift aborts the transition before downstream review or
convergence recording. The repair path is:

```bash
node .claude/scripts/compute-hashes.mjs --update
node .claude/scripts/compute-hashes.mjs --verify
```

The gate uses `.claude/coordination/compute-hashes.lock` for advisory
serialization and emits `compute_hashes` audit entries. See `HOOKS.md` and
`AUDIT-LOG-INSPECTION.md`.

## Rollback

For preserved-signal regressions:

1. Create the kill-switch sentinel.
2. Revert global mode to `advisory` if needed.
3. Inspect `.claude/scripts/reverse-governance-monitor.mjs` output.
4. Choose one outcome: scope narrow, threshold tune, revert to advisory, or
   remove the gate.
5. Record the operator decision in
   `.claude/prds/pipeline-efficiency/threshold-decisions.md`.

## See Also

- `BASELINE-LIFECYCLE.md`
- `SESSION-OVERRIDE-CLI.md`
- `TEST-WRITER-UNLOCK-OPERATOR.md`
- `WORKTREE-CANON.md`
- `AUDIT-LOG-INSPECTION.md`
- `FLOW-VERIFIER.md`
- `HOOKS.md`

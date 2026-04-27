# Enforcement Recovery Procedures

Current owner: enforcement recovery operator runbook.

This document covers operator recovery workflows for friction cases the autonomous pipeline cannot self-resolve: dual-store corruption, intentional convergence re-verification, kill-switch toggling, and baseline regression investigation. It complements [Workflow Enforcement Architecture](WORKFLOW-ENFORCEMENT.md) (which is descriptive) with procedural runbooks.

## Dual-Corrupt Recovery (`E_DUAL_CORRUPT`)

### Symptom

Running `node .claude/scripts/session-checkpoint.mjs start-work <sg-id> ...` exits non-zero with:

```
E_DUAL_CORRUPT: both manifest.json and session.json unreadable; manual recovery required
```

### When it fires

`start-work` detects that **both** `.claude/context/session.json` AND the target spec group's `.claude/specs/groups/<sg-id>/manifest.json` are unreadable (missing, malformed JSON, or I/O error) at entry. The CLI refuses to auto-rebuild either file from defaults because auto-rebuild would mask data loss or tampering.

### Behavior (AC-015)

- CLI exits non-zero with the exact message above.
- Neither file is modified.
- If `.claude/scripts/audit-append.mjs` exists, the CLI emits a best-effort `action: "dual_corrupt"` audit entry to `.claude/audit/kill-switch.log.jsonl` (Phase C additive; stderr-only fallback if absent).

### Recovery procedure

1. **Diagnose both files**:

   ```bash
   node -e "JSON.parse(require('fs').readFileSync('.claude/context/session.json', 'utf-8'))"
   node -e "JSON.parse(require('fs').readFileSync('.claude/specs/groups/<sg-id>/manifest.json', 'utf-8'))"
   ```

   Each command either prints nothing (valid JSON) or emits a parse error pointing at the offending line.

2. **Recover the most recent good copy from git**:

   ```bash
   git log -p -- .claude/context/session.json | head -200
   git show HEAD:.claude/context/session.json > /tmp/session-good.json
   git show HEAD:.claude/specs/groups/<sg-id>/manifest.json > /tmp/manifest-good.json
   ```

   If the corruption is ephemeral (e.g., interrupted write), the last committed version restores a consistent state.

3. **Restore the file(s)**:

   ```bash
   cp /tmp/session-good.json .claude/context/session.json
   cp /tmp/manifest-good.json .claude/specs/groups/<sg-id>/manifest.json
   ```

4. **Re-run `start-work`** to verify recovery:

   ```bash
   node .claude/scripts/session-checkpoint.mjs start-work <sg-id> orchestrator "<objective>"
   ```

   A successful run proceeds to phase selection; no `E_DUAL_CORRUPT` re-fires.

5. **Post-recovery checks**: Run `node .claude/scripts/session-checkpoint.mjs verify --spec-group <sg-id>` to confirm the restored state satisfies completion invariants.

### Do not

- **Do not delete** either file blindly; `session.json` carries the live convergence counter for in-progress sessions, and `manifest.json` carries the durable converged-gate assertion.
- **Do not edit** `session.json` directly -- `workflow-file-protection.mjs` blocks agent writes (FULL_BLOCK). Operator restoration from git is outside the hook's vantage and therefore permitted.

## Kill-Switch Toggle (Operator Recovery)

### When to use

The kill switch (`.claude/coordination/gate-enforcement-disabled`) disables all gate and stop enforcement for the session. Use only for:

- Emergency unblock (demo, time-critical hotfix).
- Recovery from a known-bad enforcement state.
- Investigating enforcement-layer bugs (paired with a compensating test).

### Toggle via the authorized CLI (preferred)

```bash
# Enable (create the sentinel)
node .claude/scripts/session-checkpoint.mjs toggle-kill-switch \
  --action create \
  --rationale "Incident #123: enforcement blocking legitimate dispatch"

# Disable (remove the sentinel)
node .claude/scripts/session-checkpoint.mjs toggle-kill-switch \
  --action remove \
  --rationale "Incident #123 resolved"
```

The CLI path:

1. Creates or removes the sentinel atomically.
2. Spawns `audit-append.mjs` with matching action + rationale to write one entry to `.claude/audit/kill-switch.log.jsonl` (PPID-attested; see [AUDIT-LOG.md](AUDIT-LOG.md)).
3. Logs the operation in `session.history[]`.

### Direct toggle (BLOCKED)

Direct Bash attempts are BLOCKED by `workflow-file-protection.mjs`:

```bash
# All of these fail with a BLOCKED redirect to the CLI:
touch .claude/coordination/gate-enforcement-disabled
rm .claude/coordination/gate-enforcement-disabled
node -e "require('fs').writeFileSync('.claude/coordination/gate-enforcement-disabled', '')"
tee .claude/coordination/gate-enforcement-disabled < /dev/null
```

The hook emits a `BLOCKED:` message naming the authorized CLI. Log-scraping tooling that matches on `BLOCKED:` continues to work.

### Verifying the audit trail

```bash
# Show the last 5 entries
tail -n 5 .claude/audit/kill-switch.log.jsonl | jq .

# Recompute the chain
node .claude/scripts/audit-verify.mjs
```

If `audit-verify.mjs` exits non-zero, BLOCK mode is armed. See [AUDIT-LOG.md § Verifying the chain](AUDIT-LOG.md#verifying-the-chain) for recovery via `--ack-tamper`.

## Convergence State on `active_work` Switch

### Default path (preservation)

When `start-work <sg-id>` runs on a spec group with `manifest.convergence.<gate>_converged === true` and `session.convergence.<gate>.clean_pass_count < 2`, the CLI:

1. Emits a WARN log naming both stored values.
2. Seeds `session.convergence.<gate>.clean_pass_count = 2` (manifest wins).
3. Records `record_source: "manifest_seed"` in the sources array.

See [WORKFLOW-ENFORCEMENT.md § Two-Store Convergence Model](WORKFLOW-ENFORCEMENT.md#two-store-convergence-model) and [§ Convergence State Reader Contract](WORKFLOW-ENFORCEMENT.md#convergence-state-reader-contract) for the data-model reference.

**Seeing the WARN is not an error.** Accept the seed and proceed.

### Convergence CLI Reference

Operators have four CLI entry points for convergence-state management. All commands run inside `session-checkpoint.mjs`; `session.json` remains the sole-writer boundary.

| Command                                | Mutates state? | Purpose                                                                      |
| -------------------------------------- | -------------- | ---------------------------------------------------------------------------- |
| `start-work` (default)                 | Yes            | Eager manifest-wins reconciliation runs implicitly on every non-exempt start |
| `start-work --force-reset-convergence` | Yes            | Flips manifest `_converged` booleans to `false` and resets session counters  |
| `start-work --clear-dangling`          | Yes            | Clears `session.active_work` when it references a deleted spec-group dir     |
| `reconcile-convergence <sg>`           | Yes            | On-demand manifest-wins reconcile outside `start-work`                       |
| `reconcile-convergence <sg> --dry-run` | No             | Read-only drift inspection; emits warnings with `[dry-run]` prefix           |

#### `start-work <sg-id> <workflow> <objective> [--force-reset-convergence]`

```bash
node .claude/scripts/session-checkpoint.mjs start-work <sg-id> <workflow> "<objective>" \
  --force-reset-convergence
```

For every gate where `manifest.<gate>_converged === true` OR `session.convergence.<gate>.clean_pass_count > 0`:

- `manifest.convergence.<gate>_converged` is set to `false`.
- `session.convergence.<gate>.clean_pass_count` is set to `0`.
- A `force_reset` entry is appended to `session.convergence.<gate>.sources[]`.
- An audit entry with `action: "convergence_force_reset"` is appended to `manifest.decision_log[]`.
- A `convergence_force_reset` entry is appended to `session.history[]`.
- `session.force_reset_reconcile_skip[<sg-id>] = { session_id, sequence }` is written so downstream reconcile attempts in the same session short-circuit (EC-18 precedence).

There is no silent reset path. Without the flag, the manifest-seed reconciliation applies.

**Exit codes**: `0` on success; non-zero on argument validation failure.

#### `start-work <sg-id> <workflow> <objective> [--clear-dangling]`

```bash
node .claude/scripts/session-checkpoint.mjs start-work <sg-id> <workflow> "<objective>" \
  --clear-dangling
```

When `session.active_work` references a spec-group directory that no longer exists (e.g., after `rm -rf .claude/specs/groups/<old-sg>`), `start-work` normally refuses the new invocation with an active-work-collision error. `--clear-dangling` detects the missing directory and clears `session.active_work` before proceeding.

Behavior:

| Condition                              | Behavior                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Dangling pointer present               | Clears `active_work`, logs `dangling_active_work_cleared` in `session.history[]`, proceeds with new work |
| No dangling pointer (directory exists) | Emits stderr `no dangling active_work pointer to clear`, exits `0`, no history entry, no mutation        |
| No `active_work` set at all            | No-op, same stderr, exit `0`                                                                             |

**Exit codes**: `0` in all three cases. This is a no-op-safe operator unstick path.

**Stderr shape**: `[session-checkpoint] --clear-dangling: cleared dangling active_work pointer to '<sg-id>'` on clear; `no dangling active_work pointer to clear` on no-op.

#### `reconcile-convergence <sg-id> [--dry-run] [--exempt-workflow <w>]`

```bash
node .claude/scripts/session-checkpoint.mjs reconcile-convergence <sg-id>
node .claude/scripts/session-checkpoint.mjs reconcile-convergence <sg-id> --dry-run
```

On-demand manifest-wins reconciliation outside the `start-work` hot path. Runs the same helper (`reconcileConvergenceFromManifest`) `start-work` uses, so results are identical. Useful after:

- An interrupted session where `recordPass()` wrote evidence but `complete-work` never flipped the manifest booleans.
- A manual `manifest.json` edit outside the canonical writers (v1.2 enforcement is deferred -- see Threat Model note below).
- Debugging a suspected drift surfaced by `completion-verifier` or by the local `verify` CLI.

Options:

| Flag                    | Purpose                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--dry-run`             | Read-only inspection. Does NOT mutate `session.json`. Stderr drift warnings prefixed with `[dry-run]`. Always exits `0`. |
| `--exempt-workflow <w>` | Advisory bypass for exempt workflows (`oneoff-vibe`, `refactor`, `journal-only`). Exits `0` with explanatory stderr.     |

**Exit codes**:

| Code | Condition                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------- |
| `0`  | Drift fixed OR no drift detected OR dry-run complete OR exempt-workflow bypass                            |
| `1`  | Missing positional argument (no `<sg-id>`) OR spec-group-id fails `/^sg-[a-z0-9-]+$/` OR manifest missing |

**Stderr shapes** (grep-stable):

| Event              | Shape                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drift detected     | `[session-checkpoint] WARN: convergence drift detected on manual-cli for gate='<g>' (manifest.<g>_converged=true, session.convergence.<g>.clean_pass_count=0) -- seeding session clean_pass_count=2 (manifest wins). See .claude/docs/WORKFLOW-ENFORCEMENT.md#two-store-convergence-model.` |
| No drift           | `reconcile-convergence: no drift detected for '<sg-id>' (no-op)`                                                                                                                                                                                                                            |
| Dry-run drift      | `[dry-run] <drift-warning-line-as-above>` then `[dry-run] reconcile-convergence: would seed <n> gate(s) for '<sg-id>': <gate-list>`                                                                                                                                                         |
| Dry-run no drift   | `[dry-run] reconcile-convergence: no drift detected for '<sg-id>' (no-op)`                                                                                                                                                                                                                  |
| Force-reset active | `force-reset skip active for spec_group='<sg-id>' -- reconciliation bypassed` (emitted when `session.force_reset_reconcile_skip[<sg-id>]` is fresh; EC-18 precedence)                                                                                                                       |
| Validation skip    | `VALIDATION-SKIP: gate='<g>' reason='non_boolean_value' spec_group='<sg-id>'` (emitted per-gate when manifest value is not a strict boolean)                                                                                                                                                |
| Missing manifest   | `reconcile-convergence: manifest not found at <path>` -- exit `1`                                                                                                                                                                                                                           |
| No positional arg  | `Usage: reconcile-convergence <spec_group_id> [--dry-run] [--exempt-workflow <w>]` -- exit `1`                                                                                                                                                                                              |

**Idempotency**: Non-dry-run invocations are idempotent -- a second run against an already-reconciled spec group produces no history entries, no counter deltas, no warnings. Dry-run runs emit warnings on every invocation (AC-13.1).

**What `--dry-run` does not do**: It does NOT test the full reconcile path end-to-end. Force-reset precedence (EC-18) short-circuits dry-run too; the force-reset-skip line is emitted with the `[dry-run]` prefix but no per-gate drift warnings follow.

### Threat Model Note (deferred enforcement)

`reconcile-convergence` reads `manifest.json` (read-only) and writes `session.json` (sole writer boundary). It cannot flip `manifest.convergence.<gate>_converged` values under any code path. However, the **canonical-writer invariant for `manifest.convergence.<gate>_converged` is documented but not yet enforced**:

- Current contract: the canonical writers are `spec-author` subagent and `session-checkpoint complete-work`. Operators or tools that edit `manifest.json` directly outside those paths are NOT blocked.
- Enforcement (via nested-glob `PROTECTED_PATH_PATTERNS` in `workflow-file-protection.mjs`, plus spec-author exemption mechanism) is deferred to the follow-up `sg-manifest-write-protection` spec.
- **Operator implication**: If a manual manifest edit introduces drift (e.g., flipping `_converged: true` incorrectly), the unstick path is `reconcile-convergence <sg>` (which will seed the session counter from the now-incorrect manifest) or `spec-author` re-entry (which re-derives the manifest from authoritative sources). There is no automatic protection against malicious or accidental manifest edits until `sg-manifest-write-protection` lands.

See [WORKFLOW-ENFORCEMENT.md § Convergence State Reader Contract](WORKFLOW-ENFORCEMENT.md#convergence-state-reader-contract) for the canonical reader contract.

## Legacy Convergence Records (`manual` / `hook_manual`)

### Symptom

`session.json` contains pass evidence records with `record_source: "manual"` or `record_source: "hook_manual"`, but the convergence CLI no longer accepts these values and the recorder no longer writes them. Any of the following may appear:

- `convergence.legacy_source_rejected` stderr line during `update-convergence` (one per legacy record encountered on the tail-walk).
- `WARNING: >50% of passes for '<gate>' are manual-sourced` on `update-convergence`, even on sessions where the hook is functioning correctly.
- `clean_pass_count` values that appear lower than the raw record count suggests.

### Why it happens

Before the current CLI source contract, pass evidence could carry `record_source: "manual"` (operator injection) or `record_source: "hook_manual"` (hook's backup mirror). Both writer paths have been removed. Existing records in live sessions remain on disk for audit and schema compatibility.

### Behavior (derivation contract)

The `deriveConvergenceFromEvidence()` reducer treats legacy records as **invisible**:

- Legacy records do NOT increment `iteration_count`.
- Legacy records do NOT break the clean-pass streak (they are skipped, not evaluated).
- Legacy records do NOT contribute to `clean_pass_count` even when `clean === true`.
- Each encounter emits one `convergence.legacy_source_rejected` structured log line with gate, source, record index, and session-id hash.

This guarantees that derivation results match the behavior of a session that carries only post-fix records.

### What to do

- **Nothing, in most cases**. Legacy records are safe: they occupy disk space in `passes[]`, but the reducer skips them entirely. New post-fix records written by the hook accumulate alongside and are counted normally.
- **Ignore the stderr logs**. The `convergence.legacy_source_rejected` lines are audit-trail only; they do not indicate a malfunction.
- **The `>50% manual-sourced` warning** may persist for sessions with substantial pre-fix history. It reflects the ratio of non-`hook` records (including both legacy and current `parse_failed` / `manual_fallback`), not a hook failure. The warning fades once 50%+ of evidence entries are post-fix hook-sourced. No action required unless paired with other failure signals (e.g., `convergence.record_pass_failed` lines).

### Do not

- **Do not hand-edit `session.json`** to remove legacy records. The file is FULL_BLOCK-protected. Manual editing risks both corruption and lost audit trail. Derivation already handles the records correctly.

## Symlink at session.json (`SESSION_JSON_SYMLINK_REFUSED`)

### Symptom

`convergence.record_pass_failed` stderr line with:

```
{"event":"convergence.record_pass_failed","gate":"<gate>","agent_type":"<agent>","error":"RecordPassError: SESSION_JSON_SYMLINK_REFUSED: Refusing to write through symlink at ..."}
```

### Why it happens

The `recordPass()` atomic-write helper performs an `lstat()` pre-check on `session.json` before opening the tmp file. If the target path is a symbolic link, the write is refused. This defends against symlink-redirect attacks where an attacker replaces `session.json` with a link to a sensitive file (the subsequent write would clobber the link target).

### What to do

1. Inspect the file: `ls -la .claude/context/session.json`. A leading `l` in the mode flags indicates a symlink.
2. Replace with a regular file: resolve the symlink's target, copy its contents to a regular file at the canonical path, then remove the symlink. In most cases the symlink was accidentally introduced by a test harness or fixture copy; restoration from git (`git checkout .claude/context/session.json`) resolves it.
3. Ensure the parent directory (`.claude/context/`) is a regular directory, not a symlink.
4. Re-run the convergence check; the next `recordPass()` call will succeed.

## Workflow Immutability (`WORKFLOW_IMMUTABLE`)

### Symptom

`transition-phase` or `start-work` exits non-zero with:

```
WORKFLOW_IMMUTABLE: cannot change workflow mid-session ...
```

### Why it happens

The workflow value on `active_work.workflow` is immutable for the duration of an active-work window. Workflow determines the DAG predecessor graph, the required sub-stage set, and obligation-check semantics; a mid-session downgrade (e.g., orchestrator → oneoff-spec) would invalidate accumulated session history and sub-stage visits.

Common triggers:

- Re-running `start-work <sg-id> <different-workflow> ...` on an already-active spec group.
- Passing `--workflow <W>` to `transition-phase` where `W` differs from the current workflow.

### What to do

To work under a different workflow:

1. Complete or abandon the current active-work window via `complete-work` (or `start-work` on a different `sg-id`, which clears active-work).
2. Start fresh with the desired workflow:
   ```bash
   node .claude/scripts/session-checkpoint.mjs start-work <sg-id> <workflow> "<objective>"
   ```
3. If you intended to resume under the current workflow, omit `--workflow` on `transition-phase`.

Exempt workflows (`oneoff-vibe`, `refactor`, `journal-only`) do not participate in workflow-immutability checks.

## Test Baseline Regression Investigation

### Symptom

`npm run test:baseline` exits 1 with a `new_failures` report. The pipeline treats this as a blocking regression.

### Investigation workflow

1. **Read the report**: stdout is JSON with `new_failures` and `fixed_failures` arrays. Each entry names `file` (repo-relative) and `test` (vitest `fullName`).

2. **Classify the failures**:
   - **Regression** (bug): root-cause the failing test and fix the code.
   - **Expected behavior change**: the test expectation is now wrong; update the test.
   - **Flaky** (rare and accepted): add to baseline via `test-baseline-update.mjs --add`.

3. **Post-remediation refresh**: After fixing inherited-baseline failures (or confirming new regressions land), run:

   ```bash
   npm run test:baseline -- --refresh
   ```

   This recomputes the baseline in place: now-passing inherited entries are removed; new pass-to-fail regressions are added (tagged `new-post-remediation`). Both events log to `.claude/test-baseline.refresh-log.jsonl` with an ISO timestamp and count summary.

4. **Review the refresh log** and commit the updated baseline plus the appended log lines.

Full details: [TEST-BASELINE.md](TEST-BASELINE.md).

## See Also

- [Workflow Enforcement Architecture](WORKFLOW-ENFORCEMENT.md) -- descriptive reference for the enforcement layers, DAG, and two-store model.
- [WORKFLOW-ENFORCEMENT.md § Convergence State Reader Contract](WORKFLOW-ENFORCEMENT.md#convergence-state-reader-contract) -- reader contracts for all four consumers and remediation options.
- [Hooks](HOOKS.md) -- `workflow-file-protection.mjs`, `workflow-gate-enforcement.mjs`, PPID attestation, stage auto-detect.
- [Kill-Switch Audit Log](AUDIT-LOG.md) -- audit chain, rotation, rate-limit, BLOCK mode.
- [Test Baseline System](TEST-BASELINE.md) -- pinned failures, bootstrap/refresh modes.

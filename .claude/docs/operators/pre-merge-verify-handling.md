# Operator Playbook: Pre-Merge-Verify Gate Handling

This playbook covers what to do when the Stop hook blocks session completion because the pre-merge-verify gate (sg-pre-merge-verify-20260508) returned a failed result. The block is the orchestrator's signal that the five-step pipeline (setup → boot → readiness → verify → teardown) detected an integration-level issue that must be resolved before merge.

The pre-merge-verify gate is a **Stop-hook gate** (not a convergence-DAG phase). It runs in `workflow-stop-enforcement.mjs` parallel to the deployment-verify block; both gates compose at the truth-table conjunction `completionAllowed iff !deploymentBlocked && !preMergeBlocked` (NFR-8).

## What the Gate Does

The pre-merge-verifier agent runs a five-step pipeline against a consumer fixture:

1. **Setup**: invokes the consumer's `pre-merge-fixture-setup` script (idempotent fixture preparation).
2. **Boot**: invokes `pre-merge-boot` and parses the first JSON line `{"url": "http://...", "pid": <int>}` from stdout. URL must pass `validatePreMergeUrl` (loopback / RFC1918 / IPv6 unique-local / link-local + ephemeral port).
3. **Readiness**: polls `<url><pre_merge_readiness_path>` (default `/healthz`) under a single per-step envelope (default 30s, configurable via `pre_merge_verify_timeout_ms` ≤ 300000ms) with 250ms backoff and 5s sub-timeouts per HTTP call.
4. **Verify**: calls `runVerifyDeploy({endpointUrl, phase_filter: "pre-merge"})` against the consumer's deployment manifest filtered to routes whose `phases` array includes `"pre-merge"`.
5. **Teardown**: invokes `pre-merge-teardown` (always runs in try/finally per SEC-005); SIGTERM-to-PGID with 5s grace then SIGKILL on the boot-emitted PID's process group.

## What You Will See

When the gate emits a non-passing result, `record-pre-merge-verify-result` writes the discriminated-union shape to `session.pre_merge_verify` and the Stop hook surfaces:

```
Pre-merge-verify gate failed: reason=<closed-22-value-enum> dispatch=<dispatch_id>. See audit chain for evidence narrative.
```

The 22 reason values fall into five buckets (NFR-13):

| Bucket               | Reasons                                                                                                                                                                                                                                           | Stop-hook behavior                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INFRA_BLOCKED` (10) | `fixture_setup_failed`, `fixture_setup_failed_no_script`, `boot_failed`, `boot_failed_url_invalid`, `boot_failed_port_static`, `boot_failed_port_conflict`, `boot_failed_not_ready`, `boot_killed_clean`, `boot_killed_force`, `boot_kill_failed` | Block; **no retry-once** (terminal regardless of `runtime_validation_required`); ≥2 emissions sharing `dispatch_id` add `pre_merge_verify_human_confirmation_required` block-reason |
| `CODE_DEFECT` (1)    | `health_check_failed`                                                                                                                                                                                                                             | Block; treated as code-review fail (operator fixes underlying code)                                                                                                                 |
| `ADVISORY` (3)       | `teardown_failed`, `teardown_skipped`, `teardown_orphan_kill_failed`                                                                                                                                                                              | `status: passed`; advisory warning logged; gate does NOT block; may set `quarantine_until_acknowledged: true`                                                                       |
| `SKIP` (5)           | `no_contract_declared`, `no_manifest`, `no_routes_for_phase`, `no_service_name`, `vibe_mode_no_active_work`                                                                                                                                       | `status: skipped`; gate passes                                                                                                                                                      |
| `SYSTEM_ERROR` (3)   | `pre_merge_verify_lock_timeout`, `audit_chain_tamper_detected`, `config_invalid_timeout`                                                                                                                                                          | Block; operator-recovery CLIs available                                                                                                                                             |

When `dispatch_infra_blocked_count[<dispatch_id>] >= 2` (counter shared with Item A's manual-tester), the Stop hook adds `pre_merge_verify_human_confirmation_required` to the block-reason output. The counter is keyed by verifier `dispatch_id` and resets on phase transition out of `documenting` (Item A DEC-007 / DEC-008).

## Where to Look for Evidence

| Source                               | Path                                                         | Field                                                                                    |
| ------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Live session state                   | `.claude/context/session.json`                               | `pre_merge_verify` (top-level)                                                           |
| Session history (audit chain)        | `.claude/context/session.json`                               | `history[*]` where `event_type === 'pre_merge_verify_recorded'`                          |
| Audit chain monotonic seq            | `.claude/context/session.json`                               | `audit.next_seq`                                                                         |
| Spec group decision log              | `.claude/specs/groups/<sg-id>/manifest.json`                 | `decision_log[*]` where `action === 'pre_merge_verify_recorded'`                         |
| Counter map (≥2-emission gate state) | `.claude/context/session.json`                               | `active_work.dispatch_infra_blocked_count[<dispatch_id>]`                                |
| Lock holder                          | `.claude/coordination/pre-merge-verify.lock`                 | `{pid, hostname, acquired_at}`                                                           |
| Operator enforcement flag            | `.claude/coordination/pre-merge-verify-enforcement-disabled` | Presence bypasses the gate (write-protected; only operator signed commits create/delete) |

## Resolution Flow by Bucket

### `INFRA_BLOCKED` (10 reasons)

These indicate the consumer fixture or boot environment cannot be brought up. The first emission is terminal — there is **no retry-once**.

1. Inspect `narrative` and `dispatch_id` in the `pre_merge_verify_recorded` history entry.
2. Diagnose underlying infra (e.g., Docker daemon, port conflict, missing dependency).
3. Fix the root cause.
4. Re-run the gate via `/pre-merge-verify` (or normal session resume).
5. If you've already seen `pre_merge_verify_human_confirmation_required` (≥2 emissions on the same `dispatch_id`), explicitly acknowledge before resuming.

### `CODE_DEFECT` (1 reason)

`health_check_failed` means the verifier reached step 4 (verify) and `runVerifyDeploy` returned a failure. Treat like a code-review fail: fix the underlying code, push a new commit, re-run.

### `ADVISORY` (3 reasons)

The gate persists `status: passed` so it does NOT block. Advisory warnings are surfaced in stderr. If `quarantine_until_acknowledged: true` was set on a teardown failure, the next gate dispatch will halt at NFR-26 step 3. Clear with:

```
node .claude/scripts/session-checkpoint.mjs clear-pre-merge-quarantine <sg-id> --reason "Reviewed teardown failure; safe to proceed"
```

### `SKIP` (5 reasons)

Gate passes; no resolution required. If you intentionally have no fixture-bootable target (e.g., CLI-only project), set `pre_merge_verify_skip: true` in the spec frontmatter with a free-text rationale ≥15 chars (DEC-003).

### `SYSTEM_ERROR` (3 reasons)

| Reason                          | Recovery                                                                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pre_merge_verify_lock_timeout` | Inspect `.claude/coordination/pre-merge-verify.lock`. If stale (PID dead OR acquired_at older than 60s), the next dispatch reclaims automatically. If a concurrent gate run is genuinely in-flight, wait for it. |
| `audit_chain_tamper_detected`   | Run `node .claude/scripts/session-checkpoint.mjs repair-audit-chain <sg-id> --reason "Audit chain repair after tamper"`; this resets `session.audit.next_seq` to 0 and clears the tamper-failed result.          |
| `config_invalid_timeout`        | Validate consumer's `package.json` config: `node .claude/scripts/session-checkpoint.mjs validate-pre-merge-verify-config <path-to-package.json>`. Fix `pre_merge_verify_timeout_ms` to be ≤ 300000ms.            |

## Manually Disabling the Gate (Operator Only)

The sentinel `.claude/coordination/pre-merge-verify-enforcement-disabled` is hook-protected via `workflow-file-protection.mjs` (AS-8). Agents cannot create or delete it. **Only operators with signed-commit authority** can flip the flag (per `org-context.md` line 94, EDGE-019 carve-out).

When present, the orchestrator short-circuits the gate at NFR-26 step 7 (enforcement-flag read).

## CLI Reference

See `.claude/docs/cli/pre-merge-verify-clis.md`.

## Architecture Reference

See `.claude/docs/internals/pre-merge-verify-architecture.md`.

## Spec Reference

See `.claude/specs/groups/sg-pre-merge-verify-20260508/spec.md` for the full contract.

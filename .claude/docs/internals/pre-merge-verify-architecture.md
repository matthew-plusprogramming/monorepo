# Pre-Merge-Verify Internals: Architecture

This document describes the internal architecture of the pre-merge-verify gate added by `sg-pre-merge-verify-20260508`. The gate is a **Stop-hook gate** (NOT a convergence-DAG phase per Q-DAG=a) parallel to deployment-verify.

## Overview

The pre-merge-verifier orchestrator (`.claude/scripts/lib/pre-merge-verify.mjs`) runs a five-step pipeline against a consumer fixture and writes a discriminated-union result to `session.pre_merge_verify`. The Stop hook (`workflow-stop-enforcement.mjs`) reads `session.pre_merge_verify.status` and blocks completion when `status === 'failed'`.

```
┌─────────────────────────────────────────────────────────────────────┐
│ pre-merge-verifier agent (Task dispatch)                            │
│   ↓                                                                 │
│ runPreMergeVerify(options)                                          │
│   1. NFR-26 dispatch ordering (7 ordered checks)                    │
│   2. TECH-104 Zod timeout validation                                │
│   3. URL validation (validatePreMergeUrl)                           │
│   4. Five-step pipeline (setup → boot → readiness → verify → teardown) │
│   5. Cumulative wall-clock measurement                              │
│   ↓                                                                 │
│ session-checkpoint.mjs record-pre-merge-verify-result               │
│   (or in-process recordAuditEvent named export per DEC-006)         │
│   ↓                                                                 │
│ session.pre_merge_verify = {status, reason, timestamp, ...}         │
│   ↓                                                                 │
│ Stop-hook reads session.pre_merge_verify, sets preMergeBlocked      │
│   ↓                                                                 │
│ Truth-table conjunction: !deploymentBlocked && !preMergeBlocked     │
└─────────────────────────────────────────────────────────────────────┘
```

## NFR-26 Dispatch Ordering (Seven Ordered Checks)

The orchestrator's entry point `runPreMergeVerify` executes seven checks in source order BEFORE any pipeline step:

1. **Vibe-mode short-circuit** — if `session.active_work` absent or workflow is exempt (e.g., `oneoff-vibe`), return `{status: skipped, reason: vibe_mode_no_active_work}`.
2. **Self-exempt detection** — if the spec frontmatter contains `pre_merge_verify_skip: true` (with valid free-text rationale ≥15 chars per DEC-003), return `{status: skipped, reason: no_contract_declared}`.
3. **Quarantine-flag check** — if `session.pre_merge_verify.quarantine_until_acknowledged === true`, HALT immediately (NFR-25).
4. **Lock acquisition** — try to acquire `.claude/coordination/pre-merge-verify.lock` via `O_CREAT | O_EXCL`; staleness detection (per TECH-103) reclaims locks where `kill(pid, 0) === ESRCH` OR `acquired_at` older than 60s (2× max step timeout); 30s wait timeout emits `pre_merge_verify_lock_timeout`.
5. **Audit-chain monotonicity check** — assert `session.audit.next_seq` is consistent with prior emissions; non-monotonic detection emits `audit_chain_tamper_detected`.
6. **Resume-from-incomplete check** — if a prior gate run was interrupted (orphaned lock, partial state), run `pre-merge-teardown` BEFORE step 1 to clean leaked state. Max 3 resume attempts; 3× consecutive teardown failures set the quarantine flag.
7. **Enforcement-flag read** — if `.claude/coordination/pre-merge-verify-enforcement-disabled` exists, short-circuit with operator-disabled status (the sentinel is hook-protected via AS-8 — only operator signed commits create/delete it).

## Five-Step Pipeline (TECH-110)

After the seven NFR-26 checks pass, the orchestrator runs the pipeline:

| Step         | Action                                                                                         | Timeout                                      | Failure Reason                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1. Setup     | `execFile('pre-merge-fixture-setup', --ignore-scripts)`                                        | configurable (`pre_merge_verify_timeout_ms`) | `fixture_setup_failed`, `fixture_setup_failed_no_script`                             |
| 2. Boot      | `execFile('pre-merge-boot', --ignore-scripts, detached)`                                       | configurable                                 | `boot_failed`, `boot_failed_url_invalid`, `boot_failed_port_static`, `boot_killed_*` |
| 3. Readiness | HTTP poll `<url><readiness_path>` (default `/healthz`); 250ms backoff; 5s sub-timeout per call | single envelope (default 30s, max 300000ms)  | `boot_failed_not_ready`, `boot_failed_port_conflict`                                 |
| 4. Verify    | `runVerifyDeploy({endpointUrl, phase_filter: "pre-merge"})`                                    | inherits from runVerifyDeploy                | `health_check_failed`, `no_routes_for_phase`                                         |
| 5. Teardown  | `execFile('pre-merge-teardown')` + SIGTERM-to-PGID + 5s grace + SIGKILL                        | configurable                                 | `teardown_failed`, `teardown_skipped`, `teardown_orphan_kill_failed`                 |

### Try/Finally Invariant (SEC-005)

`pre-merge-teardown` ALWAYS runs even on the exception path (verifier crash, SIGTERM, parser errors, unhandled rejections). Failure to invoke teardown is itself an NFR violation. The implementation wraps steps 1–4 in a try block and step 5 in the matching finally block.

### Process-Group Cleanup (NFR-17 + SEC-103)

The boot step spawns the consumer's process detached (own process group). Teardown issues SIGTERM-to-PGID, waits 5s, then SIGKILL. ESRCH (process already gone) is treated as success. On kill failure, the orchestrator emits `teardown_orphan_kill_failed` advisory; the next gate run detects port-conflict and emits `boot_failed_port_conflict`.

Containerized boots (per EDGE-013): process-group SIGTERM does NOT propagate to running containers. The consumer's `pre-merge-teardown` script is authoritative for container cleanup.

## URL Validation (DEC-005)

`validatePreMergeUrl` is a NEW helper in `pre-merge-verify.mjs`, distinct from `validateEndpointUrl` at `deployment-verify.mjs:136`. Per DEC-005:

| Validator                        | Scope                         | Allowed                                                                                                                                                                                                |
| -------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `validateEndpointUrl` (existing) | Post-deploy callers           | Public URLs (staging endpoints)                                                                                                                                                                        |
| `validatePreMergeUrl` (new)      | Pre-merge-verify callers ONLY | Loopback (127.0.0.0/8, ::1), RFC1918 (10/8, 172.16/12, 192.168/16), IPv6 unique-local (fc00::/7), link-local (fe80::/10); port > 1024 in ephemeral [49152..65535] OR `pre_merge_verify_port_allowlist` |

The two validators are intentionally separate to preserve post-deploy callers' freedom to use public URLs. Implementer MUST NOT extend or generalize `validateEndpointUrl` for pre-merge-verify use.

DNS rebinding defense (AC-8.2): the orchestrator uses the FIRST resolved IP for connection (single resolution; no second DNS lookup).

## Command Resolution (NFR-16 + SEC-102)

Commands are resolved strictly via the consumer's `package.json` `scripts` field:

- `execFile` with `--ignore-scripts` (no npm-lifecycle wrappers).
- Reject shell metacharacters in script values (defense against argv injection).
- NEVER `exec()` with `shell=true`.
- Missing-script-with-env-override emits `fixture_setup_failed_no_script`.

Subprocess imports come from `node:child_process` directly (matches existing pattern at `deployment-verify.mjs`). No wrapper module or DI seam at the import level — the test fixture seam (per DEC-007) abstracts at the subprocess-fixture level.

## Audit-Chain Integrity (NFR-22 + SEC-107)

The orchestrator emits one audit event per pipeline step (≈10 emissions per gate run including bracket/teardown advisories). Per DEC-006, emission goes through the in-process `recordAuditEvent` named export from `session-checkpoint.mjs` to avoid 10× CLI spawn per run.

Monotonicity:

- Bootstrap: `session.audit.next_seq = 0` (lazy on first `recordAuditEvent` call per DEC-009; pre-Item-B sessions are migrated lazily — no explicit migration step).
- First emission writes `audit_seq: 0` (no monotonicity assertion).
- Subsequent assertions: `new_seq === prior_seq + 1`.
- Non-monotonic detection emits `audit_chain_tamper_detected` and persists `status: failed, reason: audit_chain_tamper_detected`.

Operator recovery via `repair-audit-chain` CLI (resets `next_seq` to 0; clears tamper-failed result).

## Advisory Lock (NFR-24 + EDGE-016)

Lock at `.claude/coordination/pre-merge-verify.lock`:

- File format: `{pid: <int>, hostname: <string>, acquired_at: <ISO>}`.
- Open via `O_CREAT | O_EXCL` (TOCTOU-safe).
- Release in outermost try/finally.
- Staleness: `kill(pid, 0) === ESRCH` (process dead) OR `acquired_at` older than 60s (2× max step timeout).
- 30s acquisition timeout emits `pre_merge_verify_lock_timeout`.

The `clear-pre-merge-quarantine` CLI does NOT acquire the lock (state mutation is concurrency-safe via `saveSession`'s read-modify-write atomicity per spec § Advisory Clarifications #5).

## Quarantine Semantics (NFR-25)

On teardown failure, the orchestrator persists `session.pre_merge_verify.quarantine_until_acknowledged: true`. Subsequent gate dispatches detect this at NFR-26 step 3 and HALT immediately.

Auto-clears on:

- Subsequent successful teardown.

Manually clears via:

- `clear-pre-merge-quarantine <sg-id> --reason "..."` CLI.

The flag is preserved across `record-pre-merge-verify-result` writes — the orchestrator owns it; only `clear-pre-merge-quarantine` deletes it.

## Stop-Hook Composition (NFR-8 + AC-6.1..AC-6.6)

Per DEC-008: parallel try/catch boundary in `workflow-stop-enforcement.mjs`. Each block (deployment-verify and pre-merge-verify) has its own self-contained try/catch. Structural errors fail-open WITHIN that block (preMergeBlocked stays false on caught structural exception) and DO NOT affect the other block.

Decision rule on `session.pre_merge_verify.status`:

- `failed` → `preMergeBlocked = true`
- `passed` or `skipped` → `preMergeBlocked = false`
- Missing or non-string status → fail-open (`preMergeBlocked = false`)

Truth-table conjunction: `completionAllowed iff !deploymentBlocked && !preMergeBlocked`. When BOTH gates fail concurrently, both reasons appear in the Stop-hook output (AC-6.6) — no precedence.

≥2-emission gate: when `dispatch_infra_blocked_count[<dispatch_id>] >= 2` (counter shared with Item A's manual-tester), the Stop hook adds `pre_merge_verify_human_confirmation_required` to the block-reason output (parallel to Item A's `infra_blocked_human_confirmation_required` at `c018147`).

## INFRA_BLOCKED Bucket — Item A Reuse

Item B reuses Item A's (`sg-manual-tester-infra-blocked-20260508`, committed at `c018147`):

- `dispatch_infra_blocked_count` counter map at `session.active_work.dispatch_infra_blocked_count`.
- `opTransitionPhase` deletion logic at `session-checkpoint.mjs` (counter clears on phase transition out of `documenting`).
- Identical halt semantics: NO retry-once, terminal regardless of `runtime_validation_required`, structured trigger evidence in audit chain BEFORE halt.

The verifier `dispatch_id` is keyed into the same map; counter accumulates across halt-then-resume cycles within phase `documenting`.

## File-Protection Sentinel (AS-8)

`.claude/coordination/pre-merge-verify-enforcement-disabled` is added to `PROTECTED_FILENAMES` and `PROTECTED_FILE_DIRS` at `workflow-file-protection.mjs`. Path canonicalization via `path.resolve()` equality check; symlink, `..`, case-fold rejected per NFR-21+SEC-106. Both Write/Edit (write side) and Bash destructive verbs (delete side) are blocked. Only operator signed commits create/delete the sentinel under EDGE-019 carve-out.

## Spec Reference

See `.claude/specs/groups/sg-pre-merge-verify-20260508/spec.md` for the full contract.

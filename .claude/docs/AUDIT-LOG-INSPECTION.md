---
_source_modules:
  [
    'pipeline-efficiency-ws1-convergence-pruning',
    'pipeline-efficiency-ws2-practice-2.4',
    'pipeline-efficiency-ws3-orchestrator-hygiene',
  ]
---

# Audit Log Inspection Guide

How to verify chain integrity and interpret errors emitted by `verify-audit-chain.mjs` for the pipeline-efficiency hash-chained audit log.

## Files

| File                                             | Purpose                                           |
| ------------------------------------------------ | ------------------------------------------------- |
| `.claude/audit/pipeline-efficiency-genesis.json` | Seq=0 hash-chain root; signed via `git commit -S` |
| `.claude/audit/pipeline-efficiency-changes.log`  | JSONL append-only log, seq 1..N                   |
| `.claude/scripts/verify-audit-chain.mjs`         | Hash-chain verifier                               |

Chain linkage:

- `entry[seq=1].prev_hash = genesis.hash`
- `entry[seq=N>=2].prev_hash = SHA-256(canonicalJSON(entry[N-1]))`

## Verify Chain Integrity

```bash
node .claude/scripts/verify-audit-chain.mjs --include-rotations
```

Exit codes:

| Exit | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| `0`  | PASS. Genesis valid, signature verified, chain intact.     |
| `2`  | FAIL. Structured error on stderr (JSON single-line).       |
| `1`  | Unexpected error outside the structured-rejection surface. |

Flags:

- `--include-rotations`: walk `previous_genesis_hash` across rotation anchors
- `--genesis <path>`: override default genesis path
- `--log <path>`: override default log path
- `--skip-signature`: skip `git verify-commit` (test/CI without signing keys)
- `--json`: emit PASS/FAIL JSON on stdout

Success output (stderr):

```json
{
  "event": "audit_chain_verified",
  "result": "PASS",
  "timestamp": "2026-04-22T14:23:10.000Z",
  "genesis_path": ".claude/audit/pipeline-efficiency-genesis.json",
  "log_path": ".claude/audit/pipeline-efficiency-changes.log"
}
```

## Error Codes

### `CHAIN_BROKEN`

Hash linkage failure. An entry's `prev_hash` does not match `SHA-256(canonicalJSON(prior_entry))`.

Diagnostic shape:

```json
{
  "event": "audit_chain_verification_failed",
  "error_code": "CHAIN_BROKEN",
  "result": "FAIL",
  "broken_seq": 47,
  "detail": "entry seq=47 prev_hash does not match SHA-256 of entry seq=46",
  "genesis_path": "...",
  "log_path": "..."
}
```

Common causes:

- Manual edit to a log line (formatting change breaks canonical JSON)
- Concurrent writers corrupting append order
- Log replayed from backup with missing entries

Remediation:

1. Identify the broken sequence number.
2. Inspect entries around `broken_seq` with `sed -n "${N}p;$((N+1))p" .claude/audit/pipeline-efficiency-changes.log | jq`.
3. If manual edit: restore from git history via `git show <pre-edit-commit>:.claude/audit/pipeline-efficiency-changes.log`.
4. If corruption is isolated: rotate the chain (create new genesis with `previous_genesis_hash` linking to prior chain's HEAD). Out of scope for this document.

Blocks merge at completion-verifier gate per REQ-014.

### `GENESIS_ANCHOR_INVALID`

Genesis file missing, malformed JSON, or shape-invalid (missing `seq`, `hash`, `signed_by`, or `previous_genesis_hash`; `seq != 0`; `hash` not 64-char lowercase hex).

Diagnostic shape:

```json
{
  "event": "audit_chain_verification_failed",
  "error_code": "GENESIS_ANCHOR_INVALID",
  "result": "FAIL",
  "detail": "genesis.json missing required field 'hash'",
  "genesis_path": ".claude/audit/pipeline-efficiency-genesis.json"
}
```

Remediation:

1. Confirm file exists at `.claude/audit/pipeline-efficiency-genesis.json`.
2. Validate JSON: `jq . .claude/audit/pipeline-efficiency-genesis.json`.
3. Validate shape against `genesis.schema.mjs` (required fields: `seq: 0`, `hash`, `signed_by`, `previous_genesis_hash`).
4. If corrupted: restore from `git log -- .claude/audit/pipeline-efficiency-genesis.json` and revert to last signed good state.

Fallback: completion-verifier consumers treat this as `threshold_snapshot` fallback (REQ-014 spec.md:189-194).

ws-2 consumer note: `record-test-writer-unlock` runs a stricter content-canonical preflight (`genesis.hash === SHA256("")` on origin chain) before audit append. A failing preflight exits 2 with `GENESIS_ANCHOR_INVALID`, rejects the unlock entirely, and writes nothing to session.json. See `TEST-WRITER-UNLOCK-OPERATOR.md § Error Codes + Remediation`.

### `GENESIS_SIGNATURE_INVALID`

Genesis commit unsigned or signature verification failed. Operator-authorization semantic (NFR-6).

Diagnostic shape:

```json
{
  "error_code": "GENESIS_SIGNATURE_INVALID",
  "detail": "git verify-commit reports 'no signature'",
  "genesis_path": "..."
}
```

Remediation:

1. Locate the introducing commit: `git log --diff-filter=A --follow -- .claude/audit/pipeline-efficiency-genesis.json`.
2. Verify: `git verify-commit <sha>`.
3. If unsigned: create a quarantine file at `.claude/audit/pipeline-efficiency-genesis-quarantine.json`, recreate the genesis with a signed commit (`git commit -S`), and record the rotation in the audit log.

The verifier does NOT write quarantine files — detection only. Quarantine write is the consumer's responsibility (EDGE-020).

## Inspect Entries

Tail the log:

```bash
tail -5 .claude/audit/pipeline-efficiency-changes.log | jq
```

Filter by event class:

```bash
jq 'select(.event_class == "flag_flip")' .claude/audit/pipeline-efficiency-changes.log
```

Filter ws-2 test-writer-unlock events (any of 3 classes):

```bash
jq 'select(.event_class | startswith("test_writer_unlock"))' \
  .claude/audit/pipeline-efficiency-changes.log
```

Filter ws-3 orchestrator-hygiene events:

```bash
jq 'select(.event_class == "worktree_path_violation" or .event_class == "compute_hashes")' \
  .claude/audit/pipeline-efficiency-changes.log
```

Canonical 9 event classes:

| Event class                  | Emitted by                                                                |
| ---------------------------- | ------------------------------------------------------------------------- |
| `flag_flip`                  | Enforcement-flag mode change (incl. rejected preflight attempts)          |
| `test_writer_unlock`         | ws-2 test-writer unlock record (`record-test-writer-unlock` CLI)          |
| `test_writer_unlock_refence` | ws-2 test-writer unlock re-fence (5 triggers; spelling fixed by contract) |
| `test_writer_unlock_misuse`  | ws-2 test-writer unlock misuse heartbeat (Stop hook, advisory)            |
| `atomizer_cleanup`           | Atomizer cleanup event (ws-3: orchestrator-mediated gravestone-free)      |
| `session_override_flip`      | `override-enforcement` + `baseline_override_force_release`                |
| `worktree_path_violation`    | ws-3 worktree path violation (4 closed reasons; NFR-WORKTREE-CANON)       |
| `sentinel_lifecycle`         | Kill-switch create / remove                                               |
| `compute_hashes`             | ws-3 `compute-hashes.mjs --verify` invocation (post-impl → pre-unify)     |

Note: `test_writer_unlock_refence` spelling is contractually fixed. Do NOT rename to `reference`.

### ws-2 `test_writer_unlock` Event Class

Recorded by `session-checkpoint.mjs record-test-writer-unlock`. Marks a successful bug-fix-mode unlock record for a spec group.

Payload keys:

- `spec_group_id` — sg-id the unlock applies to
- `dispatch_id` — dispatch identifier recorded at unlock time
- `first_failure_ref` — reference to the first failing test run
- `first_failure_at` — ISO-8601 timestamp of first failing run
- `unlocked_until` — TTL expiry (ISO-8601, `first_failure_at + 5 min`)
- `operator_or_agent` — `process.env.USER` or `'agent'`

### ws-2 `test_writer_unlock_refence` Event Class

Recorded when any of 5 re-fence triggers clears an active unlock. Emitted via `emitTestWriterUnlockRefence` helper, consumed by both internal op\* transactions (spec-complete / test-pass / session-end) and the `fire-refence-trigger` CLI (version-bump / workstream-rotate).

Payload keys:

- `spec_group_id` — sg-id whose unlock was cleared
- `trigger` — one of `spec-complete | test-pass | version-bump | workstream-rotate | session-end`
- `dispatch_id` — dispatch-id of the cleared unlock (if known)
- `unlocked_until` — TTL of the cleared unlock (if known)
- `operator_or_agent` — `process.env.USER` or `'agent'`

### ws-2 `test_writer_unlock_misuse` Event Class

Advisory heartbeat emitted by the Stop hook when a test-writer hybrid-mode dispatch completes without creating or modifying test files (AC-005.9). Non-blocking — observability signal for review.

Payload keys:

- `spec_group_id` — sg-id the unlock was active on
- `dispatch_id` — dispatch-id that completed without new tests
- `first_failure_ref` — first-failure-ref from the active unlock
- `reason` — misuse subtype (default `no-new-tests`)
- `operator_or_agent` — `process.env.USER` or `'agent'`

See `TEST-WRITER-UNLOCK-OPERATOR.md` for operator procedures covering all three ws-2 event classes.

### ws-3 `worktree_path_violation` Event Class

Emitted by every `WORKTREE_PATH_VIOLATION` rejection across the 7 consumers (3 ws-1 hook retrofit + 4 ws-3 native). Closes SEC H2 by producing forensic visibility on every symlink escape / mid-session env-mutation / path-escape attempt. See `WORKTREE-CANON.md § Violation Reasons` for the full 4-reason enum.

Payload keys:

- `reason` — closed enum `symlink-component | path-escape | env-mutation | case-fs-mismatch`
- `attempted_path` — the path as received by the helper (pre-canonicalization)
- `pinned_root` — `session.active_work.project_dir_pin` at violation time
- `consumer` — short identifier of the consumer that raised the violation (e.g., `workflow-file-protection`, `workflow-dag`, `completion-verifier`)
- `session_id` — session that held the pin
- `operator_or_agent` — `process.env.USER` or `'agent'`

Forensic workflow:

```bash
# Last 10 violations with reason + consumer
jq 'select(.event_class == "worktree_path_violation") | {ts: .timestamp, reason: .payload.reason, consumer: .payload.consumer, attempted: .payload.attempted_path}' \
  .claude/audit/pipeline-efficiency-changes.log | tail -10
```

Emission is best-effort during the violation itself — the violation surfaces to the operator as exit 2 with the structured error regardless of audit-append success. On audit-append failure, a structured stderr warning is emitted.

### ws-3 `compute_hashes` Event Class

Emitted by every `.claude/scripts/compute-hashes.mjs --verify` invocation in the post-impl → pre-unify phase-transition hook (`workflow-dag.mjs` `runComputeHashesGate`). Emission sits in a `finally` block so the entry lands on every exit path — including lock timeout and drift.

Payload shape (AC15.4 canonical, 6 named fields):

```json
{
  "timestamp": "ISO8601",
  "event_class": "compute_hashes",
  "event_subtype": "verify-exit-<code>",
  "prev_hash": "<hex>",
  "payload": {
    "gate": "pre-unify",
    "spec_group_id": "sg-..." | null,
    "hashes_count": 351,
    "drift_detected": true | false,
    "exit_code": 0 | 1 | 2,
    "lock_wait_ms": 0,
    "fallback_applied": "none" | "retry-on-pre-lock-conflict"
  }
}
```

`event_subtype` format `verify-exit-<code>` (e.g., `verify-exit-0`, `verify-exit-1`, `verify-exit-2`) captures the exit code in the subtype while keeping the payload shape canonical.

Forensic workflow:

```bash
# Most recent drift-detected invocations
jq 'select(.event_class == "compute_hashes" and .payload.drift_detected == true) | {ts: .timestamp, sg: .payload.spec_group_id, exit: .payload.exit_code, lock_wait: .payload.lock_wait_ms}' \
  .claude/audit/pipeline-efficiency-changes.log

# Lock-contention signals (lock_wait_ms > 0)
jq 'select(.event_class == "compute_hashes" and .payload.lock_wait_ms > 0) | {ts: .timestamp, lock_wait: .payload.lock_wait_ms, fallback: .payload.fallback_applied}' \
  .claude/audit/pipeline-efficiency-changes.log
```

`fallback_applied` closed enum: `"none"` (normal path) or `"retry-on-pre-lock-conflict"` (pre-lock snapshot differed from post-lock; single re-run with fresh lock). `LockTimeoutError` (`COMPUTE_HASHES_LOCK_TIMEOUT`) and `COMPUTE_HASHES_DRIFT` both surface to the facilitator as exit code 2; the session aborts before the PostToolUse convergence-recorder fires, so no ritual clean-pass append contaminates the log on drift.

See `HOOKS.md § compute-hashes post-impl → pre-unify gate` for the full hook wiring, ordering-contract rationale, and advisory-lock mechanics.

## Forensic Walk Example

Walk the chain manually to audit a suspected tamper:

```bash
for seq in 1 2 3 4 5; do
  line=$(sed -n "${seq}p" .claude/audit/pipeline-efficiency-changes.log)
  echo "seq=$seq: $(echo "$line" | jq -c '{seq, event_class, prev_hash, timestamp}')"
done
```

Compare `prev_hash[N]` to `SHA-256(canonicalJSON(entry[N-1]))` manually if verifier flags a specific sequence.

## When to Verify

Hook call sites already invoke the verifier at:

- `completion-verifier` gate (as-022 F4)
- Every baseline-publication gate trip
- Session start (advisory, via spawn-first dispatcher as-006)

Operator-initiated verification recommended:

- After any manual audit-log edit (never do this)
- After rotation-anchor addition
- Weekly spot check during 90-day monitoring window (REQ-010)

## See Also

- `PIPELINE-EFFICIENCY-OPERATOR-RUNBOOK.md` — enforcement-primitive procedures (incl. ws-3 surfaces)
- `WORKTREE-CANON.md` — ws-3 worktree-canon operator guide (4 violation reasons, 7-consumer wiring, SEC H2 closure)
- `TEST-WRITER-UNLOCK-OPERATOR.md` — ws-2 unlock CLIs + error codes + HMAC secret
- `HOOKS.md § compute-hashes post-impl → pre-unify gate` — ws-3 compute-hashes advisory lock + ordering contract
- `.claude/scripts/verify-audit-chain.mjs` — verifier source
- `.claude/scripts/pipeline-efficiency-audit-log.mjs` — appender + event-class schema
- `.claude/scripts/lib/schemas/audit-entry.schema.mjs` — entry Zod schema

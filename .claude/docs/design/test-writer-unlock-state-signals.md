<!-- design-doc-id: test-writer-unlock-state-signals -->
<!-- status: current-contract -->
<!-- date: 2026-04-28 -->

# test_writer_unlock State Signals

Current contract for the bug-fix hybrid-mode test-writer unlock. This doc owns
state shape and safety invariants. Operator commands and remediation steps live
in [TEST-WRITER-UNLOCK-OPERATOR.md](../TEST-WRITER-UNLOCK-OPERATOR.md).

## Scope

`test_writer_unlock` is a narrow exception to strict test-writer isolation. It
allows a follow-up `test-writer` dispatch to read implementation files only
after the first strict-mode failing test has been produced for a bug-fix spec.

It does not apply to:

- `e2e-test-writer`
- feature-mode or refactor-mode specs
- manual probes, smoke tests, or dev tests
- implementation agents

## Storage And Ownership

Unlock entries live under:

```text
session.json.active_work.test_writer_unlock[<spec-group-id>]
```

Only `session-checkpoint.mjs` may create, update, or clear this map. Direct
agent writes to `session.json`, the unlock map, or the HMAC secret are blocked
by `workflow-file-protection.mjs`.

## Entry Shape

```yaml
TestWriterUnlockEntry:
  spec_group_id: string
  first_failure_at: string # ISO-8601 UTC timestamp
  unlocked_until: string # first_failure_at + 5 minutes
  dispatch_id: string
  marker: string # HMAC-SHA256 marker
```

All fields are required. Missing or malformed fields fail closed.

## State Machine

| State | Meaning |
| --- | --- |
| `Fenced` | No active unlock entry exists. Strict isolation applies. |
| `Eligible` | The spec is `bug-fix` and the first strict-mode failing test exists. |
| `Unlocked` | Entry exists, TTL is unexpired, dispatch id matches, and marker verifies. |
| `Expiring` | Entry exists but the TTL has elapsed; the next check fails. |

Allowed transitions:

```text
Fenced -> Eligible
  when manifest.spec_mode == "bug-fix" and the first failing run exists

Eligible -> Unlocked
  when record-test-writer-unlock succeeds

Unlocked -> Fenced
  when any re-fence trigger clears the entry

Unlocked -> Expiring -> Fenced
  when TTL expires and the cooperative check rejects the read
```

Feature-mode and refactor-mode specs stay fenced. The record CLI rejects them
with `UNLOCK_MODE_MISMATCH`.

## TTL

The unlock window is exactly 5 minutes:

```text
unlocked_until = first_failure_at + 5 minutes
```

The timestamp is anchored once at record time and is not recomputed during
cooperative checks.

## Marker Protocol

`record-test-writer-unlock` mints the marker with HMAC-SHA256 over the unlock
inputs and a per-session secret:

```text
spec_group_id || dispatch_id || first_failure_ref || unlocked_until
```

The secret lives at:

```text
.claude/coordination/.session-hmac-<session-id>
```

The secret is mode `0600`, gitignored, and write-protected from agents. Marker
verification uses constant-time comparison. A visible marker in `session.json`
does not allow forgery without the secret.

## Re-Fence Triggers

These triggers clear `active_work.test_writer_unlock[<spec-group-id>]` through
the sole-writer path and append `test_writer_unlock_refence` to the pipeline
efficiency audit log:

| Trigger | Source signal |
| --- | --- |
| `spec-complete` | `manifest.review_state` transitions to `APPROVED` |
| `test-pass` | Unifier records the first green test pass for the spec group |
| `version-bump` | `spec.md` date or content hash changes during an unlock window |
| `workstream-rotate` | Facilitator rotation fires for the spec group |
| `session-end` | `complete-work` or `archive-incomplete` runs |

Trigger handling is idempotent. If no unlock exists, the trigger is a no-op.
All clear operations serialize through `session-checkpoint.mjs`.

## Cooperative Check

Every implementation-file read by a potentially unlocked `test-writer` dispatch
runs this ordered check:

1. Atomic-read `session.json.active_work.test_writer_unlock[<spec-group-id>]`.
2. Require `unlocked_until > now()`.
3. Require `dispatch_id` to match the current dispatch.
4. Verify the HMAC marker with `crypto.timingSafeEqual`.
5. Permit the read only when every prior step passes.

Any failure emits `UNLOCK_REVOKED` and blocks the read. A second consecutive
failure emits `TIMEOUT`; the test-writer returns to fenced behavior for the
remainder of the dispatch. Already permitted reads are not revoked
retroactively.

## Error Codes

| Code | Surface | Meaning |
| --- | --- | --- |
| `UNLOCK_MODE_MISMATCH` | Record CLI | Spec is not `bug-fix`; no session write. |
| `UNLOCK_REVOKED` | PreToolUse check | Entry absent, expired, mismatched, unreadable, or marker-invalid. |
| `TIMEOUT` | PreToolUse check | Retry after `UNLOCK_REVOKED` also failed. |
| `GENESIS_ANCHOR_INVALID` | Record CLI | Audit-chain genesis anchor is missing or invalid. |
| `CHAIN_BROKEN` | Audit chain | Hash-chain append or verification failed. |

## Audit Events

All events append to `.claude/audit/pipeline-efficiency-changes.log`.

| Event class | Emitted by | Purpose |
| --- | --- | --- |
| `test_writer_unlock` | `record-test-writer-unlock` | Records an unlock window. |
| `test_writer_unlock_refence` | re-fence trigger path | Records that an unlock was cleared. |
| `test_writer_unlock_misuse` | Stop hook | Advisory signal: an unlock was used but no test file changed. |

The `refence` spelling is contractually fixed. Do not rename it to
`reference`.

## Invariants

- The first failing test run must happen in strict mode.
- Hybrid mode must produce or modify tests; otherwise the Stop hook emits the
  advisory misuse heartbeat.
- The unlock map and HMAC secret are sole-writer resources owned by
  `session-checkpoint.mjs`.
- `e2e-test-writer` remains strict black-box even when a spec is `bug-fix`.
- Feature-mode and refactor-mode specs cannot unlock.

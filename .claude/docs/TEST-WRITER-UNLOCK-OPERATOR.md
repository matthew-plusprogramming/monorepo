---
_source_modules: ['pipeline-efficiency-ws2-practice-2.4']
---

# Test-Writer Unlock Operator Guide

Operator interaction guide for the bug-fix-mode hybrid test-writer flow shipped in `sg-pipeline-efficiency-ws2-practice-2.4`. Covers `record-test-writer-unlock` + `fire-refence-trigger` CLIs, the 5 re-fence triggers, HMAC session-secret lifecycle, audit-log event classes, and error-code remediation.

## Quick Reference

| Primitive               | Path / Command                                                                                          | Scope            | Effect                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `spec_mode` frontmatter | `manifest.json.spec_mode ∈ {feature, bug-fix, refactor}` (default `feature`)                            | Per spec group   | Positive signal for hybrid-mode eligibility; fail-closed default.                                                 |
| Record CLI              | `session-checkpoint.mjs record-test-writer-unlock <sg-id> --dispatch-id <id> --first-failure-ref <ref>` | Per session      | Sole-writer for `session.json.active_work.test_writer_unlock[<sg-id>]`; appends `test_writer_unlock` audit entry. |
| Re-fence CLI            | `session-checkpoint.mjs fire-refence-trigger <sg-id> --trigger <label>`                                 | Per session      | External-signal entry for `version-bump` / `workstream-rotate`. Other triggers fire internally.                   |
| HMAC session secret     | `.claude/coordination/.session-hmac-<session-id>` (mode `0600`, `.gitignored`)                          | Per session      | Keys the HMAC-SHA256 marker verified by the PreToolUse hook.                                                      |
| Unlock TTL              | 5 minutes (anchored at `first_failure_at`)                                                              | Per unlock entry | `unlocked_until = first_failure_at + 5 min`.                                                                      |
| Audit event classes     | `test_writer_unlock`, `test_writer_unlock_refence`, `test_writer_unlock_misuse`                         | Hash chain       | Appended to `.claude/audit/pipeline-efficiency-changes.log`.                                                      |

## When to Unlock

Bug-fix mode only. Feature-mode specs retain strict isolation.

Use the unlock when:

- `manifest.json.spec_mode == "bug-fix"` for the spec group.
- The test-writer has produced at least one failing test run in strict-isolation mode (the first run establishes the pre-fix contract).
- A follow-up test-writer dispatch would benefit from implementation-file reads to refine the failing test against the fix.

Do NOT unlock when:

- `spec_mode` is absent, `feature`, or `refactor` (CLI rejects with `UNLOCK_MODE_MISMATCH`).
- No failing run has been produced — the first run is contract-definitional and MUST happen in strict mode.
- The work is an e2e-test-writer dispatch — e2e is always strict-black-box; `test_writer_unlock` does NOT apply to e2e.

## Record an Unlock

```bash
node .claude/scripts/session-checkpoint.mjs record-test-writer-unlock \
  <sg-id> \
  --dispatch-id <dispatch-id> \
  --first-failure-ref <first-failure-ref>
```

Preflight sequence (all fail-closed):

1. Validate `sg-id` shape (no path-traversal).
2. Load manifest; reject if `spec_mode != "bug-fix"` with `UNLOCK_MODE_MISMATCH`.
3. Verify hash-chain genesis anchor (`genesis.hash === SHA256("")` for origin chain). Missing / malformed / shape-invalid / content-corrupted → `GENESIS_ANCHOR_INVALID`.
4. Read or bootstrap per-session HMAC secret (see HMAC Secret Lifecycle below).
5. Mint HMAC-SHA256 marker over `<sg-id> || <dispatch-id> || <first-failure-ref> || <unlocked_until>`.
6. Append `test_writer_unlock` audit entry BEFORE session.json mutation.
7. Write `session.json.active_work.test_writer_unlock[<sg-id>] = { first_failure_at, unlocked_until, dispatch_id, marker }`.

Expected output (stdout JSON):

```json
{
  "ok": true,
  "spec_group_id": "sg-example-bug-fix",
  "first_failure_at": "2026-04-23T10:15:00.000Z",
  "unlocked_until": "2026-04-23T10:20:00.000Z",
  "dispatch_id": "dispatch-abc123",
  "audit_seq": 142
}
```

Expected stderr: `test-writer-unlock recorded: <sg-id> unlocked_until=<iso> dispatch_id=<id>`.

Exit codes:

| Exit | Condition                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Success                                                                                                                                                                  |
| `1`  | Validation / operational error (`UNLOCK_MODE_MISMATCH`, `UNLOCK_AUDIT_APPEND_FAILED`, `UNLOCK_HMAC_SECRET_ERROR`, `UNLOCK_MARKER_MINT_FAILED`, manifest missing/corrupt) |
| `2`  | `GENESIS_ANCHOR_INVALID` — hash-chain origin anchor is broken; resolve before retry                                                                                      |

## How Unlocks End (5 Re-Fence Triggers)

Every unlock clears on exactly one of 5 canonical triggers (`REFENCE_TRIGGERS` enum in `session-checkpoint.mjs:3633`):

| Trigger             | Fired by                                               | Entry point                                                        |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| `spec-complete`     | `manifest.review_state` transitions to `APPROVED`      | Internal (inside `opTransitionPhase` transaction)                  |
| `test-pass`         | First green unifier convergence pass on the spec group | Internal (inside `opUpdateConvergence` transaction)                |
| `version-bump`      | `spec.md` date / content_hash change detected          | External — operator invokes `fire-refence-trigger`                 |
| `workstream-rotate` | Facilitator rotation hook fires                        | External — operator invokes `fire-refence-trigger`                 |
| `session-end`       | `complete-work` or `archive-incomplete`                | Internal (inside opCompleteWork / opArchiveIncomplete transaction) |

Each trigger:

1. Appends `test_writer_unlock_refence` audit entry with `trigger` field.
2. Deletes `session.json.active_work.test_writer_unlock[<sg-id>]` via the sole-writer path.

Ordering: audit append BEFORE session mutation. On `test_writer_unlock_refence` append failure, the entry stays intact so the next clear attempt succeeds.

### Manual `fire-refence-trigger`

Only needed for `version-bump` and `workstream-rotate`. Other triggers fire inside their owning op\* transactions.

```bash
node .claude/scripts/session-checkpoint.mjs fire-refence-trigger \
  <sg-id> \
  --trigger <version-bump|workstream-rotate>
```

Idempotent — exits 0 with `{ ok: true, cleared: false, audit_seq: null }` when no unlock entry exists.

Expected output on clear:

```json
{
  "ok": true,
  "cleared": true,
  "spec_group_id": "sg-example-bug-fix",
  "trigger": "version-bump",
  "audit_seq": 153
}
```

Error codes:

| Code                          | Cause                                                             |
| ----------------------------- | ----------------------------------------------------------------- |
| `REFENCE_USAGE_ERROR`         | Missing `<sg-id>` or `--trigger`                                  |
| `REFENCE_TRIGGER_INVALID`     | Trigger not in canonical 5-label enum                             |
| `REFENCE_SESSION_MISSING`     | No `session.json`; run `init` first                               |
| `REFENCE_AUDIT_APPEND_FAILED` | Audit chain write failed; unlock NOT cleared (retry after repair) |

## Error Codes + Remediation

| Code                         | Surface                               | Remediation                                                                                                                |
| ---------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `UNLOCK_MODE_MISMATCH`       | `record-test-writer-unlock` preflight | Confirm `manifest.json.spec_mode == "bug-fix"`. Feature / refactor specs cannot unlock.                                    |
| `UNLOCK_REVOKED`             | PreToolUse cooperative-check hook     | TTL expired OR `dispatch_id` mismatch OR marker invalid. Re-record if still within valid bug-fix window.                   |
| `TIMEOUT`                    | PreToolUse cooperative-check hook     | Retry after `UNLOCK_REVOKED` also failed; test-writer reverts to fenced mode. No operator action.                          |
| `GENESIS_ANCHOR_INVALID`     | `record-test-writer-unlock` exit 2    | Repair `.claude/audit/pipeline-efficiency-genesis.json` (see `AUDIT-LOG-INSPECTION.md § GENESIS_ANCHOR_INVALID`).          |
| `CHAIN_BROKEN`               | `verify-audit-chain.mjs`              | See `AUDIT-LOG-INSPECTION.md § CHAIN_BROKEN` for chain-repair procedure.                                                   |
| `UNLOCK_HMAC_SECRET_ERROR`   | `record-test-writer-unlock` bootstrap | Inspect `.claude/coordination/.session-hmac-<session-id>` (mode, size). Delete + retry if corrupted; next run regenerates. |
| `UNLOCK_AUDIT_APPEND_FAILED` | `record-test-writer-unlock` exit 1    | Check stderr `underlying_code`; fix underlying audit error; retry.                                                         |
| `UNLOCK_MARKER_MINT_FAILED`  | `record-test-writer-unlock` exit 1    | HMAC crypto failure. Inspect stderr; usually indicates missing Node crypto module or stub misconfig.                       |
| `UNLOCK_MANIFEST_MISSING`    | `record-test-writer-unlock` preflight | Verify `<sg-id>` spelling. Manifest must exist at `.claude/specs/groups/<sg-id>/manifest.json`.                            |
| `UNLOCK_MANIFEST_CORRUPT`    | `record-test-writer-unlock` preflight | Manifest JSON is unreadable. Restore from `git log` and re-run.                                                            |

## Audit Log Entries

Three event classes added by ws-2 (all in canonical 9-class enum):

### `test_writer_unlock`

Emitted by `record-test-writer-unlock` on successful record.

Payload shape:

```json
{
  "seq": 142,
  "prev_hash": "...",
  "timestamp": "2026-04-23T10:15:00.000Z",
  "event_class": "test_writer_unlock",
  "event_type": "cli-record-unlock",
  "spec_group_id": "sg-example-bug-fix",
  "dispatch_id": "dispatch-abc123",
  "first_failure_ref": "ref-xyz789",
  "first_failure_at": "2026-04-23T10:15:00.000Z",
  "unlocked_until": "2026-04-23T10:20:00.000Z",
  "operator_or_agent": "matthewlin"
}
```

### `test_writer_unlock_refence`

Emitted by `fire-refence-trigger` and internal re-fence call sites when an unlock clears. Note: spelling `refence` is contractually fixed; do NOT rename to `reference`.

Payload shape:

```json
{
  "seq": 153,
  "prev_hash": "...",
  "timestamp": "2026-04-23T10:18:30.000Z",
  "event_class": "test_writer_unlock_refence",
  "event_type": "refence-version-bump",
  "spec_group_id": "sg-example-bug-fix",
  "trigger": "version-bump",
  "dispatch_id": "dispatch-abc123",
  "unlocked_until": "2026-04-23T10:20:00.000Z",
  "operator_or_agent": "matthewlin"
}
```

### `test_writer_unlock_misuse`

Emitted by the Stop hook when a hybrid-mode dispatch completes WITHOUT creating or modifying test files (misuse heartbeat, AC-005.9). Advisory only — non-blocking.

Payload shape:

```json
{
  "seq": 161,
  "prev_hash": "...",
  "timestamp": "2026-04-23T10:19:45.000Z",
  "event_class": "test_writer_unlock_misuse",
  "event_type": "misuse-no-new-tests",
  "spec_group_id": "sg-example-bug-fix",
  "dispatch_id": "dispatch-abc123",
  "first_failure_ref": "ref-xyz789",
  "reason": "no-new-tests",
  "operator_or_agent": "matthewlin"
}
```

Inspect:

```bash
jq 'select(.event_class | startswith("test_writer_unlock"))' \
  .claude/audit/pipeline-efficiency-changes.log
```

See `AUDIT-LOG-INSPECTION.md` for full chain-verification and 9-class event enum.

## HMAC Secret Lifecycle

Per-session HMAC-SHA256 key stored at `.claude/coordination/.session-hmac-<session-id>`. Keys the marker verified by the PreToolUse cooperative-check hook.

Properties:

- **Path**: `.claude/coordination/.session-hmac-<session-id>` (leading dot → hidden).
- **Permissions**: `0600` (owner read/write only).
- **Contents**: 32 random bytes (`crypto.randomBytes(32)`); 256-bit key.
- **Gitignored**: never committed. Accumulates per session-id on local filesystem.
- **FULL_BLOCK**: path basename pattern `^\.session-hmac-.+$` registered in `workflow-file-protection.mjs`; agents cannot Write / Edit / Delete directly — only `session-checkpoint.mjs` may.

Bootstrap (current ship — inline on first unlock record):

- First `record-test-writer-unlock` call in a session generates the secret via `O_EXCL`-create with mode `0600`.
- Concurrent dispatchers race safely: bounded 3-attempt retry loop; exactly one writer wins.
- Subsequent reads are atomic (single `readFileSync`).

Teardown (deferred — Task 4b M1 follow-up):

- `close-work` teardown not wired in this ship. Secrets persist per session-id across sessions until manually cleaned. This is intentional per `M1 hmac_lifecycle_deferred` decision log entry (2026-04-25).
- Secrets are `.gitignored` so no commit-leakage risk.
- Manual cleanup: delete `.claude/coordination/.session-hmac-*` after confirming no active sessions reference the IDs.

Rotation: per-session only. Next session generates a new secret; prior-session HMAC markers cannot verify against the new key.

## Test-Writer Cooperative-Check Hook

`test-writer-isolation-enforcement.mjs` (PreToolUse) runs 5 gates on every implementation-file read attempt during a test-writer dispatch:

1. Atomic-read `session.json.active_work.test_writer_unlock[<sg-id>]` (lstat + realpath + O_NOFOLLOW).
2. Check `unlocked_until > now()`.
3. Check `dispatch_id` matches current dispatch.
4. Verify HMAC-SHA256 marker against the session-HMAC secret (constant-time compare).
5. If all pass → `PERMITTED`; any fail → `UNLOCK_REVOKED`. Retry → `TIMEOUT` → fenced-mode revert for remainder of dispatch.

Fail-closed defaults:

- `session.json` unreadable → block read.
- Unlock entry absent → block read.
- `spec_mode != "bug-fix"` → block read.
- HMAC secret missing → block read (`UNLOCK_HMAC_SECRET_ERROR`).

Propagation SLA: <1s per cooperative-check per SEC-003 Pass 3.

## Worktree Sentinel Visibility Caveat

The kill-switch sentinel at `.claude/coordination/pipeline-efficiency-disabled` is git-tracked on main. If an operator creates the sentinel on main during an active ws-2 worktree run, the ws-2 worktree branch will NOT see it unless the operator rebases the worktree onto main.

Options to halt ws-2 mid-flight:

1. Create sentinel on main AND rebase ws-2 worktree onto main (propagates sentinel file).
2. Use `session-checkpoint.mjs override-enforcement advisory` to coerce the ws-2 session — note this only scopes to `advisory ↔ coercive` (NOT `off`).

Effective kill of ws-2 audit-log appends (`test_writer_unlock`, `test_writer_unlock_refence`, `test_writer_unlock_misuse`) REQUIRES rebase propagation.

## See Also

- `PIPELINE-EFFICIENCY-OPERATOR-RUNBOOK.md` — enforcement-flag + kill-switch + audit-chain overview
- `AUDIT-LOG-INSPECTION.md` — hash-chain verification, 9 canonical event classes, error-code remediation
- `BASELINE-LIFECYCLE.md` — ws-2 baseline accumulation + coercive-flip preflight
- `SESSION-OVERRIDE-CLI.md` — `override-enforcement` usage reference
- `THRESHOLD-TUNING.md` — per-gate thresholds + BIZ-002 minimum-pruning floor
- `.claude/memory-bank/testing.guidelines.md § Bug-Fix Hybrid Mode` — test-writer agent guidance
- `.claude/specs/groups/sg-pipeline-efficiency-ws2-practice-2.4/spec.md` — authoritative spec

# CLI Reference: Pre-Merge-Verify Subcommands

This reference documents the five `session-checkpoint.mjs` CLI subcommands added by `sg-pre-merge-verify-20260508` AS-6.

All five subcommands route through `saveSession` for atomic write per NFR-2 (sole-writer invariant). The first three (`record-pre-merge-verify-result`, `clear-pre-merge-quarantine`, `record-audit-event`) are normal write paths. `repair-audit-chain` is an operator escape hatch for `audit_chain_tamper_detected` recovery. `validate-pre-merge-verify-config` is a TECH-104 Zod-style validator at gate-start.

## `record-pre-merge-verify-result`

**Sole-writer for `session.pre_merge_verify`** (the discriminated-union schema added in AS-6).

```
node .claude/scripts/session-checkpoint.mjs record-pre-merge-verify-result <sg-id> \
  --status <passed|failed|skipped> \
  --reason <enum-from-NFR-12|null> \
  [--evidence-path <path>] \
  [--dispatch-id <id>] \
  [--audit-seq <int>] \
  [--cumulative-ms <int>]
```

### Flags

| Flag              | Required                                                        | Notes                                                                        |
| ----------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `<sg-id>`         | Yes                                                             | Positional; must match `session.active_work.spec_group_id`                   |
| `--status`        | Yes                                                             | One of `passed`, `failed`, `skipped`                                         |
| `--reason`        | Yes when `--status failed`; optional otherwise (or pass `null`) | Closed 22-value enum (REQ-007 / NFR-12)                                      |
| `--evidence-path` | No                                                              | Project-relative; must remain under `.claude/specs/groups/<sg-id>/evidence/` |
| `--dispatch-id`   | No                                                              | Verifier dispatch_id (free-form opaque string); counter-map key              |
| `--audit-seq`     | No                                                              | Non-negative integer; monotonic anchor                                       |
| `--cumulative-ms` | No                                                              | Non-negative integer; cumulative wall-clock for the gate run                 |

### Validation

- `status` must be in `{passed, failed, skipped}`.
- `reason` MUST be in the closed 22-value enum or `null`. Future values require PRD amendment (NFR-12).
- `status === 'failed'` requires non-null `--reason`.
- `--evidence-path` is canonicalized via `normalizeManualTestEvidencePath`; symlink/`..` traversal rejected.
- Quarantine flag (when present) is preserved across writes — `clear-pre-merge-quarantine` is the sole clear path.

### Side Effects

- Writes `session.pre_merge_verify` (atomic via `saveSession`).
- Appends `pre_merge_verify_recorded` history entry.
- Appends mirrored `decision_log` entry to the spec group's `manifest.json`.
- Echoes the recorded record as JSON on stdout.

## `clear-pre-merge-quarantine`

**Operator escape hatch** for clearing the `quarantine_until_acknowledged` flag set on teardown failure (NFR-25).

```
node .claude/scripts/session-checkpoint.mjs clear-pre-merge-quarantine <sg-id> \
  [--reason "<text>"]
```

### Flags

| Flag       | Required                         | Notes                                                      |
| ---------- | -------------------------------- | ---------------------------------------------------------- |
| `<sg-id>`  | Yes                              | Positional; must match `session.active_work.spec_group_id` |
| `--reason` | No (warning emitted when absent) | Resolution narrative for audit chain                       |

### Behavior

- Idempotent: invoking on a session without `quarantine_until_acknowledged === true` is a no-op for state but still records the audit-chain entry.
- Atomically deletes `session.pre_merge_verify.quarantine_until_acknowledged` (single `saveSession` write).
- Appends `pre_merge_verify_quarantine_cleared` history entry + manifest decision_log entry.

### Lock Coordination

This CLI does NOT acquire the advisory lock at `.claude/coordination/pre-merge-verify.lock`. If a gate run is genuinely in-flight, the operator should wait for it to complete (the orchestrator's lock release is handled in its outermost try/finally). Per spec § Advisory Clarifications #5: state mutation is concurrency-safe because `saveSession` is read-modify-write atomic.

## `record-audit-event`

**Atomic monotonic audit-chain emission** (DEC-006). Routes through the same logic as the named export `recordAuditEvent` used in-process by the AS-5 orchestrator.

```
node .claude/scripts/session-checkpoint.mjs record-audit-event <event-name> \
  [--payload '<json>']
```

### Flags

| Flag           | Required | Notes                                   |
| -------------- | -------- | --------------------------------------- |
| `<event-name>` | Yes      | Positional; non-empty string identifier |
| `--payload`    | No       | JSON object string                      |

### Behavior

- Lazily bootstraps `session.audit = {next_seq: 0}` on first call (DEC-009; pre-Item-B sessions are migrated lazily — no explicit migration step).
- First emission writes `audit_seq: 0` (no monotonicity assertion).
- Subsequent assertions: `new_seq === prior_seq + 1`. Non-monotonic detection emits `audit_chain_tamper_detected`.
- Returns `{audit_seq, recorded_at}` to the caller (and to stdout for CLI invocations).

### In-Process Use

The orchestrator imports the named export to avoid 10× CLI spawn per gate run:

```javascript
import { recordAuditEvent } from '.claude/scripts/session-checkpoint.mjs';
const { audit_seq, recorded_at } = recordAuditEvent({
  eventName: 'pre_merge_verify_step_start',
  payload: { step: 'setup', dispatch_id: '<id>' },
});
```

## `repair-audit-chain`

**Operator recovery** for `audit_chain_tamper_detected` (AC-9.7).

```
node .claude/scripts/session-checkpoint.mjs repair-audit-chain <sg-id> \
  [--reason "<text>"]
```

### Flags

| Flag       | Required                         | Notes                                                      |
| ---------- | -------------------------------- | ---------------------------------------------------------- |
| `<sg-id>`  | Yes                              | Positional; must match `session.active_work.spec_group_id` |
| `--reason` | No (warning emitted when absent) | Recovery narrative for audit chain                         |

### Behavior

- Resets `session.audit = {next_seq: 0}`.
- Clears any `pre_merge_verify` result whose `reason === 'audit_chain_tamper_detected'` (so the next gate run is not blocked by stale tamper-failed state).
- Does NOT clear `quarantine_until_acknowledged` — operator must run `clear-pre-merge-quarantine` separately if needed.
- Appends `audit_chain_repaired` history entry + manifest decision_log entry.

## `validate-pre-merge-verify-config`

**TECH-104 Zod-style validator** for the consumer's `package.json` pre-merge-verify config fields. Run at gate-start; failure halts the gate before any pipeline step.

```
node .claude/scripts/session-checkpoint.mjs validate-pre-merge-verify-config <path-to-package.json>
```

### Validates

| Field                             | Rule                                                | Failure Reason           |
| --------------------------------- | --------------------------------------------------- | ------------------------ |
| `pre_merge_verify_timeout_ms`     | Optional integer; `> 0`; `<= 300000` (5 min)        | `config_invalid_timeout` |
| `pre_merge_verify_port_allowlist` | Optional array of integers; each in `(1024, 65535]` | `config_invalid`         |
| `pre_merge_readiness_path`        | Optional string; must start with `/`                | `config_invalid`         |

### Exit Codes

- `0` — config valid; stdout JSON `{valid: true, ...}` echoes the canonicalized values.
- `1` — config invalid; stderr lists each error; stdout JSON `{valid: false, errors: [...], package_json_path: <abs>}`.

### Example

```
$ node .claude/scripts/session-checkpoint.mjs validate-pre-merge-verify-config ./package.json
{
  "valid": true,
  "package_json_path": "/abs/path/package.json",
  "pre_merge_verify_timeout_ms": 60000,
  "pre_merge_verify_port_allowlist": [4000, 5000],
  "pre_merge_readiness_path": "/healthz"
}
```

## Spec Reference

See `.claude/specs/groups/sg-pre-merge-verify-20260508/spec.md` AS-6 for the full contract.

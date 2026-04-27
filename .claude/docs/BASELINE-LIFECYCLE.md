---
_source_modules: ['pipeline-efficiency-ws1-convergence-pruning']
---

# Baseline Publication Lifecycle

How per-workstream baselines accrue post-ship, how they gate the advisory→coercive transition, and how to override rejections.

## Baseline Types

| Type            | Path                                                          | Purpose                                   |
| --------------- | ------------------------------------------------------------- | ----------------------------------------- |
| Per-gate        | `.claude/metrics/pipeline-efficiency-<gate>-baseline.json`    | Gate-level false-positive / catch metrics |
| Per-workstream  | `.claude/metrics/pipeline-efficiency-ws{1,2,3}-baseline.json` | Workstream-level aggregated metrics       |
| Per-ws override | `.claude/metrics/<workstream-id>-baseline-override.json`      | Per-workstream rationale override         |

Only per-workstream baselines gate the coercive flip. Per-gate baselines feed `threshold-decisions.md` rationale.

## Schema

Defined in `.claude/scripts/lib/schemas/baseline.schema.mjs`.

```json
{
  "gate_name": "unifier",
  "false_positive_rate": 0.12,
  "catch_rate": 0.88,
  "sample_count": 15,
  "measurement_window_start": "2026-04-22T00:00:00.000Z",
  "measurement_window_end": "2026-05-22T00:00:00.000Z",
  "published_at": "2026-05-22T12:00:00.000Z",
  "operator": "matthewlin"
}
```

Sufficiency (REQ-011):

- `sample_count >= 10` OR `measurement_window_end - measurement_window_start >= 30 days`
- Both rates in `[0, 1]`
- ISO-8601 timestamps (UTC or `±HH:MM` offset)

Override schema:

```json
{
  "workstream_id": "ws-2",
  "rationale": "<non-empty justification>",
  "operator": "matthewlin",
  "effective_at": "2026-04-22T12:00:00.000Z"
}
```

## Advisory Phase

Default post-ship state. Gates emit findings; no merge block. Baselines accrue passively:

1. Each workstream run appends a measurement to the per-gate metric stream.
2. Operator publishes the aggregated baseline via the ws-1 metrics publisher (`pipeline-efficiency-ws1-metrics-publisher.mjs`) to `.claude/metrics/pipeline-efficiency-ws{N}-baseline.json`.
3. Baselines update `sample_count` and `measurement_window_end` on each publish.

Minimum advisory duration: 10 workstreams OR 30 days (whichever first) before coercive flip permitted.

## Coercive Flip Preflight

3-workstream gate: all of ws-1, ws-2, ws-3 baselines must be present, schema-valid, and sample-size-sufficient.

```bash
node .claude/scripts/pipeline-efficiency-coercive-flip-preflight.mjs
```

Atomic reads:

1. Kill-switch sentinel presence check
2. Enforcement-flag read + validation
3. Audit-log HEAD read
4. 3-way baseline read with fstat-stability probe (AC17.6)
5. Baseline schema + sufficiency validation per baseline

Exit codes:

| Exit | Outcome                                                                |
| ---- | ---------------------------------------------------------------------- |
| `0`  | ACCEPTED. All preconditions met. Operator may edit flag to `coercive`. |
| `2`  | REJECTED. Structured error on stderr.                                  |
| `1`  | Unexpected runtime error outside structured-rejection surface.         |

Every rejection appends a `flag_flip` audit entry with `rejected: true`. Intent is captured even when state does not change.

## Rejection Error Codes

| Error code                  | Meaning                                                  | Remediation                               |
| --------------------------- | -------------------------------------------------------- | ----------------------------------------- |
| `SENTINEL_ACTIVE`           | Kill-switch sentinel present                             | Remove sentinel (runbook)                 |
| `BASELINES_INCOMPLETE`      | One or more ws baselines missing                         | Publish missing baseline                  |
| `BASELINE_SCHEMA_INVALID`   | Baseline file failed Zod validation                      | Fix baseline file; re-publish             |
| `BASELINE_INSUFFICIENT`     | `sample_count < 10` AND window `< 30 days`               | Accrue more samples OR write override     |
| `BASELINE_RACE_ABORT`       | fstat size unstable across 3 retries (concurrent writer) | Retry preflight                           |
| `AUDIT_LOG_HEAD_UNREADABLE` | Audit log read failed                                    | Run `verify-audit-chain.mjs`; investigate |
| `ENFORCEMENT_FLAG_INVALID`  | Flag file fails Zod validation                           | Fix flag file; commit signed              |
| `AUDIT_APPEND_FAILED`       | Preflight could not append `flag_flip` rejection entry   | Investigate audit log writability         |

Stderr shape:

```json
{
  "event": "coercive_flip_rejected",
  "error_code": "BASELINES_INCOMPLETE",
  "missing_baselines": ["ws-2", "ws-3"],
  "sentinel_present": false,
  "timestamp": "2026-04-22T14:00:00.000Z"
}
```

## Per-Workstream Override

When one workstream's baseline is undersized but deployment is urgent, operator may author a scoped override:

```bash
cat > .claude/metrics/ws-2-baseline-override.json <<EOF
{
  "workstream_id": "ws-2",
  "rationale": "ws-2 short-window acceptance: 5 samples / 14 days; fallback to ws-1 parity evidence",
  "operator": "matthewlin",
  "effective_at": "2026-04-22T12:00:00.000Z"
}
EOF
git add .claude/metrics/ws-2-baseline-override.json
git commit -S -m "override: ws-2 baseline short-window"
```

Override scope:

- Single workstream only (no cross-workstream propagation)
- Expires at `effective_at + 30 days` (reverts to `BASELINE_INSUFFICIENT`)
- Subject to reverse-governance SLA review (REQ-013 / NFR-1)

## Baseline Override Lock

Concurrent baseline edits are serialized via an advisory lock. Inspect:

```bash
node .claude/scripts/session-checkpoint.mjs inspect-lock baseline-override
```

Force-release a stale lock (>15 min, mtime-based):

```bash
node .claude/scripts/session-checkpoint.mjs inspect-lock baseline-override \
  --force-release \
  --rationale "STALE_LOCK_RECOVERY"
```

Force-release rejected on non-stale locks. Audit-logs via `session_override_flip` + `event_subtype: baseline_override_force_release`.

## 3-Way Baseline Gate (Completion-Verifier)

Completion-verifier invokes the preflight as a gate. When `enforcement.mode == "advisory"`, the gate is advisory (logs findings, does not block). When operator attempts to flip to `coercive`, the gate becomes coercive: merge blocked until preflight exit 0.

Gate semantics summary:

- **Advisory phase**: findings logged; merge proceeds.
- **Coercive flip attempt**: preflight MUST exit 0; any rejection blocks flip AND emits `flag_flip rejected: true` audit entry.
- **Coercive phase** (post-flip): preflight runs at every gate trip; sentinel creation reverts to advisory automatically.

## Publication Procedure

Scheduled for first 10 workstreams post-ship. ws-1 metrics publisher scaffold at `.claude/metrics/pipeline-efficiency-ws1-baseline.json` with `sample_count: 0`.

Typical publish:

```bash
node .claude/scripts/pipeline-efficiency-ws1-metrics-publisher.mjs \
  --run-id <run-id> \
  --operator matthewlin

git add .claude/metrics/pipeline-efficiency-ws1-baseline.json \
        .claude/metrics/pipeline-efficiency-ws1-<run-id>.json
git commit -S -m "baseline(ws-1): publish <run-id>"
```

## See Also

- `PIPELINE-EFFICIENCY-OPERATOR-RUNBOOK.md` — coercive flip procedure
- `AUDIT-LOG-INSPECTION.md` — `flag_flip` rejected event inspection
- `THRESHOLD-TUNING.md` — per-gate threshold relaxation + BIZ-002
- `.claude/scripts/pipeline-efficiency-coercive-flip-preflight.mjs` — preflight source
- `.claude/scripts/lib/schemas/baseline.schema.mjs` — Zod schema

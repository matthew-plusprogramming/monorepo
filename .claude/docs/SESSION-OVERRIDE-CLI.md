---
_source_modules: ['pipeline-efficiency-ws1-convergence-pruning']
---

# Session-Override CLI Reference

Reference for `session-checkpoint.mjs override-enforcement` — the session-scoped enforcement-mode flip introduced by REQ-013.

## Purpose

Flip the effective enforcement mode (`advisory` ↔ `coercive`) for the duration of the current session without mutating the on-disk enforcement-flag file. Used for:

- Coercive-validation runs on a single spec group without global flip
- Temporary advisory downgrade when investigating a false-positive spike
- Per-session opt-in to stricter gating ahead of global rollout

Does NOT modify `.claude/config/pipeline-efficiency-enforcement.json`. Override lives at `session.active_work.enforcement_override` and expires with the session.

## Usage

```bash
node .claude/scripts/session-checkpoint.mjs override-enforcement <advisory|coercive> \
  --rationale "<non-empty text>"
```

Required arguments:

| Arg           | Values                   | Notes                                   |
| ------------- | ------------------------ | --------------------------------------- |
| mode          | `advisory` \| `coercive` | `off` rejected (see below)              |
| `--rationale` | non-empty string         | Recorded in session history + audit log |

## Examples

Upgrade a session to coercive:

```bash
node .claude/scripts/session-checkpoint.mjs override-enforcement coercive \
  --rationale "ws-3 coercive-validation run before global flip"
```

Downgrade a session to advisory during incident response:

```bash
node .claude/scripts/session-checkpoint.mjs override-enforcement advisory \
  --rationale "false-positive investigation; gates reporting only"
```

## Rejection: `off` Mode

`off` is rejected at the CLI boundary with structured error:

```
SESSION_OVERRIDE_OFF_REJECTED: Session override mode 'off' is not permitted.
Valid values: advisory, coercive.
```

Exit code 1. Rationale: `off` fully disables gate logic; that decision requires signed-commit operator authorization on the on-disk flag file, not a session-scoped override.

To set `off`:

1. Edit `.claude/config/pipeline-efficiency-enforcement.json` → `"mode": "off"`.
2. `git commit -S`.

## Effects

When override is applied:

1. Appends audit entry `session_override_flip` BEFORE mutating session state (AC19.4). Failed audit append aborts the override — no session state carries an override without a matching audit record.
2. Writes `session.active_work.enforcement_override = { mode, rationale, effective_at, prior_mode }`.
3. `prior_mode` captures the file-based mode at override time (via `getCurrentMode()`), NOT a previously-overridden session value.
4. Session history records `enforcement_override_applied` event.

Does NOT mutate:

- `SessionThresholdSnapshot` (AC19.5) — thresholds remain from session start
- `.claude/config/pipeline-efficiency-enforcement.json`
- Any other session file

## Reading the Effective Mode

Downstream consumers resolve the effective mode by preference:

1. `session.active_work.enforcement_override.mode` (if present)
2. `.claude/config/pipeline-efficiency-enforcement.json` via `getCurrentMode()`
3. Default: `advisory`

Gate-enforcement hooks (`workflow-gate-enforcement.mjs`, `workflow-stop-enforcement.mjs`) consume the effective mode; see `HOOKS.md`.

## Audit Entry Shape

```json
{
  "seq": 42,
  "timestamp": "2026-04-22T14:30:00.000Z",
  "event_class": "session_override_flip",
  "actor": "matthewlin",
  "payload": {
    "new_mode": "coercive",
    "prior_mode": "advisory",
    "rationale": "ws-3 coercive-validation run before global flip",
    "session_id_hash": "<sha256-prefix>"
  },
  "prev_hash": "<64-char-hex>"
}
```

Query overrides across sessions:

```bash
jq 'select(.event_class == "session_override_flip")' \
  .claude/audit/pipeline-efficiency-changes.log
```

## Clearing an Override

Overrides do NOT persist across sessions. They are cleared automatically by:

- `complete-work` — finalizes current work; session_override cleared as part of `active_work` archival
- `archive-incomplete` — archives incomplete work; override cleared
- Session start for a new spec group — new session inherits file-based mode

Explicit mid-session clear: re-invoke with the current file-based mode. Example, if file mode is `advisory`:

```bash
node .claude/scripts/session-checkpoint.mjs override-enforcement advisory \
  --rationale "clearing coercive override; returning to file-based advisory"
```

## Compared to Other Enforcement Controls

| Control                               | Scope                   | Persistence            | Modes permitted                     |
| ------------------------------------- | ----------------------- | ---------------------- | ----------------------------------- |
| `override-enforcement`                | Session                 | Cleared on session end | `advisory` \| `coercive`            |
| Enforcement-flag file                 | Global                  | On-disk, signed commit | `advisory` \| `coercive` \| `off`   |
| Kill-switch sentinel                  | Global (halts all)      | On-disk, signed commit | Presence-only                       |
| `override-skip` (phase-scoped)        | Single phase transition | Session                | Boolean skip                        |
| `set-enforcement-level` (cooperative) | Session                 | Session                | `off` \| `warn-only` \| `graduated` |

`override-enforcement` targets the pipeline-efficiency enforcement mode specifically. `set-enforcement-level` targets the cooperative DAG-transition enforcement level (separate subsystem).

## Common Errors

| Error                           | Cause                              | Fix                                                           |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------------- |
| `SESSION_OVERRIDE_OFF_REJECTED` | Attempted `off` mode               | Edit flag file + signed commit instead                        |
| `--rationale required`          | Missing or empty `--rationale` arg | Provide non-empty rationale text                              |
| `No active work`                | `start-work` not yet called        | Invoke `start-work` first                                     |
| `AUDIT_APPEND_FAILED`           | Audit log unwritable               | Investigate `verify-audit-chain.mjs`; may need chain rotation |
| `Invalid mode`                  | Non-enum value                     | Use `advisory` or `coercive`                                  |

## See Also

- `PIPELINE-EFFICIENCY-OPERATOR-RUNBOOK.md` — global enforcement procedures
- `AUDIT-LOG-INSPECTION.md` — `session_override_flip` event inspection
- `BASELINE-LIFECYCLE.md` — coercive-flip preflight (related but distinct)
- `.claude/scripts/session-checkpoint.mjs` — CLI source (`override-enforcement` handler)
- `.claude/scripts/lib/schemas/enforcement-config.schema.mjs` — mode validation schema

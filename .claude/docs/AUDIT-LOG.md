# Kill-Switch Audit Log

Current owner: kill-switch audit log runtime contract.
Covers: tamper-evident audit append, protected audit writes, and kill-switch
hook wiring.

## Purpose

Every create/remove of the gate-enforcement kill-switch sentinel
(`.claude/coordination/gate-enforcement-disabled`) is recorded as a tamper-evident
append-only entry in `.claude/audit/kill-switch.log.jsonl`. The log carries a
SHA-256 prev-hash chain so later verification can detect tampering or gaps.

## Artifacts

| Artifact                                  | Purpose                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `.claude/audit/kill-switch.log.jsonl`     | Append-only JSONL audit log. Protected from direct writes; only the `audit-append.mjs` CLI may write.    |
| `.claude/audit/kill-switch.log.<N>.jsonl` | Rotated siblings (N = 1..10). Same write-protection as the base file.                                    |
| `.claude/audit/rate-limit.state`          | Persistent token-bucket state (1 token per 10s, burst 5). Survives restarts.                             |
| `.claude/audit/.rotation.lock`            | Optional rotation-race lock file. Serializes concurrent rotations.                                       |
| `.claude/scripts/audit-append.mjs`        | Sole authorized writer. Appends one entry, enforces chain + rate-limit + sanitation + rotation.          |
| `.claude/scripts/audit-verify.mjs`        | Chain-recompute verifier. Non-zero exit triggers BLOCK mode for subsequent appends until `--ack-tamper`. |

## Entry schema

Each log line is one JSON object. Required fields:

```json
{
  "seq": 12,
  "timestamp": "2026-04-19T08:30:00.000Z",
  "action": "create",
  "sentinel": ".claude/coordination/gate-enforcement-disabled",
  "actor": "operator-jdoe",
  "rationale": "Emergency: demo day",
  "prev_hash": "a1b2c3d4..."
}
```

| Field       | Type    | Notes                                                                                                    |
| ----------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `seq`       | integer | Monotonic per log file. Gaps detected by `audit-verify.mjs`.                                             |
| `timestamp` | string  | ISO 8601 UTC.                                                                                            |
| `action`    | enum    | `create` \| `remove` \| `ack_tamper` \| `dual_corrupt` (the last two are non-toggle diagnostic records). |
| `sentinel`  | string  | Path to the sentinel being toggled.                                                                      |
| `actor`     | string  | Free-form; `JSON.stringify`-encoded; max 500 chars; control chars 0x00-0x1F (except 0x09) rejected.      |
| `rationale` | string  | Same sanitization rules as `actor`.                                                                      |
| `prev_hash` | string  | 64-char hex SHA-256 of previous entry's canonical JSON. First entry uses 64 zero chars.                  |

Entry size is bounded to 4096 bytes total (O_APPEND PIPE_BUF-bounded writes).

## How to toggle (operator workflow)

The authorized CLI path also emits the audit entry:

```bash
# Create the kill-switch sentinel + audit entry
node .claude/scripts/session-checkpoint.mjs toggle-kill-switch \
  --action create \
  --rationale "Incident #123: enforcement blocking legitimate dispatch"

# Remove the kill-switch sentinel + audit entry
node .claude/scripts/session-checkpoint.mjs toggle-kill-switch \
  --action remove \
  --rationale "Incident #123 resolved"
```

Direct Bash attempts (`touch .claude/coordination/gate-enforcement-disabled`,
`rm .claude/coordination/gate-enforcement-disabled`, shell redirection, `node -e`,
`sed`, `tee`, `truncate`, `perl`, `ruby`, `php -r`) are BLOCKED by
`workflow-file-protection.mjs` with a redirect to the CLI.

## Manual audit entry (fallback)

If the toggle CLI is unavailable, `audit-append.mjs` can be invoked directly:

```bash
node .claude/scripts/audit-append.mjs \
  --action create \
  --sentinel .claude/coordination/gate-enforcement-disabled \
  --actor "$(whoami)" \
  --rationale "Manual toggle: session-checkpoint CLI unavailable"
```

The CLI sets `process.ppid` attestation when writing to the log (see
§ Trust model below). Writes from any other caller fail closed.

## Verifying the chain

```bash
node .claude/scripts/audit-verify.mjs
```

Recomputes every entry's `prev_hash` and checks `seq` continuity. On success,
exits 0. On any mismatch or gap, exits non-zero and writes a BLOCK-mode
marker so subsequent `audit-append.mjs` invocations refuse further writes
until operator acknowledgement:

```bash
node .claude/scripts/audit-append.mjs --ack-tamper --rationale "Reviewed incident #42"
```

`--ack-tamper` records its own chained entry and clears BLOCK mode.

## Trust model (PPID attestation)

The `workflow-file-protection.mjs` hook exempts writes to
`kill-switch.log.jsonl` and its rotated siblings **only** when the calling
process's parent is verifiably `node /path/to/audit-append.mjs`:

- The env marker `AUDIT_APPEND_AUTHORIZED=1` is NOT the trust channel. It is
  retained in `audit-append.mjs` for log diagnostics but the file-protection
  hook does not consult it.
- The hook reads its parent process's argv (via `/proc/<ppid>/cmdline` on
  Linux, `ps -o args= -p <ppid>` on macOS) and requires:
  - `argv[0]` basename is `node` (or `.node` for packaged wrappers).
  - `argv[1]` basename is exactly `audit-append.mjs`.
  - No earlier path component of `argv[1]` is literally the string
    `audit-append.mjs` (defeats `/tmp/audit-append.mjs/wrapper.sh` smuggling).
- Any env-only spoof (prefixing `AUDIT_APPEND_AUTHORIZED=1` in a Bash command)
  fails closed -- the hook refuses the write.
- Unsupported platforms (neither Linux `/proc` nor macOS `ps`) fail closed.

## Rate limit

Persistent token bucket in `.claude/audit/rate-limit.state`:

- Refill: 1 token per 10 seconds (wall clock).
- Burst: 5 tokens maximum.
- Exhaustion: append fails with `E_RATE_LIMITED`. **No audit entry is written**
  (no amplification when the attacker's goal is log growth).

The state file survives process restarts -- a burst of kill-switch toggles
across sessions is still rate-limited.

## Rotation

When `kill-switch.log.jsonl` exceeds 10 MB, `audit-append.mjs` rotates in
place:

1. Rename `kill-switch.log.jsonl` → `kill-switch.log.1.jsonl` (shifting existing
   `.N.jsonl` siblings up by one).
2. Prune the oldest when the count exceeds 10 (so up to `kill-switch.log.10.jsonl`
   is retained).
3. Begin the fresh file with chain-continuity: the first entry's `prev_hash`
   links to the last entry of the previous file.

Rotation is atomic per-process (serialized via flock on `rate-limit.state` or
the dedicated `.rotation.lock`). Concurrent invocations never produce duplicate
N suffixes or orphan files.

## Rotation-sibling write protection

`workflow-file-protection.mjs` protects the entire rotation family via a
compiled regex `/^kill-switch\.log(\.\d+)?\.jsonl$/`:

- `kill-switch.log.jsonl` (base): BLOCKED.
- `kill-switch.log.1.jsonl` .. `kill-switch.log.10.jsonl`: BLOCKED.
- `kill-switch.log.old`: NOT matched (extension must be `.jsonl`).
- `kill-switch.log.jsonl.bak`: NOT matched (regex is anchored end-to-end).

The pattern is combined with directory alignment (`.claude/audit/` segment
required) so unrelated files outside the audit directory are never matched.

## Error taxonomy

| Code                         | Cause                                                                       | Recovery                                                              |
| ---------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `E_RATE_LIMITED`             | Token bucket exhausted.                                                     | Wait 10s per token. No entry is written.                              |
| `E_INVALID_CONTROL_CHAR`     | `actor` or `rationale` contained control chars 0x00-0x1F (except 0x09 tab). | Strip control chars from the input.                                   |
| `E_ENTRY_TOO_LARGE`          | Entry exceeded 4096 bytes total after sanitization.                         | Shorten `actor` / `rationale`.                                        |
| `E_AUDIT_BLOCKED`            | Chain verifier detected tamper; BLOCK mode active.                          | Run `audit-verify.mjs`, investigate, then `--ack-tamper --rationale`. |
| `E_RATE_LIMIT_STATE_CORRUPT` | `.claude/audit/rate-limit.state` JSON corrupt or unreadable.                | Delete the state file; next invocation reinitializes to a full burst. |

## Bootstrap

On a fresh clone or consumer-sync, `.claude/audit/` does not exist. The first
`audit-append.mjs` invocation creates it with `mode 0755` via
`fs.mkdirSync({recursive: true})`. Subsequent invocations are idempotent.

## Non-toggle entries

| Action         | When                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`       | Kill-switch sentinel created.                                                                                                                                  |
| `remove`       | Kill-switch sentinel removed.                                                                                                                                  |
| `ack_tamper`   | Operator acknowledged a BLOCK-mode trigger via `audit-append.mjs --ack-tamper`.                                                                                |
| `dual_corrupt` | `session-checkpoint.mjs start-work` detected both manifest.json and session.json corrupt (best-effort diagnostic entry; Phase B `E_DUAL_CORRUPT` fail-closed). |

## See Also

- [Workflow Enforcement Architecture](WORKFLOW-ENFORCEMENT.md) -- kill-switch scope and override mechanism.
- [Hooks](HOOKS.md) -- `workflow-file-protection.mjs` PPID-attestation exemption details.
- `.claude/scripts/audit-append.mjs` and `.claude/scripts/audit-verify.mjs`
  -- append and verify the kill-switch audit chain.

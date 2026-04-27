---
title: Runtime-Connectivity Enforcement Audit System
_source_spec: sg-e2e-enforcement-flag-audit
last_reviewed: 2026-04-27
---

# Runtime-Connectivity Enforcement Audit System

Runtime-connectivity enforcement uses an operator-owned flag file plus a
hash-chained audit log. Agents cannot edit the flag, audit log, or chain
verifier through Claude Code tools. Gate 5 consumers resolve the current mode
through the resolver and verify the audit chain before trusting the flag.

This is distinct from the silent-drop audit chain. Both systems live under
`.claude/audit/`, but runtime connectivity uses `rtc-` names so the two chains
cannot share a log or verifier by accident.

## Current Artifacts

| Path | Role |
| --- | --- |
| `.claude/config/runtime-connectivity-enforcement.json` | Operator flag file with `{mode, effective_at, operator}`. |
| `.claude/audit/rtc-enforcement-changes.log` | Append-only JSONL audit chain for runtime-connectivity enforcement. |
| `.claude/audit/rtc-enforcement-changes.log.lock` | Session-lock sidecar around read-last plus append. |
| `.claude/audit/rtc-enforcement-changes.log.<date>.quarantine` | Sealed copy of a broken log after recovery. |
| `.claude/scripts/lib/enforcement-flag-schema.mjs` | Flag schema, `parseFlag`, and `parseFlagStructural`. |
| `.claude/scripts/lib/audit-log-entry-schema.mjs` | Discriminated union for audit entries plus `parseEntry`. |
| `.claude/scripts/lib/enforcement-audit-writer.mjs` | Synchronous hash-chain writer, exported as `appendEntry`. |
| `.claude/scripts/lib/enforcement-mode-resolver.mjs` | `resolveMode` with session, file, default precedence. |
| `.claude/scripts/lib/append-reverse-governance-entry.mjs` | Typed wrapper for reverse-governance entries. |
| `.claude/scripts/verify-rtc-enforcement-chain.mjs` | Programmatic and CLI hash-chain verifier. |
| `.claude/scripts/quarantine-enforcement-audit.mjs` | Operator CLI that seals a broken log and starts a new one. |
| `.claude/scripts/workflow-file-protection.mjs` | PreToolUse protection for the flag, log, and verifier. |

Sibling chains:

| System | Flag/config | Log | Verifier |
| --- | --- | --- | --- |
| Runtime connectivity | `.claude/config/runtime-connectivity-enforcement.json` | `.claude/audit/rtc-enforcement-changes.log` | `.claude/scripts/verify-rtc-enforcement-chain.mjs` |
| Silent drop | `.claude/config/silent-drop-enforcement.json` | `.claude/audit/enforcement-changes.log` | `.claude/scripts/verify-enforcement-audit-chain.mjs` |
| Kill switch | See `AUDIT-LOG.md` | `.claude/audit/kill-switch.log.jsonl` | See `AUDIT-LOG.md` |

## Flag Contract

Flag file shape:

```json
{
  "mode": "advisory",
  "effective_at": "2026-04-21T12:00:00.000Z",
  "operator": "alice"
}
```

Fields:

| Field | Contract |
| --- | --- |
| `mode` | `advisory`, `coercive`, or `off`. |
| `effective_at` | ISO-8601 datetime. Write-time bounds are `now - 5min` through `now + 30d`. |
| `operator` | Non-empty string identifying the operator. |

The schema is strict; unknown keys reject.

`parseFlag(jsonString, now?)` validates JSON, schema, and write-time bounds.
`parseFlagStructural(jsonString)` validates JSON and schema only. The resolver
uses structural parsing because time bounds are a write-time anti-backdating
control, not a read-time staleness check.

Parse errors:

| Code | Meaning |
| --- | --- |
| `FLAG_FILE_MALFORMED` | JSON parse failed. |
| `FLAG_VALIDATION_FAILED` | Schema validation failed. |

## Mode Resolution

`resolveMode(opts?)` returns `{mode, source}`.

Precedence:

1. `sessionOverride`
   - `advisory` or `coercive` wins with `source: "session"`.
   - `off` throws `SESSION_CANNOT_SET_OFF`.
2. Flag file
   - If the file exists, parses structurally, and `effective_at <= now`, its
     `mode` wins with `source: "file"`.
   - If `effective_at > now`, the flag is scheduled but not effective yet; the
     resolver falls through to the default.
   - If `effective_at` differs from `now` by more than five minutes, the
     resolver emits a non-blocking clock-skew warning.
3. Default
   - Defaults to `advisory` unless the caller supplies `default`.
   - Missing flag file is not an error.

Resolver errors:

| Code | Meaning |
| --- | --- |
| `SESSION_CANNOT_SET_OFF` | A session attempted to disable enforcement. |
| `FLAG_FILE_MALFORMED` | Flag file JSON parse failed. |
| `FLAG_VALIDATION_FAILED` | Flag file schema validation failed. |

Gate 5 decides how to handle resolver errors, but malformed flag files are
treated as hard failures by the enforcement flow.

## Audit Entry Contract

Every audit entry is strict JSON with common fields:

| Field | Contract |
| --- | --- |
| `decision_type` | Discriminator. |
| `prev_hash` | Lowercase 64-character SHA-256 hex. Writer-assigned. |
| `timestamp` | ISO-8601 datetime. Caller-supplied timestamp wins; writer fills it when omitted. |
| `operator` | Non-empty string. |

Entry variants:

| `decision_type` | Required variant fields |
| --- | --- |
| `mode-change` | `mode`, `effective_at` |
| `credential-rotation-start` | `credential_ref`, `overlap_window_start`, `overlap_window_end` |
| `credential-rotation-end` | `credential_ref`, `rotation_completed_at` |
| `reverse-governance` | `outcome`, `trigger`, `rationale` |
| `quarantine` | `quarantined_file_sha256`, `quarantine_reason` |

`parseEntry(obj)` returns either validated data or:

```js
{success: false, error: {code: 'ENTRY_VALIDATION_FAILED', message, issues}}
```

## Hash Chain

Genesis:

```text
SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

Linking rule:

```text
entry[0].prev_hash = SHA-256("")
entry[i].prev_hash = SHA-256(canonicalizeExcludingField(entry[i - 1], "prev_hash"))
```

Canonicalization is handled by `.claude/scripts/lib/jcs-canonicalize.mjs`.
String values and keys are NFC-normalized before canonical JSON emission.

Changing a historical entry changes the expected hash for every following
entry. The verifier checks the chain in order and reports the first broken
entry.

## Writer Contract

`appendEntry(params, opts?)` is synchronous and returns the written entry. Do
not `await` it.

Writer behavior:

- Rejects caller-supplied `prev_hash`.
- Accepts `logPath` either as `opts.logPath` or `params.logPath`.
- Creates the parent directory if needed.
- Acquires `<logPath>.lock` with `failOpen: false`.
- Reads the last entry, computes the next `prev_hash`, validates the merged
  entry, writes one canonical JSON line with `O_APPEND`, fsyncs, and closes.
- Treats a missing or empty log as genesis.

Writer errors:

| Code | Meaning |
| --- | --- |
| `SCHEMA_VIOLATION` | Merged entry failed schema validation, or caller supplied `prev_hash`. |
| `LOCK_CONTENTION` | The session lock could not be acquired. |
| `WRITE_FAILED` | Directory creation, open, write, fsync, or close failed. |
| `READ_LAST_FAILED` | Existing log could not be read or its last line was invalid JSON. |

Minimal append example:

```js
import { appendEntry } from './.claude/scripts/lib/enforcement-audit-writer.mjs';

appendEntry({
  decision_type: 'mode-change',
  mode: 'coercive',
  effective_at: '2026-05-01T00:00:00.000Z',
  operator: 'alice',
});
```

## Chain Verification

Programmatic API:

```js
import { verifyChain } from './.claude/scripts/verify-rtc-enforcement-chain.mjs';

const result = verifyChain('.claude/audit/rtc-enforcement-changes.log');
```

Result shape:

```js
{
  status: 'clean' | 'broken' | 'missing',
  entry_count: 0,
  break_at_entry: 0,
  observed_hash: '<hash-or-parse-error>',
  expected_hash: '<hash>'
}
```

CLI:

```bash
node .claude/scripts/verify-rtc-enforcement-chain.mjs \
  .claude/audit/rtc-enforcement-changes.log
```

Exit codes:

| Exit | Meaning |
| ---: | --- |
| `0` | Chain is clean. |
| `1` | Chain is broken. |
| `2` | Log is missing or CLI usage is invalid. |

Gate 5 runs chain verification before trusting the enforcement mode. A broken
chain is a hard failure regardless of `mode`, including `off`.

## Quarantine Recovery

Use quarantine only when the operator has determined that a chain break is
legitimate corruption rather than tampering.

```bash
node .claude/scripts/quarantine-enforcement-audit.mjs \
  --reason="Partial fsync during crash on 2026-04-21T09:30" \
  --operator="alice"
```

Arguments:

| Flag | Required | Default |
| --- | --- | --- |
| `--reason` | Yes | None |
| `--operator` | Yes | None |
| `--log-path` | No | `.claude/audit/rtc-enforcement-changes.log` |
| `--date` | No | Current ISO timestamp with colons removed |

The CLI:

1. Reads the current log bytes.
2. Computes `quarantined_file_sha256`.
3. Renames the log to `<logPath>.<date>.quarantine`.
4. Appends the first entry in the new log with `decision_type: "quarantine"`.
5. Prints JSON containing `status`, `quarantined_path`, `new_log_path`, and
   `quarantined_file_sha256`.

Exit codes are `0` success, `1` usage error, and `2` filesystem or append
failure.

## File Protection

`workflow-file-protection.mjs` protects these runtime-connectivity basenames:

| Basename | Directory |
| --- | --- |
| `runtime-connectivity-enforcement.json` | `config` |
| `rtc-enforcement-changes.log` | `audit` |
| `verify-rtc-enforcement-chain.mjs` | `scripts` |

Protected behavior:

- Claude Code `Write` attempts to the protected flag, log, or verifier exit 2.
- Bash destructive writes against those paths are blocked, including redirect,
  `sed -i`, `truncate`, `rm`, `mv`, inline runners, and similar write paths.
- Symlink bypasses are blocked through canonical realpath matching.
- Human terminal edits outside Claude Code are allowed for the flag file and
  paired with an audit append.

## Operator Workflows

Set a mode change:

1. Edit `.claude/config/runtime-connectivity-enforcement.json` from a human
   terminal.
2. Append a matching `mode-change` entry through `appendEntry`.
3. Run `verify-rtc-enforcement-chain.mjs` and expect `status: "clean"`.

Schedule a future flip:

- Write a future `effective_at`.
- Append the audit entry immediately.
- The resolver keeps returning the default until wall-clock time reaches
  `effective_at`.

Record reverse governance:

```js
import { appendReverseGovernanceEntry } from './.claude/scripts/lib/append-reverse-governance-entry.mjs';

appendReverseGovernanceEntry({
  outcome: 'accepted',
  trigger: 'Security incident review disputed an enforcement mode change',
  rationale: 'Reviewed with on-call; original change was procedurally correct.',
  operator: 'alice',
});
```

The reverse-governance helper pins `decision_type: "reverse-governance"` and
passes validation and writing to `appendEntry`.

## Testing Surface

Focused tests live under `.claude/scripts/__tests__/enforcement-flag-audit/`:

| Area | Test file |
| --- | --- |
| Flag schema | `enforcement-flag-schema.test.mjs` |
| Canonicalization helpers | `jcs-canonicalize-helpers.test.mjs` |
| Writer | `enforcement-audit-writer.test.mjs` |
| Entry schema | `audit-log-entry-schema.test.mjs` |
| Chain verifier | `verify-rtc-enforcement-chain.test.mjs` |
| File protection | `workflow-file-protection.rtc.test.mjs` |
| Mode resolver | `enforcement-mode-resolver.test.mjs` |
| Quarantine CLI | `quarantine-enforcement-audit.test.mjs` |
| Reverse governance helper | `append-reverse-governance-entry.test.mjs` |
| End-to-end integration | `enforcement-audit.integration.test.mjs` |

Runtime-connectivity E2E coverage is in:

```text
tests/e2e/sg-e2e-enforcement-flag-audit.runtime-connectivity.spec.mjs
```

## See Also

- [SILENT-DROP-OBSERVABILITY.md](SILENT-DROP-OBSERVABILITY.md)
- [AUDIT-LOG.md](AUDIT-LOG.md)
- [HOOKS.md](HOOKS.md)
- [WORKFLOW-ENFORCEMENT.md](WORKFLOW-ENFORCEMENT.md)
- `.claude/specs/groups/sg-e2e-enforcement-flag-audit/spec.md`
- `.claude/specs/groups/sg-e2e-runtime-connectivity/spec.md`
- `.claude/specs/groups/sg-e2e-gate5-enforcement/spec.md`

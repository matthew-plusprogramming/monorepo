---
title: Runtime-Connectivity Enforcement Audit System
_source_spec: sg-e2e-enforcement-flag-audit
last_reviewed: 2026-04-21
---

# Runtime-Connectivity Enforcement Audit System

Durability primitive for the runtime-connectivity (Gate 5) kill-switch. Ships an operator-editable enforcement flag file, a hash-chained append-only audit log, a chain verifier, a quarantine recovery CLI, a mode resolver, reverse-governance entry helper, and write-protection coverage for all three new artifacts.

Spec: `.claude/specs/groups/sg-e2e-enforcement-flag-audit/spec.md`.
Parent MasterSpec: `.claude/specs/groups/sg-e2e-runtime-connectivity/spec.md`.
Requirements: REQ-NFR-015, REQ-NFR-024, REQ-NFR-025 (primary); REQ-NFR-014, REQ-NFR-019 (documentation-only).

## Distinct from the Silent-Drop Audit Chain

This system is **NOT** the silent-drop audit chain documented in [SILENT-DROP-OBSERVABILITY.md](SILENT-DROP-OBSERVABILITY.md). Two distinct systems share the `.claude/audit/` directory and the `workflow-file-protection.mjs` hook, each with its own basenames:

| Basename                                               | Owner spec group                | Protected by                                                 |
| ------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------ |
| `.claude/audit/enforcement-changes.log`                | `sg-silent-drop-observability`  | `PROTECTED_FILENAMES[enforcement-changes.log]`               |
| `.claude/scripts/verify-enforcement-audit-chain.mjs`   | `sg-silent-drop-observability`  | `PROTECTED_FILENAMES[verify-enforcement-audit-chain.mjs]`    |
| `.claude/audit/rtc-enforcement-changes.log`            | `sg-e2e-enforcement-flag-audit` | `PROTECTED_FILENAMES[rtc-enforcement-changes.log]`           |
| `.claude/scripts/verify-rtc-enforcement-chain.mjs`     | `sg-e2e-enforcement-flag-audit` | `PROTECTED_FILENAMES[verify-rtc-enforcement-chain.mjs]`      |
| `.claude/config/silent-drop-enforcement.json`          | `sg-silent-drop-observability`  | `PROTECTED_FILENAMES[silent-drop-enforcement.json]`          |
| `.claude/config/runtime-connectivity-enforcement.json` | `sg-e2e-enforcement-flag-audit` | `PROTECTED_FILENAMES[runtime-connectivity-enforcement.json]` |

The `rtc-` prefix convention resolves the basename collision discovered during investigation convergence (inv-crit-5b9a2f14). Silent-drop's basenames landed first and are live infrastructure; this system adopts the `rtc-` prefix to avoid trampling silent-drop's chain and verifier. See § Decision Log for rationale.

## Artifacts

| Artifact                                                              | Purpose                                                                                                                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/config/runtime-connectivity-enforcement.json`                | Operator-controlled enforcement mode flag. Schema: `{mode, effective_at, operator}`. Agent writes BLOCKED; human terminal writes pass.                    |
| `.claude/audit/rtc-enforcement-changes.log`                           | Append-only JSONL hash chain. One entry per line. Writer: `enforcement-audit-writer.mjs::appendEntry` only. Agent writes BLOCKED.                         |
| `.claude/audit/rtc-enforcement-changes.log.lock`                      | File-lock sidecar held by `session-lock.mjs` around the read-last + append critical section.                                                              |
| `.claude/audit/rtc-enforcement-changes.log.<ISO-datetime>.quarantine` | Sealed (immutable) copy of a broken log after the quarantine ritual.                                                                                      |
| `.claude/scripts/lib/enforcement-flag-schema.mjs`                     | Zod schema + `parseFlag` / `parseFlagStructural` for the flag file.                                                                                       |
| `.claude/scripts/lib/audit-log-entry-schema.mjs`                      | Zod discriminated-union schema + `parseEntry` for audit entries.                                                                                          |
| `.claude/scripts/lib/enforcement-audit-writer.mjs`                    | Synchronous hash-chained writer — sole authorized appender.                                                                                               |
| `.claude/scripts/lib/enforcement-mode-resolver.mjs`                   | `resolveMode({...})` with `session > file > default` precedence.                                                                                          |
| `.claude/scripts/lib/append-reverse-governance-entry.mjs`             | Typed wrapper over `appendEntry` with `decision_type: "reverse-governance"` pinned.                                                                       |
| `.claude/scripts/lib/jcs-canonicalize.mjs`                            | RFC 8785 JCS canonicalizer + `canonicalizeExcludingField` helper. NFC normalization added by T2.X (shared with silent-drop + deployment-audit consumers). |
| `.claude/scripts/verify-rtc-enforcement-chain.mjs`                    | CLI + programmatic chain verifier. Exit codes 0 / 1 / 2 for clean / broken / missing.                                                                     |
| `.claude/scripts/quarantine-enforcement-audit.mjs`                    | Operator CLI for the Path D recovery ritual.                                                                                                              |
| `.claude/scripts/workflow-file-protection.mjs`                        | PreToolUse hook; blocks agent writes to all three new paths (as-006 extension).                                                                           |

## Enforcement Flag Semantics

### Flag File Schema

```json
{
  "mode": "advisory",
  "effective_at": "2026-04-21T12:00:00.000Z",
  "operator": "alice"
}
```

| Field          | Type              | Notes                                                                                       |
| -------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `mode`         | enum              | `advisory` \| `coercive` \| `off`. Strict enum; out-of-enum values reject.                  |
| `effective_at` | ISO-8601 datetime | Write-time bounds: `>= now() - 5min` (SEC-016 past-bound); `<= now() + 30d` (future-bound). |
| `operator`     | string            | Non-empty. Recorded on the companion audit entry.                                           |

`.strict()` mode rejects unknown keys. The schema is parameterized by an injected `now` so deterministic tests can reason about bound checks. Read-time consumers (the mode resolver) use `parseFlagStructural` — write-time bounds do NOT re-apply at read time because the bounds are a write-time anti-backdating constraint (an operator cannot retroactively forge a past `effective_at`), not a read-time staleness check.

### Mode Resolver Precedence

`resolveMode({sessionOverride?, default?, flagPath?, now?, onWarn?})` returns `{mode, source}`. Evaluation order:

1. **Session override**. If `sessionOverride` is `advisory` or `coercive` → `{mode: sessionOverride, source: "session"}`. If `sessionOverride === "off"` → throw `{code: "SESSION_CANNOT_SET_OFF"}`. Sessions cannot disable enforcement; only the out-of-band flag file can.
2. **File mode with `effective_at <= now`**. Parse flag via `parseFlagStructural`. On success → `{mode, source: "file"}`. If `|now - effective_at| > 5min`, emit a non-blocking clock-skew warning through `onWarn` (or stderr).
3. **File mode with `effective_at > now` — NOT-YET-EFFECTIVE**. Fall through to the default. Operators set a future `effective_at` to schedule a mode flip (e.g., "coercive starting 2026-05-01T00:00Z"). Until wall-clock reaches that time, the scheduled entry is advisory-of-future-state; the system behaves per the caller-supplied default. The flag file is preserved on disk and becomes effective once wall-clock passes `effective_at`. No error.
4. **Default**. Return `{mode: defaultMode ?? "advisory", source: "default"}`. File absent → same default; no error, no warning.

Session-override storage is the caller's concern (in-process variable, not persisted). Gate 5 (owned by `sg-e2e-gate5-enforcement`) is the downstream consumer.

### SEC-016 Backdating Window

The past-bound `effective_at >= now() - 5min` prevents an operator from backdating a mode change to appear prospective. The 72-hour retrospective trigger for `mode: "off"` persistence (operational policy in `sg-e2e-baseline-metrics`) uses the writer-assigned `timestamp` (wall-clock at write time), NOT the operator-supplied `effective_at`. A successful backdate within the 5-minute past-bound cannot bypass the retrospective review because `timestamp` is the trigger field.

The future-bound `<= now() + 30d` caps how far ahead operators can schedule a flip without re-authorization.

## Hash Chain Architecture

### Entry Schema (Discriminated Union)

Every entry carries a common base: `{decision_type, prev_hash, timestamp, operator}`. `decision_type` is the union discriminator. Per-variant required fields:

| `decision_type`             | Additional required fields                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `mode-change`               | `mode` (enum), `effective_at` (datetime)                                                 |
| `credential-rotation-start` | `credential_ref`, `overlap_window_start`, `overlap_window_end`                           |
| `credential-rotation-end`   | `credential_ref`, `rotation_completed_at`                                                |
| `reverse-governance`        | `outcome` (enum `accepted \| rejected \| deferred \| withdrawn`), `trigger`, `rationale` |
| `quarantine`                | `quarantined_file_sha256` (lowercase hex), `quarantine_reason`                           |

Every variant is `.strict()` — unknown keys reject. `prev_hash` is 64-char lowercase hex (uppercase rejects per AC4.9). Each entry is canonicalized per RFC 8785 JCS (sorted keys, no whitespace, UTF-8 NFC, fixed numeric form) before hashing.

### Chain Linking

```
entry[0].prev_hash = SHA-256("")
                  = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855

entry[i].prev_hash = SHA-256( canonicalizeExcludingField(entry[i-1], "prev_hash") )
```

The genesis `prev_hash = SHA-256("")` is a well-defined empty-bytes invariant (EDGE-FA-04, REQ-NFR-025) — auditors can verify it without consulting writer source. This diverges deliberately from `deployment-audit.mjs`'s `null` genesis; the parent REQ pinned the empty-bytes form.

Modifying any historical entry invalidates every subsequent `prev_hash`. The verifier detects this O(n) on read (acceptable up to ~10k entries; quarantine-rollover is the documented mitigation ceiling per EDGE-FA-06).

### Writer Semantics

`appendEntry(params, opts?)` at `enforcement-audit-writer.mjs`:

- **Synchronous**. Returns `AuditLogEntry` directly — NOT a Promise. Callers MUST NOT `await` the result. The parent contract pins `synchronicity: synchronous`. Sync `fs.*Sync` I/O gives deterministic fsync-before-return durability.
- **Lock-protected critical section**. Acquires `.claude/audit/rtc-enforcement-changes.log.lock` via `session-lock.mjs::acquireLock(lockPath, {failOpen: false})` before reading last entry; releases after `closeSync`. Prevents TOCTOU chain fork under concurrent writers.
- **File flags**. `openSync(path, O_APPEND | O_CREAT | O_WRONLY, 0o600)` → `writeSync(fd, canonical + "\n")` → `fsyncSync(fd)` → `closeSync(fd)`. The O_APPEND flag guarantees append atomicity for writes smaller than `PIPE_BUF` (typical entry is ~200-800 bytes). The session lock is the primary write-safety mechanism; O_APPEND is belt-and-braces.
- **Genesis handling**. Log absent (ENOENT) or empty → `prev_hash = SHA-256("")`. ENOENT is NOT an error.

### Field Ownership

| Field            | Owner                            | Behavior                                                                                                                                                                                                                                                                            |
| ---------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decision_type`  | Caller-required                  | Must match one of five enum values.                                                                                                                                                                                                                                                 |
| `operator`       | Caller-required                  | Non-empty.                                                                                                                                                                                                                                                                          |
| `timestamp`      | Caller-optional, writer-fallback | If caller supplies an ISO-8601 string, writer uses it verbatim. If caller omits, writer assigns `new Date().toISOString()`. Writer never overrides caller timestamp. Reconciles consumer `sg-e2e-baseline-metrics::as-004` AC1.1 (credential-rotation consumer supplies timestamp). |
| `prev_hash`      | Writer-assigned only             | Caller MUST NOT supply. Writer computes from log's last line (or genesis). Caller-supplied `prev_hash` → `SCHEMA_VIOLATION`.                                                                                                                                                        |
| Variant-specific | Caller-required per variant      | See Entry Schema table.                                                                                                                                                                                                                                                             |

### Error Codes

| Code               | Trigger                                                                                                                                                             | Recovery                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `SCHEMA_VIOLATION` | Merged entry fails Zod `AuditLogEntrySchema`, OR caller supplied `prev_hash`. Detail: Zod issues array.                                                             | Fix caller payload. Log unchanged.                                                                 |
| `LOCK_CONTENTION`  | `acquireLock(lockPath, {failOpen: false})` threw after its single 100ms retry. Detail includes `lockPath`.                                                          | Retry after back-off. Stale-lock recovery (age ≥ `staleThresholdMs` default 30000ms) is automatic. |
| `WRITE_FAILED`     | One of `openSync` / `writeSync` / `fsyncSync` / `closeSync` threw. Detail includes errno (EACCES, EIO, ENOSPC, EMFILE, …).                                          | Inspect fs state; free space / permissions as applicable. Log unchanged on failure.                |
| `READ_LAST_FAILED` | Unable to read the log's last line for prev_hash derivation. ENOENT is **excluded** — treated as genesis. Other errors (EACCES, EIO, malformed last line) map here. | Inspect fs state. Quarantine ritual may be appropriate for persistent corruption.                  |

## Core Flows

### Operator Edits Flag File + Appends Audit Entry

```
Operator (human terminal) → writes .claude/config/runtime-connectivity-enforcement.json
                              (workflow-file-protection.mjs: human writes pass; agent writes BLOCKED)
Operator → invokes append-audit-entry CLI with new mode
CLI      → acquireLock(rtc-enforcement-changes.log.lock)
         → readLastPrevHash(logPath)
         → merge {timestamp ?? now, ...params, prev_hash: computed}
         → AuditLogEntrySchema.safeParse(merged) → reject on SCHEMA_VIOLATION
         → canonical = jcsCanonicalize(merged)
         → openSync(O_APPEND|O_CREAT|O_WRONLY) → writeSync → fsyncSync → closeSync
         → releaseLock
         → return merged entry
```

### Agent Writes to Flag File or Audit Log → BLOCKED

`workflow-file-protection.mjs` PreToolUse hook catches:

- `Write` tool targeting `.claude/config/runtime-connectivity-enforcement.json` → exit 2, stderr block message naming the human-operator remediation path.
- `Write` tool targeting `.claude/audit/rtc-enforcement-changes.log` → exit 2.
- `Write` tool targeting `.claude/scripts/verify-rtc-enforcement-chain.mjs` → exit 2 (AC6.9 — the verifier script itself is protected so agents cannot disable verification).
- `Bash` tool with destructive ops (`>`, `>>`, `sed -i`, `truncate -s 0`, `rm`, `mv`, `node -e`, `python`, `perl`, `ruby`, `php -r`, `exec <`) against any of the three paths → blocked via the Bash-branch destructive-pattern set.
- Symlink bypass (`ln -s` a protected path + write via the symlink) → blocked via canonical realpath inode-match in `buildRealpathProtectedMap`.

Silent-drop's basenames remain protected under their own entries (`enforcement-changes.log`, `verify-enforcement-audit-chain.mjs`, `silent-drop-enforcement.json`). This workstream did not modify them.

### Gate 5 Chain Verification

Every Gate 5 evaluation that reads the enforcement flag also invokes `verifyChain(logPath)`:

```
Gate 5 → verifyChain(rtc-enforcement-changes.log)
       → expectedPrev = SHA-256("")
       → for each line:
           observed = entry.prev_hash
           if observed !== expectedPrev → return {status: "broken", break_at_entry: i, ...}
           expectedPrev = SHA-256(canonicalizeExcludingField(entry, "prev_hash"))
       → return {status: "clean", entry_count: N}
```

Chain break = HARD-FAIL **regardless of mode**, including `off`. A broken chain blocks enforcement resolution entirely (SEC-013).

### Path D: Quarantine Recovery Ritual

When chain verification reports a break and the operator determines it is legitimate corruption (e.g., partial fsync from a crash mid-write), NOT tampering:

1. Operator invokes `node .claude/scripts/quarantine-enforcement-audit.mjs --reason=<r> --operator=<op>`.
2. CLI reads the existing log bytes and computes `quarantined_file_sha256 = SHA-256(bytes).hex()`.
3. CLI renames `rtc-enforcement-changes.log` → `rtc-enforcement-changes.log.<YYYY-MM-DDTHH-MM-SS>.quarantine` via `fs.renameSync` (atomic on same filesystem).
4. CLI calls `appendEntry({decision_type: "quarantine", quarantined_file_sha256, quarantine_reason, operator})` against a fresh log. The first entry has `prev_hash = SHA-256("")` (new genesis).
5. Subsequent entries chain normally. Continuity across the recovery event is preserved via the `quarantined_file_sha256` cross-reference — an external auditor can hash the sealed file and match it to the new log's first-entry field.

Exit codes: `0` success / `1` usage (missing `--reason` or `--operator`) / `2` filesystem error (log missing, sealed path collision, rename failed). Pre-existing quarantine at the generated path (same-second collision) → exit 2; operator re-invokes with explicit `--date=<YYYY-MM-DDTHH-MM-SS>` to disambiguate.

## API Reference

### `parseFlag(jsonString, now?)` / `parseFlagStructural(jsonString)`

Module: `.claude/scripts/lib/enforcement-flag-schema.mjs`.

Parse and validate flag file bytes.

**Parameters**

| Name         | Type              | Notes                                                       |
| ------------ | ----------------- | ----------------------------------------------------------- |
| `jsonString` | `string`          | Raw file bytes.                                             |
| `now`        | `Date` (optional) | Injected for deterministic tests. Defaults to `new Date()`. |

**Returns**

```
{success: true, data: {mode, effective_at, operator}}
| {success: false, error: {code, message, issues}}
```

Error codes: `FLAG_FILE_MALFORMED` (JSON.parse threw; `issues: []`), `FLAG_VALIDATION_FAILED` (Zod rejected; `issues` is Zod issue array).

`parseFlag` applies past/future bounds; `parseFlagStructural` skips bounds (read-time validation is bound-agnostic because bounds are a write-time constraint).

**Example**

```js
import { parseFlag } from '.claude/scripts/lib/enforcement-flag-schema.mjs';

const bytes = readFileSync(
  '.claude/config/runtime-connectivity-enforcement.json',
  'utf-8',
);
const result = parseFlag(bytes);
if (!result.success) {
  if (result.error.code === 'FLAG_FILE_MALFORMED') {
    throw new Error(`Flag file corrupt: ${result.error.message}`);
  }
  // FLAG_VALIDATION_FAILED — schema violation; inspect result.error.issues
}
```

### `parseEntry(obj)` / `AuditLogEntrySchema`

Module: `.claude/scripts/lib/audit-log-entry-schema.mjs`.

Validate a parsed audit log entry against the discriminated-union schema.

**Parameters**

| Name  | Type      | Notes                                          |
| ----- | --------- | ---------------------------------------------- |
| `obj` | `unknown` | A parsed entry object (not a raw JSON string). |

**Returns**

```
{success: true, data}
| {success: false, error: {code: "ENTRY_VALIDATION_FAILED", message, issues}}
```

### `appendEntry(params, opts?)`

Module: `.claude/scripts/lib/enforcement-audit-writer.mjs`.

Synchronously append a hash-chained entry to the audit log.

**Parameters**

| Name           | Type                | Notes                                                                                                   |
| -------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| `params`       | `object`            | Variant-discriminated entry fields. MUST NOT include `prev_hash`. MAY include `timestamp`.              |
| `opts.logPath` | `string` (optional) | Defaults to `.claude/audit/rtc-enforcement-changes.log`. Also accepted as `params.logPath` (flat form). |

**Returns**

`AuditLogEntry` — the written entry, including writer-assigned `prev_hash` and (if caller omitted) `timestamp`. **Synchronous**: returned value is the entry directly; do NOT `await`.

**Throws**

Structured `Error & {code, detail, issues?}`. Codes: `SCHEMA_VIOLATION`, `LOCK_CONTENTION`, `WRITE_FAILED`, `READ_LAST_FAILED`. See § Error Codes.

**Example**

```js
import { appendEntry } from '.claude/scripts/lib/enforcement-audit-writer.mjs';

const entry = appendEntry({
  decision_type: 'mode-change',
  mode: 'coercive',
  effective_at: '2026-05-01T00:00:00.000Z',
  operator: 'alice',
});
// entry.prev_hash is writer-assigned; entry.timestamp defaults to new Date().toISOString()
```

### `resolveMode(opts?)`

Module: `.claude/scripts/lib/enforcement-mode-resolver.mjs`.

**Parameters**

| Name              | Type                                           | Notes                                                                   |
| ----------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| `sessionOverride` | `'advisory' \| 'coercive' \| 'off'` (optional) | `'off'` → throws `SESSION_CANNOT_SET_OFF`.                              |
| `default`         | mode enum (optional)                           | Default when no session override and no file. Defaults to `"advisory"`. |
| `flagPath`        | `string` (optional)                            | Defaults to `.claude/config/runtime-connectivity-enforcement.json`.     |
| `now`             | `Date` (optional)                              | Injected for tests. Defaults to `new Date()`.                           |
| `onWarn`          | `(msg: string) => void` (optional)             | Clock-skew warning sink. Defaults to `process.stderr.write`.            |

**Returns**

`{mode, source}` where `source ∈ {'session', 'file', 'default'}`. See § Mode Resolver Precedence.

**Throws**

- `SESSION_CANNOT_SET_OFF` — session override set to `"off"`.
- `FLAG_FILE_MALFORMED` — flag file JSON parse error (HARD-FAIL per EDGE-FA-10).
- `FLAG_VALIDATION_FAILED` — flag file schema rejection (HARD-FAIL).

File-absent is NOT an error — returns the default. Callers (Gate 5) decide whether to HARD-FAIL on the thrown parse errors.

### `appendReverseGovernanceEntry(params)`

Module: `.claude/scripts/lib/append-reverse-governance-entry.mjs`.

Typed wrapper over `appendEntry` with `decision_type: "reverse-governance"` pinned. Centralizes the decision_type literal for ops scripts.

**Parameters**

| Name        | Type                                                    | Notes                            |
| ----------- | ------------------------------------------------------- | -------------------------------- |
| `outcome`   | `'accepted' \| 'rejected' \| 'deferred' \| 'withdrawn'` | Required.                        |
| `trigger`   | `string`                                                | Required, non-empty.             |
| `rationale` | `string`                                                | Required, non-empty.             |
| `operator`  | `string`                                                | Required, non-empty.             |
| `logPath`   | `string` (optional)                                     | Passes through to `appendEntry`. |

**Returns**

The appended entry.

**SLA**: 10 business days from trigger to logged decision. **Documentation-only** — not automated. The helper's JSDoc reiterates the SLA for ops visibility.

### `verifyChain(logPath)` + CLI

Module / CLI: `.claude/scripts/verify-rtc-enforcement-chain.mjs`.

**Programmatic API**

```
verifyChain(logPath: string) => VerificationResult
```

`VerificationResult`:

```
{status: 'clean' | 'broken' | 'missing',
 entry_count: number,
 break_at_entry?: number,
 observed_hash?: string,
 expected_hash?: string}
```

**CLI**

```bash
node .claude/scripts/verify-rtc-enforcement-chain.mjs <logPath>
```

Exit codes: `0` clean / `1` broken / `2` missing. Stdout is the `VerificationResult` as JSON on one line.

**Behavior**

- Missing log file → `{status: 'missing', entry_count: 0}` (no throw; AC5.8).
- Empty log → `{status: 'clean', entry_count: 0}`.
- JSON.parse failure on any line → treated as break at that index; `observed_hash = '<parse-error>'`.
- `prev_hash` mismatch → `{status: 'broken', break_at_entry, observed_hash, expected_hash}`.

### Quarantine CLI

CLI: `.claude/scripts/quarantine-enforcement-audit.mjs`.

```bash
node .claude/scripts/quarantine-enforcement-audit.mjs \
  --reason=<human-readable rationale> \
  --operator=<operator identity> \
  [--log-path=<path>] \
  [--date=<YYYY-MM-DDTHH-MM-SS>]
```

**Arguments**

| Flag         | Required | Default                                                                                          |
| ------------ | -------- | ------------------------------------------------------------------------------------------------ |
| `--reason`   | Yes      | —                                                                                                |
| `--operator` | Yes      | —                                                                                                |
| `--log-path` | No       | `.claude/audit/rtc-enforcement-changes.log`                                                      |
| `--date`     | No       | `new Date().toISOString()` with colons/fractional seconds replaced (e.g., `2026-04-21T12-34-56`) |

**Exit codes**: `0` success / `1` usage error / `2` filesystem error (missing log, sealed-path collision, rename failed).

**Output** (stdout, JSON):

```json
{
  "status": "quarantined",
  "quarantined_path": "<original log path>.<date>.quarantine",
  "new_log_path": "<original log path>",
  "quarantined_file_sha256": "<64-char hex>"
}
```

### `workflow-file-protection.mjs` extension (as-006)

Module: `.claude/scripts/workflow-file-protection.mjs` (PreToolUse hook).

Three new basenames appended to `PROTECTED_FILENAMES` and mapped in `PROTECTED_FILE_DIRS`:

| Basename                                | Directory |
| --------------------------------------- | --------- |
| `runtime-connectivity-enforcement.json` | `config`  |
| `rtc-enforcement-changes.log`           | `audit`   |
| `verify-rtc-enforcement-chain.mjs`      | `scripts` |

No new branches or helpers were added — the hook's `sg-silent-drop-observability::DEC-004` refactor made the Write-branch dispatch fully data-driven via `PROTECTED_FILE_DIRS[protectedName]` (lines 1042-1049). Adding a row is sufficient for any directory. The Bash-branch realpath-match (`buildRealpathProtectedMap`) iterates `PROTECTED_FILE_DIRS` and picks up new entries automatically. Silent-drop's existing entries (`enforcement-changes.log`, `verify-enforcement-audit-chain.mjs`, `silent-drop-enforcement.json`, etc.) were not modified.

## Security Considerations

### Kill-Switch Tampering (SEC-007 / REQ-NFR-024)

Agent writes to `.claude/config/runtime-connectivity-enforcement.json` and `.claude/audit/rtc-enforcement-changes.log` are blocked by `workflow-file-protection.mjs`. Both the Write-tool branch (basename + dir-segment match) and the Bash-tool branch (substring + destructive-pattern match + canonical realpath inode-match for symlink bypass resistance) cover all new entries automatically via the data-driven dispatch. The hook uses fail-safe semantics — any hook error exits 0 — acceptable because the hook is defense-in-depth; agents have no legitimate write path.

### Hash-Chain Integrity (SEC-008 / REQ-NFR-025)

`prev_hash = SHA-256(canonicalizeExcludingField(prior, "prev_hash"))` links every entry to its predecessor. Modifying any historical entry invalidates every subsequent `prev_hash`. Chain verification is O(n) per read — acceptable through ~10k entries; mitigation ceiling is quarantine-rollover (Path D).

### Canonicalization (SEC-012 / REQ-NFR-025)

RFC 8785 JCS (sorted keys, no whitespace, fixed numeric form, UTF-8 NFC) eliminates serialization ambiguity. The existing `jcs-canonicalize.mjs` module provides sorted-key serialization and numeric normalization; UTF-8 NFC was added by the additive T2.X extension (see § Decision Log — "T2.X NFC extension"). NFC normalization applies to both string values and object keys so decomposed and precomposed forms of the same visual string produce byte-identical canonical output.

### Verification Triggers (SEC-013)

Chain verification runs on (a) every Gate 5 evaluation that reads the enforcement flag or audit log, (b) every `effective_at` flip attempt. Chain break = HARD-FAIL regardless of mode, including `off`.

### Session-Override Discipline (SEC-011 preservation)

The session override surface is deliberately weaker than the file surface: sessions can escalate or relax between `advisory` and `coercive`, but cannot set `off`. `off` is file-level only, and file edits are restricted to human-terminal operators. Guard: resolver rejects `sessionOverride === "off"` with `SESSION_CANNOT_SET_OFF`.

### Backdating Resistance (SEC-016)

The past-bound `effective_at >= now() - 5min` prevents operators from backdating a mode change to appear prospective. The 72-hour retrospective trigger for `mode: "off"` persistence uses the writer-assigned `timestamp` (wall-clock at write time), NOT `effective_at`. A successful backdate within 5 minutes cannot bypass the retrospective review.

### Data Classification

Both artifacts are classified `internal`. `operator` is the only PII field in either surface. No credentials, tokens, session IDs, or user data appear in either.

## Operator Workflows

### Setting a Mode Change

1. Open a terminal at the repository root (hook does not fire for direct shell edits outside Claude Code).
2. Edit `.claude/config/runtime-connectivity-enforcement.json` with `{mode, effective_at, operator}`. Use atomic-rename (`mv tmp actual`) for crash safety.
3. Append a `mode-change` audit entry via the ops ritual:
   ```bash
   node -e '
     import("./.claude/scripts/lib/enforcement-audit-writer.mjs").then(m => {
       const e = m.appendEntry({
         decision_type: "mode-change",
         mode: "coercive",
         effective_at: "2026-05-01T00:00:00.000Z",
         operator: "alice",
       });
       console.log(JSON.stringify(e, null, 2));
     });
   '
   ```
4. Verify the chain:
   ```bash
   node .claude/scripts/verify-rtc-enforcement-chain.mjs .claude/audit/rtc-enforcement-changes.log
   ```
   Expect `{"status":"clean",...}`.

### Scheduling a Future Flip

Operators set `effective_at` in the future (e.g., `2026-05-01T00:00:00.000Z`) to schedule a mode flip. The flag entry is NOT-YET-EFFECTIVE until wall-clock reaches that time; the resolver falls through to the caller-supplied default in the meantime. The audit log records the EDIT event immediately (via a `mode-change` entry with prospective `effective_at`). The flip becomes observable when wall-clock passes `effective_at`.

### Verifying the Chain

```bash
node .claude/scripts/verify-rtc-enforcement-chain.mjs .claude/audit/rtc-enforcement-changes.log
```

- Exit 0 + `{"status":"clean", "entry_count": N}` → chain intact.
- Exit 1 + `{"status":"broken", "break_at_entry": K, "observed_hash": "...", "expected_hash": "..."}` → tamper or corruption at entry K. Gate 5 HARD-FAILs. Investigate and, if the break is legitimate corruption, run the quarantine ritual below.
- Exit 2 + `{"status":"missing", "entry_count": 0}` → log file does not exist.

### Quarantine Recovery Ritual

If `verifyChain` reports a break AND the operator determines the break is legitimate corruption (not tampering):

```bash
node .claude/scripts/quarantine-enforcement-audit.mjs \
  --reason="Partial fsync during crash on 2026-04-21T09:30" \
  --operator="alice"
```

The CLI prints:

```json
{
  "status": "quarantined",
  "quarantined_path": ".claude/audit/rtc-enforcement-changes.log.2026-04-21T12-34-56.quarantine",
  "new_log_path": ".claude/audit/rtc-enforcement-changes.log",
  "quarantined_file_sha256": "<64-char hex>"
}
```

The sealed file is immutable (no further appends). The new log has exactly one entry — the `quarantine` entry with `prev_hash = SHA-256("")` and `quarantined_file_sha256` cross-referencing the sealed file. Subsequent entries chain normally.

External auditors verify continuity by running `shasum -a 256 <quarantined_path>` and matching against the new log's first-entry `quarantined_file_sha256`.

### Reverse-Governance Decision Entry

For recording a reverse-governance decision (BIZ-008 — used when an enforcement decision is reversed after the fact):

```js
import { appendReverseGovernanceEntry } from './.claude/scripts/lib/append-reverse-governance-entry.mjs';

appendReverseGovernanceEntry({
  outcome: 'accepted', // or 'rejected' | 'deferred' | 'withdrawn'
  trigger: 'Security incident #42 disputed mode-change audit entry',
  rationale: 'Reviewed with on-call; original change was procedurally correct.',
  operator: 'alice',
});
```

SLA: 10 business days from trigger to logged decision — **documentation-only**, not enforced.

## Testing Surface

| Atomic                           | Test file                                                               | ACs                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| as-001 flag schema               | `enforcement-flag-audit/enforcement-flag-schema.test.mjs`               | AC1.1-AC1.7 (13 tests)                                                                                                                                       |
| as-002 canonicalizer helpers     | `enforcement-flag-audit/jcs-canonicalize-helpers.test.mjs`              | AC2.1-AC2.6 (6 blocks + 1k/500 property tests)                                                                                                               |
| as-003 writer                    | `enforcement-flag-audit/enforcement-audit-writer.test.mjs`              | AC3.1-AC3.6 (11 tests)                                                                                                                                       |
| as-004 entry schema              | `enforcement-flag-audit/audit-log-entry-schema.test.mjs`                | AC4.1-AC4.9 (13 tests)                                                                                                                                       |
| as-005 verifier                  | `enforcement-flag-audit/verify-rtc-enforcement-chain.test.mjs`          | AC5.1-AC5.9 (9 tests)                                                                                                                                        |
| as-006 file protection           | `enforcement-flag-audit/workflow-file-protection.rtc.test.mjs`          | AC6.1-AC6.10 (11 regression tests)                                                                                                                           |
| as-007 mode resolver             | `enforcement-flag-audit/enforcement-mode-resolver.test.mjs`             | AC7.1-AC7.9 (9 tests)                                                                                                                                        |
| as-008 quarantine CLI            | `enforcement-flag-audit/quarantine-enforcement-audit.test.mjs`          | AC8.1-AC8.7 (7 tests)                                                                                                                                        |
| as-009 reverse-governance helper | `enforcement-flag-audit/append-reverse-governance-entry.test.mjs`       | AC9.1-AC9.5 (9 tests)                                                                                                                                        |
| as-010 integration               | `enforcement-flag-audit/enforcement-audit.integration.test.mjs`         | AC10.1-AC10.10                                                                                                                                               |
| Runtime-connectivity E2E         | `tests/e2e/sg-e2e-enforcement-flag-audit.runtime-connectivity.spec.mjs` | Seam A (writer↔verifier), Seam C (quarantine round-trip). Seam B skipped — resolver `e2e_skip: true`; downstream hook belongs to `sg-e2e-gate5-enforcement`. |

Current counts: 98/98 unit + 3/3 E2E passes (1 documented skip).

## Decision Log

### Silent-Drop Basename Collision → `rtc-` Prefix Rename (SEC-007)

**Decision**: All colliding basenames adopt the `rtc-` prefix. Affected paths: `verify-rtc-enforcement-chain.mjs`, `rtc-enforcement-changes.log`. The flag file `runtime-connectivity-enforcement.json` is unique and retained.

**Context**: During investigation convergence (finding inv-crit-5b9a2f14, Critical, security-tagged SEC-007), a direct source read of `workflow-file-protection.mjs:238,389` confirmed that basenames `verify-enforcement-audit-chain.mjs` and `enforcement-changes.log` are already live — owned by the landed `sg-silent-drop-observability` workstream. Silent-drop's audit chain lives at `.claude/audit/enforcement-changes.log`.

**Why a rename was required**: `Array.push` does not dedup. Re-adding either basename to `PROTECTED_FILENAMES` would have created duplicate entries, potentially breaking silent-drop's regression tests (which assert on array length). More dangerously, writing to those basenames would have interleaved two distinct audit chains in the same file — corrupting silent-drop's landed hash chain.

**Alternatives rejected**: Sharing the audit log and verifier with silent-drop would have required a cross-workstream schema change (silent-drop's entries have a different discriminator surface) and a merged verifier that understands both decision taxonomies. That was scope creep; the `rtc-` prefix is a pure spec-level rename with zero implementation impact on silent-drop.

**Alternative to the collision itself**: the silent-drop basename `enforcement-changes.log` is generic (no `silent-drop-` prefix); a future refactor could rename it — but silent-drop is landed production infrastructure and this workstream took the prefix cost to avoid touching it. See [SILENT-DROP-OBSERVABILITY.md](SILENT-DROP-OBSERVABILITY.md) for silent-drop's system reference.

### T2.X NFC Extension + Cross-Consumer Scan Obligation (SEC-008)

**Decision**: Extend `.claude/scripts/lib/jcs-canonicalize.mjs` additively with `.normalize('NFC')` on every string value (and object key) before `JSON.stringify` emission. Scope obligation: scan all existing consumer log files and fixtures for non-NFC strings before merging.

**Context**: During the second challenger pass (finding chk-contract-d3e8f2a1, High, not security-tagged), a direct source read of `jcs-canonicalize.mjs:28-51` confirmed the module did NOT perform NFC normalization — strings passed through `JSON.stringify` only (which handles JSON escapes but not Unicode NFC). REQ-NFR-025 explicitly requires UTF-8 NFC in the JCS canonical bytes.

**Retroactive chain-break risk**: `jcs-canonicalize.mjs` is a shared module with multiple consumers beyond this workstream: `deployment-audit.mjs`, `verify-deployment-audit-chain.mjs`, silent-drop-observability's `verify-enforcement-audit-chain.mjs`, and silent-drop fixture files (`enforcement-changes.log.valid`, `.forged`, `.quarantined`). The T2.X edit is API-preserving (no function signature change), but if any consumer's landed log bytes contain non-NFC strings, post-T2.X reads of those bytes would produce hashes that no longer match historical `prev_hash` values — breaking those chains retroactively.

**A4 scan resolution** (elevated during inv-high-c72d8103 to explicit scan obligation):

| Consumer Module                                                    | Test Status | Notes                                                    |
| ------------------------------------------------------------------ | ----------- | -------------------------------------------------------- |
| `.claude/scripts/lib/deployment-audit.mjs`                         | PASS        | `deployment-audit-log.test.mjs` 35/35 post-T2.X.         |
| `.claude/scripts/verify-deployment-audit-chain.mjs`                | PASS        | Chains intact.                                           |
| `.claude/scripts/verify-enforcement-audit-chain.mjs` (silent-drop) | PASS        | ASCII fixtures; no non-NFC bytes.                        |
| silent-drop fixtures under `__tests__/silent-drop/fixtures/`       | PASS        | No chained JSONL fixtures under the dir — only markdown. |

T2.X is backward-compatible for all current consumers (354 cross-consumer tests pass).

**Why additive, not replacement**: The parent spec's Non-goal "No replacement of jcs-canonicalize.mjs" stands. T2.X is a single-line `.normalize('NFC')` addition to the string branch (plus object keys); module identity, API surface, and all non-string paths are unchanged. Extension is not replacement.

### AuditLogWriter Contract Canonicalization

Four investigation findings tightened the `contract-audit-log-writer` surface before implementation:

1. **Synchronicity** (inv-high-4e1a9d52): `appendEntry` is synchronous — returns `AuditLogEntry` directly, NOT a Promise. Sync `fs.*Sync` I/O gives deterministic fsync-before-return semantics without Promise wrapping. Consumer `sg-e2e-baseline-metrics::as-004` already expected sync; the parent contract now pins `synchronicity: synchronous` explicitly.
2. **Field ownership — timestamp** (inv-high-8a3b6f91): Caller-supplied `timestamp` wins; writer fills with `new Date().toISOString()` only when caller omits. Previous rule ("writer ignores caller timestamp") was reversed because consumer baseline-metrics as-004 AC1.1 supplies `timestamp` and expects it to appear verbatim in the log.
3. **Field ownership — prev_hash** (inv-high-8a3b6f91): Strictly writer-assigned. Caller-supplied `prev_hash` → `SCHEMA_VIOLATION` with detail `reason: "prev_hash is writer-assigned; caller must not supply"`. No silent-strip option.
4. **Error codes enumerated** (inv-med-2f4c5e67): `SCHEMA_VIOLATION`, `LOCK_CONTENTION`, `WRITE_FAILED`, `READ_LAST_FAILED`. `READ_LAST_FAILED` explicitly excludes ENOENT (treated as genesis, not a failure).

Also (chk-contract-9a2f81c7): error code renamed `LOCK_TIMEOUT` → `LOCK_CONTENTION` to match the actual `session-lock.mjs` signature (`acquireLock(lockPath, {failOpen?, staleThresholdMs?})` — no `timeout` parameter; contention handled by a single 100ms retry, stale-lock recovery via default 30000ms threshold).

### AS-007 Not-Yet-Effective Fallthrough

**Decision**: When the flag file's `effective_at > now`, the resolver treats the entry as NOT-YET-EFFECTIVE and falls through to the next lower precedence (default). Return `{mode: defaultMode, source: "default"}` with no error and no warning. The flag file is preserved on disk.

**Context**: Parent `EnforcementModeResolver` behavioral contract previously listed precedence but did not explicitly address not-yet-effective flag entries. as-007 Assumption A2 was "Needs Review". Finding inv-med-9d7a1c85 (investigation convergence) codified the rule.

**Rationale**: Operators set `effective_at` in the future to schedule a mode flip (e.g., "coercive starting 2026-05-01T00:00Z"). Until wall-clock reaches that time, the flag is advisory-of-future-state; the system behaves per the default (caller-supplied). Treating a future `effective_at` as "not-yet-effective" matches operator intent — the flip has not occurred yet — and avoids premature mode changes that would surprise on-call staff. The audit log records the EDIT event immediately (via a `mode-change` entry with prospective `effective_at`); the actual flip becomes observable when wall-clock passes `effective_at`.

**Contract codification**: Parent contract `precedence` now carries an explicit rule:

```
3. File mode with effective_at in the future (effective_at > now):
   flag entry is NOT-YET-EFFECTIVE. Resolver falls through to next
   lower precedence (default). Return {mode: defaultMode, source: "default"}.
```

Plus a `not_yet_effective_rationale` block explaining operator intent. AC7.8 already matched the new rule; no AC change was needed.

## See Also

- [SILENT-DROP-OBSERVABILITY.md](SILENT-DROP-OBSERVABILITY.md) — The sibling audit chain at `.claude/audit/enforcement-changes.log`. Distinct from this system.
- [AUDIT-LOG.md](AUDIT-LOG.md) — The kill-switch audit log at `.claude/audit/kill-switch.log.jsonl`. Another distinct audit chain (operator kill-switch toggle events).
- [HOOKS.md](HOOKS.md) — `workflow-file-protection.mjs` reference, `PROTECTED_FILENAMES` / `PROTECTED_FILE_DIRS` extension pattern.
- [WORKFLOW-ENFORCEMENT.md](WORKFLOW-ENFORCEMENT.md) — Enforcement-layer architecture, kill-switch scope, override mechanism.
- `.claude/specs/groups/sg-e2e-enforcement-flag-audit/spec.md` — Authoritative spec with full Decision Log, atomic spec references, acceptance criteria.
- `.claude/specs/groups/sg-e2e-runtime-connectivity/spec.md` — Parent MasterSpec; runtime-connectivity Gate 5 consumer.
- `.claude/specs/groups/sg-e2e-gate5-enforcement/spec.md` — Downstream consumer workstream (applies the resolved mode at Gate 5).

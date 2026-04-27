<!-- design-doc-id: test-writer-unlock-state-signals -->
<!-- owner-spec: sg-pipeline-efficiency-ws2-practice-2.4 -->
<!-- req-ref: REQ-005 (AC-005.1 through AC-005.11) -->
<!-- status: canonical -->
<!-- date: 2026-04-22 -->

# Design Doc: test_writer_unlock State Signals

## Purpose

Canonical reference for the `test_writer_unlock` state machine introduced by ws-2 Practice 2.4 refinement. Satisfies R-HYBRID-NO-PRECEDENT: no hybrid-mode code path ships before this doc is merged. Downstream atomic specs (as-003 through as-008) cite it by section.

Scope: field shapes, state machine edges, HMAC-SHA256 marker protocol, 5 re-fence triggers, 5-step cooperative-check gate sequence, and every structured error code. All Open Questions from spec.md resolved concretely here (Q1 + Q2).

## Requirement Coverage

| AC-ID     | Covered by section                          | Atomic spec owner |
| --------- | ------------------------------------------- | ----------------- |
| AC-005.1  | §1 Fields, §2 State Machine (Eligible edge) | as-001            |
| AC-005.2  | §2 State Machine (Fenced sink), §6 Errors   | as-006            |
| AC-005.3  | §1 Fields, §3 Marker Protocol (mint path)   | as-003            |
| AC-005.4  | §3 Marker Protocol, §5 Cooperative-check    | as-004, as-006    |
| AC-005.5  | §5 Cooperative-check (all 5 gates)          | as-006            |
| AC-005.6  | §4 Re-fence Triggers (all 5)                | as-005            |
| AC-005.7  | §6 Errors (UNLOCK_MODE_MISMATCH)            | as-003            |
| AC-005.8  | §1 Fields (sole_writer invariant)           | as-003            |
| AC-005.9  | §4 Re-fence Triggers (misuse heartbeat)     | as-008            |
| AC-005.10 | §7 Audit Log Entry Shape                    | as-007            |
| AC-005.11 | This doc existing + §5 unit-test contract   | as-002 (this doc) |

## 1. Fields and Shape: TestWriterUnlockEntry

### 1.1 Storage location

- Key-addressed entries live at `session.json.test_writer_unlock[<spec-group-id>]`.
- `session.json` is FULL_BLOCK in `workflow-file-protection.mjs`; only `session-checkpoint.mjs` may write.
- The `.test_writer_unlock` sub-object has ONE sole writer: the CLI subcommand `node .claude/scripts/session-checkpoint.mjs record-test-writer-unlock` (as-003).

### 1.2 Entry field shape

```yaml
TestWriterUnlockEntry:
  spec_group_id: string # primary key; uniquely identifies the spec-group this unlock belongs to
  first_failure_at: string # ISO-8601 UTC timestamp of the first failing test run that triggered unlock eligibility
  unlocked_until: string # ISO-8601 UTC timestamp; EXACTLY first_failure_at + 5 minutes
  dispatch_id: string # dispatch identifier recorded at unlock time; cooperative-check verifies match
  marker: string # 64-hex-char HMAC-SHA256 output; see §3 Marker Protocol
```

All 5 fields are REQUIRED. Absent/null values cause cooperative-check to fail closed with `UNLOCK_REVOKED` (see §5).

### 1.3 TTL invariant

- TTL is exactly **5 minutes** (300 seconds) measured from `first_failure_at`.
- Anchored ONCE at record time. Never recomputed on each cooperative-check (prevents clock-skew drift per EC-WS2-6).
- Monotonic session clock used if available; fallback to system UTC.

### 1.4 Sole-writer invariant (AC-005.8)

- Path `.session.json.test_writer_unlock[*]` is protected by the existing FULL_BLOCK basename list in `workflow-file-protection.mjs`.
- Any non-sole-writer write (agent Edit/Write to `session.json`, or another script mutating `test_writer_unlock`) is rejected at PreToolUse hook time.
- `session-checkpoint.mjs record-test-writer-unlock` is the ONLY legitimate write path. The ONLY clear path is the re-fence predicate also inside `session-checkpoint.mjs` (as-005).

### 1.5 Per-key isolation (EC-WS2-2)

- Concurrent bug-fix workstreams each hold a separate entry keyed by `spec_group_id`.
- No cross-workstream leakage: cooperative-check for sg-X only inspects the sg-X entry; sg-Y state cannot grant reads on sg-X.

## 2. State Machine

### 2.1 States

| State    | Meaning                                                                      |
| -------- | ---------------------------------------------------------------------------- |
| Fenced   | No `test_writer_unlock[<sg-id>]` entry exists. Strict isolation. Default.    |
| Eligible | Spec has `spec_mode: bug-fix`; test-writer has produced a first failing run. |
| Unlocked | Entry exists with TTL unexpired and marker valid. Hybrid reads permitted.    |
| Expiring | Entry exists but `unlocked_until <= now()`. Next cooperative-check fails.    |

### 2.2 State machine diagram

```
          +----------+
          |  Fenced  |  <--- initial + terminal (re-fence sink)
          +----+-----+
               |
               | spec_mode == "bug-fix" AND first failing run recorded
               v
          +----+-----+
          | Eligible |  (pre-CLI; no session.json entry yet)
          +----+-----+
               |
               | operator invokes record-test-writer-unlock (as-003)
               | CLI preflight: spec_mode == bug-fix → mint marker → write entry
               v
          +----+-----+
          | Unlocked |
          +----+-----+
          |         |
          | TTL     | any of 5 re-fence triggers (§4)
          | expires |        OR
          v         |        cooperative-check failure
     +---------+    |        (§5 UNLOCK_REVOKED)
     | Expiring|    |
     +----+----+    |
          |         |
          +---+-----+
              v
           Fenced
```

### 2.3 Edge rules

| Edge                    | Guard                                                 | Effect                                                                                 |
| ----------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Fenced → Eligible       | `manifest.spec_mode == "bug-fix"` + first failing run | No persisted state change yet; operator may invoke CLI                                 |
| Eligible → Unlocked     | CLI `record-test-writer-unlock` preflight passes      | Mint marker, write entry via sole-writer path, append `test_writer_unlock` audit entry |
| Eligible → Fenced       | CLI preflight rejects (`spec_mode != bug-fix`)        | Exit 1, `UNLOCK_MODE_MISMATCH`, no state change, no audit entry                        |
| Unlocked → Unlocked     | Cooperative-check passes on each impl read            | Permit read; no state change                                                           |
| Unlocked → Expiring     | `unlocked_until <= now()`                             | Next cooperative-check raises `UNLOCK_REVOKED`                                         |
| Unlocked → Fenced       | Any of 5 re-fence triggers (§4)                       | Sole-writer clears entry; append `test_writer_unlock_refence` audit entry              |
| Expiring → Fenced       | Next cooperative-check attempt OR re-fence trigger    | Entry cleared; test-writer reverts to fenced mode after one retry (`TIMEOUT`)          |
| Fenced → Fenced (no-op) | Any trigger fires without pre-existing entry          | Predicate is idempotent; no session.json mutation, no audit entry                      |

### 2.4 Feature-mode path (AC-005.2)

- For `spec_mode` absent OR `spec_mode != "bug-fix"`, the state machine is PINNED to `Fenced`.
- Fenced → Eligible edge is never traversed. No CLI invocation can succeed (preflight rejects).
- Hook blocks all impl reads regardless of any `test_writer_unlock` state that might somehow exist.
- This is the fail-closed default.

## 3. Cryptographic Marker Protocol (HMAC-SHA256)

### 3.1 Why cryptographic marker, not string field (SEC-003 Pass 3)

- A string-only unlock marker could be forged by any agent that can write to session.json (modulo FULL_BLOCK).
- Even with FULL_BLOCK, defense-in-depth: hook-level verification prevents a compromised writer from trivially self-issuing unlocks.
- Marker is minted at record time with per-session secret; hook re-computes and compares in constant time.

### 3.2 Secret lifecycle (Q1 resolution)

**Decision**: HMAC-SHA256 keyed on a per-session-rotation ephemeral secret.

- **Storage path**: `.claude/coordination/.session-hmac-<session-id>`
- **Mode**: `0600` (owner read/write only)
- **Generation**: `crypto.randomBytes(32)` → 256-bit key
- **Bootstrap**: `session-checkpoint.mjs start-work` generates the file if absent, using atomic write-to-temp-and-rename. Create operation is serialized by `.claude/coordination/session.lock` to prevent concurrent-dispatch races.
- **Teardown**: `session-checkpoint.mjs close-work` OR `archive-incomplete` deletes the secret file. The secret outlives a session only on uncontrolled crash; next session regenerates.
- **Rotation**: per-session only; no mid-session rotation. Old markers from a prior session cannot verify under the new secret. This is intentional — session end is a re-fence trigger (§4 trigger 5).
- **Write protection**: the basename pattern `.session-hmac-*` is added to `workflow-file-protection.mjs` FULL_BLOCK. Only `session-checkpoint.mjs` may write or delete. (Owned by as-004b.)

### 3.3 Marker derivation (mint)

```
marker = hmac_sha256(
  key = <session-hmac secret bytes>,
  message = spec_group_id || "|" || dispatch_id || "|" || first_failure_ref || "|" || unlocked_until_iso8601
)
```

- Output: 32 raw bytes → hex-encoded → 64-char lowercase hex string.
- Separator `|` is literal ASCII 0x7C. All inputs are joined as UTF-8 strings.
- `unlocked_until_iso8601` is the exact string stored in the entry's `unlocked_until` field. Hook must use the stored value, not a recomputed one.

### 3.4 Marker verification

Hook (as-006) recomputes marker over the stored inputs and compares with `crypto.timingSafeEqual`.

```
expected = hmac_sha256(session_secret, msg_from_stored_entry_fields)
valid = crypto.timingSafeEqual(expected, hex_decode(entry.marker))
```

- Constant-time comparison is mandatory (timing oracle resistance).
- If `entry.marker` length != 64 hex chars, verification fails without calling timingSafeEqual (length mismatch throws).
- If secret file is absent or unreadable, verification fails closed (all reads blocked).

### 3.5 Agent-visibility guarantee

- The secret file is never read by any agent other than `session-checkpoint.mjs` (mint path) and the PreToolUse hook (verify path).
- Both are system-level scripts; neither exposes the secret to test-writer or any other dispatched agent.
- Marker values stored in session.json ARE visible to agents (session.json is read-permissible to subagents), but possession of the marker without the secret cannot forge a valid unlock for different inputs.

### 3.6 Escalation (future)

If the ephemeral-secret approach proves insufficient (cross-session audit replay, etc.), upgrade to signed-commit-derived key in a follow-up spec. Not blocking ws-2.

## 4. Re-fence Triggers (5)

All 5 triggers clear `test_writer_unlock[<sg-id>]` via the sole-writer path and append a `test_writer_unlock_refence` audit entry with a `trigger` label identifying which fired. Predicate lives in `session-checkpoint.mjs` (as-005).

### 4.1 Trigger table

| #   | Label               | Source signal                                                                | Owning atomic spec | AC coverage |
| --- | ------------------- | ---------------------------------------------------------------------------- | ------------------ | ----------- |
| 1   | `spec-complete`     | `manifest.review_state` transitions to `APPROVED`                            | as-005             | AC-005.6    |
| 2   | `test-pass`         | Unifier records first green test pass for the spec-group                     | as-005             | AC-005.6    |
| 3   | `version-bump`      | `spec.md` `date` OR content_hash changes during a live unlock window         | as-005             | AC-005.6    |
| 4   | `workstream-rotate` | Facilitator rotation hook fires for this spec-group                          | as-005             | AC-005.6    |
| 5   | `session-end`       | `archive-incomplete` OR `complete-work` subcommand enters session-checkpoint | as-005             | AC-005.6    |

### 4.2 Predicate serialization (Q2 resolution)

**Decision**: session-checkpoint.mjs is the serialization point; the re-fence predicate runs inside the checkpoint transaction.

- All 5 trigger sources enter `session-checkpoint.mjs` before side effects land.
- The predicate `evaluateRefenceTrigger({ specGroupId, event })` executes within the same write-transaction boundary as the trigger's own effect.
- This guarantees: for a given `spec-group-id`, unlock clear (when applicable) happens BEFORE the next test-writer dispatch arrives — because both the clear and any subsequent dispatch pass through the checkpoint serialization.

### 4.3 Idempotency

- If no unlock exists for `sg-id` when a trigger fires, the predicate is a no-op. No session.json write. No audit entry.
- If two triggers fire for the same `sg-id` in close succession, the second is a no-op.

### 4.4 Trigger completeness

- The 5 triggers are exhaustive per SEC-004 Pass 2. Any new session lifecycle event that reasonably ought to clear unlock state MUST be added to this table and wired into `evaluateRefenceTrigger`.
- Adding a 6th trigger requires a follow-up spec amendment citing this §4.

### 4.5 Misuse heartbeat (AC-005.9, EC-WS2-7)

- **Not a re-fence trigger**. Observability only.
- Stop hook (as-008) compares dispatch edit list against test-path globs (`__tests__/`, `tests/`).
- If an unlock was active AND zero test files changed, emit `UNLOCK_USED_NO_TESTS` advisory warning + `test_writer_unlock_misuse` audit entry.
- Non-blocking. The dispatch still completes successfully; the entry still TTL-expires normally (or is cleared by one of the 5 triggers).

## 5. Cooperative-check Gate Sequence (5 steps)

Runs in the PreToolUse test-writer isolation hook (as-006) on every implementation-file read attempt during a potential unlock window. Propagation SLA: **< 1 second** per SEC-003 Pass 3.

### 5.1 Ordered gate steps

| #   | Step                                       | Failure → error code              |
| --- | ------------------------------------------ | --------------------------------- |
| 1   | Atomic-read session.json entry             | `UNLOCK_REVOKED` (if absent)      |
| 2   | Check `unlocked_until > now()`             | `UNLOCK_REVOKED` (TTL expired)    |
| 3   | Check `dispatch_id == current_dispatch_id` | `UNLOCK_REVOKED` (mismatch)       |
| 4   | Verify HMAC marker (timingSafeEqual)       | `UNLOCK_REVOKED` (forgery/tamper) |
| 5   | Permit read                                | N/A (pass)                        |

If any of steps 1-4 fails, emit `UNLOCK_REVOKED`; retry once yields `TIMEOUT`; then revert to fenced mode.

### 5.2 Atomic-read protocol

Step 1 must be atomic to avoid TOCTOU between read and check:

- `lstat(session.json.path)` → verify not symlink
- `realpath(session.json.path)` → verify resolved path equals expected canonical path
- `open(session.json.path, O_NOFOLLOW)` → reject if path is a symlink
- Read full content; parse JSON; extract `test_writer_unlock[<sg-id>]`.

### 5.3 Fail-closed defaults

The hook fails closed (blocks the read) under any of:

- `session.json` unreadable or malformed JSON
- `test_writer_unlock[<sg-id>]` field absent
- `manifest.spec_mode != "bug-fix"` (feature-mode spec)
- Any field in the entry missing or malformed
- Session HMAC secret file unreadable
- Marker verification throws (length mismatch, hex decode error)

### 5.4 Retry semantics

- First failed cooperative-check → `UNLOCK_REVOKED`.
- Test-writer retry → second cooperative-check → if still failing → `TIMEOUT`.
- After `TIMEOUT`, test-writer reverts to fenced mode for remainder of dispatch. No further retries.
- In-flight reads already permitted are not retroactively revoked (EC-WS2-3).

### 5.5 Unit-test contract (AC-005.11 precedent)

Unit tests for these components MUST land BEFORE as-006 wiring:

- CLI preflight + mint + write (`session-checkpoint.mjs record-test-writer-unlock`) — as-003 tests
- Marker mint/verify (HMAC-SHA256 round-trip, timingSafeEqual call path, tamper detection) — as-004 tests
- 5-trigger re-fence predicate (table: 5 triggers × {unlock-present, unlock-absent}) — as-005 tests

## 6. Structured Error Codes

Every error code used by the state machine. All are structured enum values — never raw strings.

### 6.1 `UNLOCK_MODE_MISMATCH`

- **Triggering condition**: CLI `record-test-writer-unlock` invoked against a spec whose manifest has `spec_mode` absent OR `spec_mode != "bug-fix"`.
- **Receiver behavior**: CLI exits 1 with stderr `UNLOCK_MODE_MISMATCH`. No session.json write. No audit entry.
- **Source AC**: AC-005.7
- **Owning atomic spec**: as-003

### 6.2 `UNLOCK_REVOKED`

- **Triggering condition**: Any cooperative-check step (§5) fails during a read attempt — TTL expired, dispatch_id mismatch, marker forged, entry absent, session.json unreadable.
- **Receiver behavior**: Hook blocks the read; test-writer receives blocked-read error; dispatch continues in fenced mode pending retry.
- **Source AC**: AC-005.5
- **Owning atomic spec**: as-006

### 6.3 `TIMEOUT`

- **Triggering condition**: Second consecutive cooperative-check failure after a `UNLOCK_REVOKED` retry attempt.
- **Receiver behavior**: Hook blocks the read; test-writer reverts to fenced mode for remainder of dispatch; no further unlock attempts within this dispatch.
- **Source AC**: AC-005.5
- **Owning atomic spec**: as-006

### 6.4 `GENESIS_ANCHOR_INVALID`

- **Triggering condition**: Hash-chain genesis anchor cannot be read or verified at unlock-record time (detected BEFORE session.json write).
- **Receiver behavior**: CLI exits 2 with stderr `GENESIS_ANCHOR_INVALID`. **Fail-closed rejection** — no session.json write, no audit entry, no deferred-audit queue. Operator MUST resolve the genesis anchor (ws-1 repair path) before re-attempting the unlock. This aligns with ws-1's hash-chain invariant (inv-dep-6e2d4a amendment).
- **Source AC**: AC-7.3 (as-007 § AC7.3)
- **Owning atomic spec**: as-007

### 6.5 `CHAIN_BROKEN`

- **Triggering condition**: Generic audit-chain failure during append (not genesis-specific) — e.g., prev_hash mismatch, write error on audit log, chain-helper internal error.
- **Receiver behavior**: CLI exits 3 with stderr `CHAIN_BROKEN`. Merge-blocking downstream: unifier/code-review/security gates reject the workstream until chain integrity is restored. No session.json write unless the chain error occurs AFTER session.json commit (operationally discouraged by as-007 ordering).
- **Source AC**: AC-005.10 (chain-integrity invariant)
- **Owning atomic spec**: as-007

## 7. Audit Log Entry Shape (cross-reference to spec.md § Audit log entry shape)

Every unlock/re-fence/misuse event appends a hash-chained entry to `.claude/audit/pipeline-efficiency-changes.log` via ws-1's `appendAuditEntry` helper (from sg-pipeline-efficiency-ws1-convergence-pruning as-017).

### 7.1 Payload shape

```yaml
AuditEntry:
  seq: integer # monotonic per-chain sequence number
  prev_hash: string # hex digest of prior entry; anchors to genesis for entry 1
  timestamp: string # ISO-8601 UTC
  event_class: string # one of: test_writer_unlock | test_writer_unlock_refence | test_writer_unlock_misuse
  spec_group_id: string
  dispatch_id: string # present on test_writer_unlock; absent on misuse-without-dispatch
  first_failure_ref: string # present on test_writer_unlock
  unlocked_until: string # ISO-8601; present on test_writer_unlock
  trigger: string # present on test_writer_unlock_refence; one of §4.1 labels
  operator_or_agent: string # session-user reference (not PII)
```

### 7.2 Chain integrity

- Genesis anchor seeded by ws-1 (NFR-HASH-CHAIN-VERIFY).
- ws-2 appends only. No rotation, no rewrite.
- Verification: `verify-audit-chain.mjs --include-rotations` over interleaved ws-1/ws-2 entries.
- Chain failure → `CHAIN_BROKEN` (§6.5); genesis failure at unlock-time → `GENESIS_ANCHOR_INVALID` fail-closed (§6.4).

### 7.3 Event-class ownership

- `test_writer_unlock` — emitted by as-003 CLI on successful unlock record.
- `test_writer_unlock_refence` — emitted by as-005 predicate on successful re-fence clear (one of 5 triggers).
- `test_writer_unlock_misuse` — emitted by as-008 Stop-hook on misuse-heartbeat pattern.

### 7.4 Direct-write prohibition

- `.claude/audit/pipeline-efficiency-changes.log` is NOT in FULL_BLOCK (genesis + sentinel paths remain FULL_BLOCK per EDGE-019 operator-only signed-commit carve-out).
- All ws-2 writes MUST route through `appendAuditEntry`. No direct `fs.write` to the audit log.

## 8. Atomic Spec Ownership Map

| Mechanism                                         | Atomic spec | ACs covered                  |
| ------------------------------------------------- | ----------- | ---------------------------- |
| `spec_mode` manifest schema (fail-closed default) | as-001      | AC-005.1, AC-005.2           |
| This design doc (R-HYBRID-NO-PRECEDENT)           | as-002      | AC-005.11                    |
| `record-test-writer-unlock` CLI (sole writer)     | as-003      | AC-005.3, AC-005.7, AC-005.8 |
| Marker mint/verify library (HMAC-SHA256)          | as-004      | AC-005.4, AC-005.5           |
| Session HMAC secret bootstrap/teardown            | as-004b     | Q1 resolution wiring         |
| 5-trigger re-fence predicate                      | as-005      | AC-005.6                     |
| PreToolUse cooperative-check hook                 | as-006      | AC-005.2, AC-005.4, AC-005.5 |
| Audit-log emission (3 event classes)              | as-007      | AC-005.10                    |
| Stop-hook misuse detection                        | as-008      | AC-005.9                     |

Later atomic specs (as-009 docs/agent updates; as-010 baseline; as-011 metrics runner; as-012 integration/contract/negative tests; as-013 CLI entry wiring) depend on the mechanisms above but do not introduce new state-machine semantics beyond what this doc specifies.

## 9. Open Questions (Resolved)

### 9.1 Q1 — Marker derivation source

**RESOLVED** (2026-04-22, Pass 1). Full design in §3 Marker Protocol above. Summary:

- HMAC-SHA256 keyed on per-session ephemeral secret at `.claude/coordination/.session-hmac-<session-id>`.
- Lifecycle owned by `session-checkpoint.mjs` start-work / close-work. as-004b ships bootstrap + teardown + FULL_BLOCK registration.

### 9.2 Q2 — Workstream-rotate sequencing

**RESOLVED** (in this doc, §4.2). Summary:

- `session-checkpoint.mjs` is the serialization point.
- `evaluateRefenceTrigger` runs inside the checkpoint transaction for all 5 trigger sources, including workstream-rotate.
- Guarantees unlock clear completes before next test-writer dispatch arrives for the same spec-group-id.

## 10. References

- Parent spec: `.claude/specs/groups/sg-pipeline-efficiency-ws2-practice-2.4/spec.md`
- Requirements: `.claude/specs/groups/sg-pipeline-efficiency-ws2-practice-2.4/requirements.md` (REQ-005)
- PRD: `.claude/prds/pipeline-efficiency/prd.md` v1.5 §SC-5, §7 test_writer_unlock contract
- Cross-workstream: `sg-pipeline-efficiency-ws1-convergence-pruning` (hash-chain helper, enforcement-primitives)
- Best practices: `.claude/memory-bank/best-practices/contract-first.md`, `.claude/memory-bank/best-practices/code-quality.md`

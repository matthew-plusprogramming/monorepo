---
title: Silent-Drop Observability — System Reference
last_reviewed: 2026-04-19
---

# Silent-Drop Observability — System Reference

Reference for the silent-drop observability system: pattern-layer anti-pattern detection in broadcast, fan-out, and delivery paths, operator-controlled advisory→coercive rollout, audit-chain integrity, and agent-proof enforcement artifacts.

Developer-facing guidance lives in `.claude/memory-bank/best-practices/logging.md` § Silent-Drop Observability. Operator-facing procedure is covered here.

## System Overview

The system operates in three planes:

| Plane              | Artifact                                                    | Owner                             |
| ------------------ | ----------------------------------------------------------- | --------------------------------- |
| Detection (review) | code-reviewer Category H + advisory finding emission        | agent                             |
| Parsing            | `parse-review-silent-drop-checklist.mjs`                    | agent / CI                        |
| Enforcement        | `silent-drop-enforcement.json`, coercive-flip preflight     | operator (signed commit)          |
| Audit integrity    | `enforcement-changes.log`, `verify-enforcement-audit-chain` | operator write, anyone verifies   |
| SLA monitoring     | `silent-drop-baseline-sla-monitor.mjs`                      | maintainer (scheduled invocation) |
| File protection    | `workflow-file-protection.mjs` (extended)                   | hook (blocks agent writes)        |

## Architecture: Advisory → Coercive Rollout

Three states and the gates that move between them:

```
     baseline window        preflight gate        operator reverts
advisory  ───────────►  coercive-candidate  ──►  coercive  ◄────  revert-advisory
  ▲                                                                    │
  └────────────────────── 90-day reassessment cycle ───────────────────┘
```

### State definitions

| State      | Code-reviewer behavior              | Merge gating  | Set by                                 |
| ---------- | ----------------------------------- | ------------- | -------------------------------------- |
| `advisory` | Emits `silent-drop-suspect` Medium  | None          | Default / revert-advisory              |
| `coercive` | Emits same findings; merge-blocking | Yes (CI gate) | Operator signed commit after preflight |
| `off`      | No findings emitted                 | None          | Operator (explicit override)           |

The mode lives in `.claude/config/silent-drop-enforcement.json` (schema: `SilentDropEnforcementFlag`). Agents cannot write this file — `workflow-file-protection.mjs` blocks the Write tool at PreToolUse. Only signed-commit operator writes pass.

### Rollout phases

1. **Baseline window** — Advisory mode runs for ≥14 days and ≥20 delivery-path PRs (or waiver with ≥50-char rationale). Metrics accumulate in `silent-drop-baseline.json`.
2. **Coercive-flip preflight** — `silent-drop-coercive-flip-preflight.mjs` validates 5 gates. All must pass.
3. **Flip** — Operator writes `silent-drop-enforcement.json` (mode=coercive) with atomic-rename. Audit entry appended to `enforcement-changes.log`.
4. **Steady state or revert** — If FP rate spikes, operator may revert-advisory; 90-day reassessment cycle begins.

## CLI Scripts

### parse-review-silent-drop-checklist.mjs

Extracts the silent-drop checklist answer from code-reviewer output and validates against `SilentDropChecklistAnswer`.

**Path**: `.claude/scripts/parse-review-silent-drop-checklist.mjs`

**Usage**:

```bash
node .claude/scripts/parse-review-silent-drop-checklist.mjs <path-to-reviewer-output.md>
node .claude/scripts/parse-review-silent-drop-checklist.mjs -    # stdin
```

**Contract**: The parser selects the JSON block by the sentinel anchor `<!-- silent-drop-checklist -->` (NOT "last fence" or "top-level key" heuristics). The emission rule requires no blank line between sentinel and fence; the reader is lenient (Postel) and tolerates blank lines so formatters cannot silently break valid output. Non-blank content between sentinel and fence IS an error.

**Exit codes**:

| Code | Meaning                                        |
| ---- | ---------------------------------------------- |
| 0    | Valid parse; one-line summary on stdout        |
| 1    | Parse failure; structured error JSON on stderr |
| 2    | Invocation error (missing file, bad args)      |

**Structured error codes** (stderr JSON `{error, detail, field_path}`):

| Error                  | When                                                                              |
| ---------------------- | --------------------------------------------------------------------------------- |
| `sentinel-missing`     | `<!-- silent-drop-checklist -->` not present                                      |
| `fenced-block-missing` | Sentinel found but no ` ```json` fence follows                                    |
| `json-invalid`         | Fence present but body not valid JSON                                             |
| `schema-invalid`       | Block parsed but Zod validation failed; `field_path` names the first invalid path |

**Success summary** (stdout, one line):

```
applied=true modules_touched_count=2 findings_count=3 advisory_suspects_count=1 annotations_used_count=0 truncation_present=false
```

**Integration**: Invoked by CI on PRs that touched delivery-path modules. Non-zero exit is treated as SC-8 failure for that PR.

### verify-enforcement-audit-chain.mjs

Hash-chain verifier for `.claude/audit/enforcement-changes.log` (JSONL) and baseline schema validator for `.claude/metrics/silent-drop-baseline.json`.

**Path**: `.claude/scripts/verify-enforcement-audit-chain.mjs`

**Usage**:

```bash
node .claude/scripts/verify-enforcement-audit-chain.mjs                      # default log path
node .claude/scripts/verify-enforcement-audit-chain.mjs <path>               # explicit log path
node .claude/scripts/verify-enforcement-audit-chain.mjs --baseline <path>    # force baseline mode
```

**Behavior**: Auto-detects input mode.

| Input                                          | Mode     | Check                                                                                        |
| ---------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| JSONL (one `SilentDropAuditLogEntry` per line) | chain    | For each entry, compute SHA-256 of RFC-8785 canonical JSON of prior entry; match `prev_hash` |
| JSON object with `reengagement_history[]`      | baseline | Validate full `SilentDropBaselineReport` schema; per-entry reengagement validation           |

**Entry kinds** (discriminated by `entry_kind`):

| Kind         | `prev_hash`           | Special                                                           |
| ------------ | --------------------- | ----------------------------------------------------------------- |
| `normal`     | null (genesis) or hex | carries `mode`, `effective_at`, `correlation_id`                  |
| `quarantine` | null                  | carries `last_valid_prev_hash` (anchor) + `detected_anomaly_kind` |
| `re-genesis` | null                  | carries `quarantine_ref` (UUID of preceding quarantine)           |

**Exit codes**:

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | Chain valid end-to-end (or empty) / baseline valid                         |
| 1    | Chain broken (structured stderr with broken-link index) / baseline invalid |
| 2    | Log file missing or unreadable                                             |

**Canonicalization**: RFC-8785 JCS via the shared `lib/jcs-canonicalize.mjs` module (same as `verify-deployment-audit-chain.mjs`). The implementation is a JCS subset (no float normalization, no Unicode NFC); safe when writer and verifier share this JS implementation. Hardening is required before cross-implementation operation.

**Security boundary**: The `signature` field on entries is a free-form bearer string. Cryptographic identity is enforced at the substrate layer (git-signed commits per NFR-11) and operator identity match, NOT within this verifier.

**Integration**: The coercive-flip preflight invokes the verifier first. Non-zero exit blocks the flip.

### silent-drop-coercive-flip-preflight.mjs

Operator-invoked preflight gate prior to any advisory→coercive flip.

**Path**: `.claude/scripts/silent-drop-coercive-flip-preflight.mjs`

**Usage**:

```bash
node .claude/scripts/silent-drop-coercive-flip-preflight.mjs <baseline-path>
```

**Gates evaluated** (all must pass; short-circuit on first failure):

| #   | Gate                                                                                  | Failure code                                       |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | `verify-enforcement-audit-chain` exit 0                                               | `chain-break`                                      |
| 2   | `(sample_floor_met OR sample_floor_waived)` AND (when waived) rationale ≥50 chars     | `sample-floor-unmet`, `waiver-rationale-too-short` |
| 3   | `context_engine_replay_pass=true`                                                     | `replay-not-passed`                                |
| 4   | `false_positive_rate ≤ FP_CEILING` (0.2)                                              | `fp-rate-above-ceiling`                            |
| 5   | Substrate probe — non-blocking; warns if substrate changed since baseline publication | (warning only)                                     |

**Substrate probe**: Determines whether the deployment substrate is `github-branch-protection`, `local-single-maintainer`, or `other`. Probe order:

1. `git remote -v` → github.com remote present?
2. `.github/CODEOWNERS` presence
3. `gh api repos/:owner/:repo/branches/:branch/protection` response

Missing `gh` CLI defaults substrate to `other` with structured warning (DEC-007). ENOENT never leaks a stack trace.

**Exit codes**:

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| 0    | All gates pass; flip permitted                  |
| 1    | Blocking gate failed; structured JSON on stderr |
| 2    | Invocation error                                |

**Test-mode flags** (gated by `SILENT_DROP_PREFLIGHT_TEST_MODE=1`):

| Flag                        | Purpose                                 |
| --------------------------- | --------------------------------------- |
| `--force-chain-break`       | Simulate verifier exit 1                |
| `--force-substrate=<value>` | Override substrate probe result         |
| `--force-probe-error`       | Simulate substrate probe error          |
| `--force-gh-enoent`         | Simulate `gh` missing                   |
| `--print-substrate`         | Print substrate probe result on success |

**Integration**: Operator runs the preflight before editing `silent-drop-enforcement.json`. See rollout-runbook.

### silent-drop-baseline-sla-monitor.mjs

Maintainer-invoked SLA monitor that emits reassessment recommendations. Never writes a decision (NFR-3 operator-controlled flip discipline) — recommendations only.

**Path**: `.claude/scripts/silent-drop-baseline-sla-monitor.mjs`

**Usage**:

```bash
node .claude/scripts/silent-drop-baseline-sla-monitor.mjs \
  --baseline .claude/metrics/silent-drop-baseline.json \
  --recommendations .claude/metrics/baseline-sla-recommendation.json
```

**Triggers** (append recommendation when):

| Rule    | Condition                                                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-20.1 | `operator_decision=revert-advisory` AND `effective_at` >90 days ago (anchored by latest `reengagement_history` date if newer) AND no prior `kill-gate-terminal` |
| AC-20.2 | Prior `reengagement-trigger` recommendation unaddressed for 14 days (addressed = new `reengagement_history` entry dated AFTER the recommendation)               |
| AC-20.4 | Terminal — `kill-gate-terminal` in history suppresses all further recommendations                                                                               |

**Exit codes**:

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 0    | Success (recommendations appended or no-op)                          |
| 1    | Baseline validation failure (schema invalid, malformed reengagement) |
| 2    | Invocation error                                                     |

**Write permissions**: The monitor writes to `baseline-sla-recommendation.json`. That file is in `PROTECTED_FILENAMES` — agent writes are blocked; the monitor succeeds because it runs under maintainer identity, not as an agent Write tool call.

## Data Contracts (Zod Schemas)

All five schemas live in `.claude/scripts/lib/silent-drop-schemas.mjs`. Validation happens at every boundary: parsers, writers, verifiers.

### SilentDropChecklistAnswer

**Owner**: Emitted by code-reviewer; consumed by `parse-review-silent-drop-checklist.mjs`.

**Purpose**: Single structured record of the Category H checklist outcome for one PR.

**Shape**:

| Field                           | Type                          | Notes                                                             |
| ------------------------------- | ----------------------------- | ----------------------------------------------------------------- |
| `applied`                       | boolean                       | Checklist ran                                                     |
| `delivery_path_modules_touched` | string[]                      | Module IDs                                                        |
| `findings`                      | `Finding[]` (max 50)          | Category H violations; kind ∈ 8 enum values                       |
| `advisory_suspects`             | `AdvisorySuspect[]` (max 100) | Regex-heuristic candidates; `function_name` ≤40 chars (NFR-13)    |
| `annotations_used`              | `AnnotationUsed[]`            | Per-suppression record; `rationale_prefix` ≤40 chars (NFR-14)     |
| `truncation`                    | `{count_omitted, reason}`     | Optional; reason ∈ `{findings-cap-50, advisory-suspects-cap-100}` |

**Finding kinds** (8):

```
missing-log | missing-metric | free-form-reason | label-cardinality
sensitive-reason-value | annotation-overuse | annotation-stale
metric-naming-violation
```

### SilentDropEnforcementFlag

**Owner**: Operator writes via signed commit; consumed by code-reviewer dispatch (read-at-dispatch-start snapshot).

**Purpose**: Advisory/coercive/off mode flag.

**Location**: `.claude/config/silent-drop-enforcement.json`

**Shape**:

| Field            | Type                                | Notes                                                   |
| ---------------- | ----------------------------------- | ------------------------------------------------------- |
| `mode`           | `'advisory' \| 'coercive' \| 'off'` | Enforcement mode                                        |
| `effective_at`   | ISO-8601 UTC                        | Bounded to [now-5min, now+24h] at write time (EDGE-004) |
| `operator`       | string                              | Operator identity                                       |
| `correlation_id` | UUIDv4                              | Correlates with audit log entry                         |
| `schema_version` | `'1.0'`                             | Literal                                                 |

**Write discipline**: Atomic-rename (write `.tmp` → `rename()`). Readers apply sticky-read on parse failure (last known good).

**File protection**: `workflow-file-protection.mjs` blocks agent writes.

### SilentDropBaselineReport

**Owner**: Operator-published; consumed by preflight + SLA monitor.

**Purpose**: Gate the coercive flip. Ships measurement window, sample adequacy, FP rate, replay-pass flag, operator decision, and reengagement history.

**Location**: `.claude/metrics/silent-drop-baseline.json`

**Key fields**:

| Field                        | Type                    | Notes                                                                                           |
| ---------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `measurement_window`         | `{start, end}` ISO UTC  |                                                                                                 |
| `sample_floor_met`           | boolean                 |                                                                                                 |
| `sample_floor_waived`        | boolean                 | AC-5.8 — consumed-once; fresh waiver required after revert                                      |
| `waiver_rationale`           | string (optional)       | ≥50 chars enforced by preflight (not schema)                                                    |
| `sample_count`               | number                  | Excludes truncated PRs (NFR-16a)                                                                |
| `false_positive_rate`        | number 0..1 \| null     | Null iff `sample_count=0`                                                                       |
| `catch_rate`                 | number 0..1 \| null     | Null iff `sample_count=0`                                                                       |
| `context_engine_replay_pass` | boolean                 | Gate 3 of preflight                                                                             |
| `operator_decision`          | 6-value enum            | `scope-narrow \| budget-tune \| revert-advisory \| kill-gate \| flip-coercive \| extend-window` |
| `effective_at`               | ISO UTC (optional)      | Drives 90-day reengagement clock when `operator_decision=revert-advisory`                       |
| `published_substrate`        | 3-value enum (optional) | Substrate at publication time (AC-22.3)                                                         |
| `reengagement_history`       | `ReengagementEntry[]`   | Each entry validated by `reengagementHistoryEntrySchema`                                        |
| `distinct_authors_count`     | number                  | ≥3 required (NFR-16c)                                                                           |

### ReengagementHistoryEntry

**Owner**: Operator appends via signed commit.

**Shape**:

| Field       | Type                                                               | Notes     |
| ----------- | ------------------------------------------------------------------ | --------- |
| `date`      | ISO-8601 UTC                                                       |           |
| `decision`  | `extend-revert-90d \| attempt-coercive-flip \| kill-gate-terminal` | AC-20.3   |
| `rationale` | string                                                             | ≥30 chars |

**Terminal semantics**: `kill-gate-terminal` suppresses all further SLA recommendations. `extend-revert-90d` and `attempt-coercive-flip` are non-terminal.

### SilentDropAuditLogEntry

**Owner**: Operator appends via signed commit; consumed by `verify-enforcement-audit-chain` and the coercive-flip preflight.

**Purpose**: Hash-chained audit trail of enforcement flag mutations and chain-break recovery events.

**Location**: `.claude/audit/enforcement-changes.log` (JSONL)

**Discriminated union** (`entry_kind`):

| Kind         | Key fields                                                        |
| ------------ | ----------------------------------------------------------------- |
| `normal`     | `prev_hash`, `correlation_id`, `mode`, `effective_at`             |
| `quarantine` | `last_valid_prev_hash`, `detected_anomaly_kind`; `prev_hash=null` |
| `re-genesis` | `quarantine_ref` (UUID of preceding quarantine); `prev_hash=null` |

**Common fields** on every kind: `entry_id` (UUIDv4), `timestamp` (ISO UTC), `operator`, `signature`.

**Chain semantics**:

- `prev_hash` = SHA-256 hex of RFC-8785 canonical JSON of the prior entry (genesis is null).
- Quarantine + re-genesis pair break and restart the chain; pre-break entries remain in the log as history.

### Coercive-flip-preflight behavioral contract

**Owner**: Behavioral — no data-model artifact.

**Inputs**: baseline JSON path, git/gh substrate probe.

**Outputs**: exit 0 (permitted) or 1 (rejected) or 2 (invocation error). Failures are named with stable codes. See the script section above.

**Invariants**: (1) Verifier runs first; chain break is a hard block regardless of other gates. (2) Substrate change is non-blocking (warning). (3) Waived sample floor is consumed once per flip cycle; reverting to advisory resets `sample_floor_waived=false`.

## File Protection Integration

The hook `workflow-file-protection.mjs` was extended to cover four new artifacts. Each entry is in two data structures:

1. `PROTECTED_FILENAMES` (array of basenames) — the outer block gate.
2. `PROTECTED_FILE_DIRS` (basename → directory map) — the data-driven matcher that prevents falling through to the `coordination/` default.

Previous implementation had an if/else ladder where unknown directories fell through to the `coordination/` branch. Writes to `.claude/config/silent-drop-enforcement.json` would have been silently unmatched. The map refactor (DEC-004) closes this gap.

### New protected files

| Basename                             | Directory  | Why protected                                              |
| ------------------------------------ | ---------- | ---------------------------------------------------------- |
| `silent-drop-enforcement.json`       | `config/`  | Operator-controlled enforcement flag (NFR-3)               |
| `silent-drop-baseline.json`          | `metrics/` | Gates coercive flip; forgeable baseline = forgeable flip   |
| `verify-enforcement-audit-chain.mjs` | `scripts/` | NFR-10 hash-chain integrity depends on verifier integrity  |
| `baseline-sla-recommendation.json`   | `metrics/` | Emitted by monitor; operator responds by updating baseline |

### Protection layers (defense in depth)

| Layer           | Block vector                                                                     |
| --------------- | -------------------------------------------------------------------------------- |
| Basename match  | Write tool `file_path` basename ∈ `PROTECTED_FILENAMES` → block                  |
| Directory match | `PROTECTED_FILE_DIRS[basename]` must match the write's resolved parent directory |
| Realpath inode  | Canonical realpath resolution defeats symlink bypass (Bash + Write)              |
| Bash patterns   | `rm`, `mv`, `truncate`, `cp`, `dd`, shell redirection targeting protected names  |

The operator bypass path is signed-commit identity match at the substrate layer (CODEOWNERS + branch protection), NOT relaxation of these hooks.

## CODEOWNERS Substrate

The project records the enforcement substrate in `.claude/memory-bank/org-context.md` as `enforcement_substrate: <value>` where value ∈ `{github-branch-protection, local-single-maintainer, other}`.

The coercive-flip preflight probes the current substrate and warns if it differs from the substrate captured at baseline publication time (`baseline.published_substrate`). This is non-blocking but visible.

See `.github/CODEOWNERS` for the ownership assignments covering:

- `.claude/config/silent-drop-enforcement.json`
- `.claude/metrics/silent-drop-baseline.json`
- `.claude/metrics/baseline-sla-recommendation.json`
- `.claude/scripts/verify-enforcement-audit-chain.mjs`

## Retrospective Replay Coverage

Context Engine postmortem issues 3, 5, 6, 7, 9, and 10 shared the silent-drop root cause: delivery-path code discarded messages with bare `continue`, `return`, or unmatched `switch` paths without an observable log or metric. The replay fixtures in `.claude/scripts/__tests__/silent-drop/fixtures/postmortem-replay/` pin the mapping below.

| Issue | Delivery-path category | Fixture module               | Checklist items |
| ----- | ---------------------- | ---------------------------- | --------------- |
| 3     | WS broadcasts          | `issue-3-broadcast-drop`     | H.1             |
| 5     | Frontend event routers | `issue-5-router-fallthrough` | H.1             |
| 6     | REST handler routers   | `issue-6-card-routing`       | H.1             |
| 7     | Emitter fan-out        | `issue-7-emitter-fanout`     | H.1, H.2        |
| 9     | SSE                    | `issue-9-sse-stream`         | H.1, H.3        |
| 10    | Pub/sub                | `issue-10-pubsub-drop`       | H.1             |

Replay coverage is 6 of 6. H.1 catches every issue; H.2 and H.3 add coverage for high-volume fan-out and metric naming/cardinality risk.

## See Also

- **Pattern training**: `.claude/memory-bank/best-practices/logging.md` § Silent-Drop Observability — anti-pattern, observable-drop substitution, 7-category delivery-path taxonomy, external-observer litmus test, `<component>.<path>.dropped` naming convention, acknowledgment annotation syntax.
- **Agent behavior**: `.claude/agents/code-reviewer.md` § Category H — review items H.1/H.2/H.3, hybrid markdown+JSON output pattern, sentinel discipline.
- **Required context**: `.claude/agents/spec-author.md` § Required Context — includes `logging.md` for spec authors.
- **Operator procedure**: this document — normal flip path, audit-chain recovery, substrate fallback, SLA response cycle.
- **Retrospective replay**: this document § Retrospective Replay Coverage — 6/6 Context Engine postmortem issues mapped to Category H items.
- **Incident tracking**: `.claude/metrics/silent-drop-incident-tracker.md` — dated tracking + postmortem-tagging protocol (SM-001).
- **Amendment log**: `.claude/prds/silent-drop-observability/AMENDMENT-LOG.md` — cross-PRD coordination with pipeline-integration-gaps.
- **PRD**: `.claude/prds/silent-drop-observability/prd.md`
- **Related hook**: `.claude/docs/HOOKS.md` § workflow-file-protection.mjs — canonical hook reference.
- **Related verifier pattern**: `.claude/docs/deployment-verification-contracts.md` § Verifying the Audit Chain — same RFC-8785 JCS canonicalization pattern, different log file.

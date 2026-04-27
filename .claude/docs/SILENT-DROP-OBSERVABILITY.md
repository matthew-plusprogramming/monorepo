---
title: Silent-Drop Observability
last_reviewed: 2026-04-27
---

# Silent-Drop Observability

Silent-drop observability catches delivery paths that discard work without a
log, metric, or explicit safe-drop annotation. Pattern guidance lives in
`.claude/memory-bank/best-practices/logging.md`; reviewer behavior lives in
`.claude/agents/code-reviewer.md` Category H. This doc covers the operator
scripts, schemas, protected files, audit chain, and replay coverage.

## System Shape

| Area | Artifact | Owner |
| --- | --- | --- |
| Review detection | code-reviewer Category H | agent |
| Checklist parser | `.claude/scripts/parse-review-silent-drop-checklist.mjs` | CI or wrapper |
| Mode flag | `.claude/config/silent-drop-enforcement.json` | operator signed commit |
| Baseline | `.claude/metrics/silent-drop-baseline.json` | operator or maintainer |
| Audit chain | `.claude/audit/enforcement-changes.log` | operator appends, verifier checks |
| Flip preflight | `.claude/scripts/silent-drop-coercive-flip-preflight.mjs` | operator |
| SLA monitor | `.claude/scripts/silent-drop-baseline-sla-monitor.mjs` | maintainer |
| File protection | `.claude/scripts/workflow-file-protection.mjs` | hook |

Modes:

| Mode | Behavior |
| --- | --- |
| `advisory` | emits Category H findings such as `silent-drop-suspect`; non-blocking |
| `coercive` | emits the same findings; CI may block merge |
| `off` | suppresses this finding family |

Normal flow: advisory baseline, preflight, operator flag edit, audit-log
append, monitoring. Reverting to advisory restarts reassessment.

## Category H

Category H applies when a PR touches delivery-path modules such as broadcast,
fan-out, dispatch, route, emit, SSE, or pub/sub code.

- `H.1 skip-path-has-log`: `continue`, `return`, and switch fallthrough need
  nearby `logger.` or `metrics.` evidence unless acknowledged as safe.
- `H.2 high-volume-also-has-metric`: high-volume fan-out needs metrics, not
  only logs.
- `H.3 metric-naming-and-cardinality`: dropped-message metrics use stable names
  and bounded labels.

Reviewer output uses this sentinel followed by fenced JSON:

```text
<!-- silent-drop-checklist -->
```

The block must validate as `SilentDropChecklistAnswer`. The parser selects by
sentinel anchor.

Safe-drop annotation:

```js
// silent-drop: safe - rationale explaining why no external observer needs this
```

Accepted annotations are recorded in `annotations_used[]`; stale or excessive
annotations become findings.

## Scripts

### Checklist Parser

Path: `.claude/scripts/parse-review-silent-drop-checklist.mjs`

```bash
node .claude/scripts/parse-review-silent-drop-checklist.mjs <review-output.md>
node .claude/scripts/parse-review-silent-drop-checklist.mjs -
```

Reads the checklist block after `<!-- silent-drop-checklist -->`, validates
`silentDropChecklistAnswerSchema`, and prints:

```text
applied=true modules_touched_count=2 findings_count=3 advisory_suspects_count=1 annotations_used_count=0 truncation_present=false
```

Exit codes: `0` valid, `1` parse/schema failure, `2` invocation failure.
Structured errors: `sentinel-missing`, `fenced-block-missing`, `json-invalid`,
`schema-invalid`.

### Audit-Chain Verifier

Path: `.claude/scripts/verify-enforcement-audit-chain.mjs`

```bash
node .claude/scripts/verify-enforcement-audit-chain.mjs
node .claude/scripts/verify-enforcement-audit-chain.mjs <log-path>
node .claude/scripts/verify-enforcement-audit-chain.mjs --baseline <baseline-path>
```

Default chain path: `.claude/audit/enforcement-changes.log`.

Chain mode validates JSONL `SilentDropAuditLogEntry` records and checks each
linked `prev_hash` against the SHA-256 hash of the prior entry's
RFC-8785/JCS-canonical JSON. Baseline mode validates
`SilentDropBaselineReport`, including reengagement history.

Entry kinds:

| Kind | Link behavior |
| --- | --- |
| `normal` | genesis has `prev_hash=null`; later entries link to prior entry hash |
| `quarantine` | marks a detected chain break and carries `last_valid_prev_hash` |
| `re-genesis` | restarts the chain after quarantine |

Exit codes: `0` valid, `1` broken/invalid, `2` missing or unreadable.
Cryptographic identity is enforced by signed commits and ownership substrate,
not by the free-form `signature` field.

### Coercive-Flip Preflight

Path: `.claude/scripts/silent-drop-coercive-flip-preflight.mjs`

```bash
node .claude/scripts/silent-drop-coercive-flip-preflight.mjs <baseline-path>
```

Blocking gates:

| Gate | Failure code |
| --- | --- |
| audit-chain verifier exits 0 | `chain-break` |
| sample floor met or waived; waiver rationale is long enough | `sample-floor-unmet`, `waiver-rationale-too-short` |
| `context_engine_replay_pass=true` | `replay-not-passed` |
| `false_positive_rate <= 0.2` | `fp-rate-above-ceiling` |

The substrate probe is warning-only. It reports
`github-branch-protection`, `local-single-maintainer`, or `other`; missing
`gh` defaults to `other` with a structured warning.

Exit codes: `0` flip permitted, `1` rejected, `2` invocation failure.
Test-only flags require `SILENT_DROP_PREFLIGHT_TEST_MODE=1`.

### Baseline SLA Monitor

Path: `.claude/scripts/silent-drop-baseline-sla-monitor.mjs`

```bash
node .claude/scripts/silent-drop-baseline-sla-monitor.mjs \
  --baseline .claude/metrics/silent-drop-baseline.json \
  --recommendations .claude/metrics/baseline-sla-recommendation.json
```

The monitor appends recommendations only. It never writes decisions and never
modifies the baseline.

Triggers:

| Trigger | Result |
| --- | --- |
| `operator_decision=revert-advisory`, effective date at least 90 days old, and no terminal history | append `reengagement-trigger` |
| prior reengagement recommendation unaddressed for 14 days | append `second-reminder` |
| `kill-gate-terminal` in history | suppress further recommendations |

Exit codes: `0` success, `1` baseline invalid, `2` invocation failure.

## Schemas

All schemas live in `.claude/scripts/lib/silent-drop-schemas.mjs`.

`SilentDropChecklistAnswer` fields:
`applied`, `delivery_path_modules_touched`, `findings`,
`advisory_suspects`, `annotations_used`, optional `truncation`.

Finding kinds:

```text
missing-log
missing-metric
free-form-reason
label-cardinality
sensitive-reason-value
annotation-overuse
annotation-stale
metric-naming-violation
```

`SilentDropEnforcementFlag` fields:
`mode`, `effective_at`, `operator`, `correlation_id`, `schema_version`.
Location: `.claude/config/silent-drop-enforcement.json`.

`SilentDropBaselineReport` key fields:
`measurement_window`, `sample_floor_met`, `sample_floor_waived`,
`waiver_rationale`, `sample_count`, `false_positive_rate`, `catch_rate`,
`context_engine_replay_pass`, `operator_decision`, `published_substrate`,
`reengagement_history`, `distinct_authors_count`.
Location: `.claude/metrics/silent-drop-baseline.json`.

Reengagement decisions:

```text
extend-revert-90d
attempt-coercive-flip
kill-gate-terminal
```

`SilentDropAuditLogEntry` common fields: `entry_id`, `timestamp`, `operator`,
`signature`; discriminant: `entry_kind`.

## Protected Files

`workflow-file-protection.mjs` blocks agent writes to these artifacts by
basename and expected directory:

| File | Directory | Purpose |
| --- | --- | --- |
| `silent-drop-enforcement.json` | `config/` | mode flag |
| `enforcement-changes.log` | `audit/` | hash-chained audit log |
| `silent-drop-baseline.json` | `metrics/` | flip baseline |
| `verify-enforcement-audit-chain.mjs` | `scripts/` | chain verifier |
| `baseline-sla-recommendation.json` | `metrics/` | reassessment recommendations |

The hook uses `PROTECTED_FILENAMES`, `PROTECTED_FILE_DIRS`, realpath symlink
defense, and Bash pattern checks for redirect, `rm`, `mv`, `cp`, `truncate`,
and `sed -i`. Operator edits happen outside the agent tool path through signed
commits, ownership, and review.

## Substrate

Current substrate is recorded in `.claude/memory-bank/org-context.md`:

```text
enforcement_substrate: local-single-maintainer
```

Accepted values: `github-branch-protection`, `local-single-maintainer`,
`other`. The preflight warns when the current probe differs from
`baseline.published_substrate`. CODEOWNERS covers the mode flag, baseline,
recommendation file, and verifier when branch protection is available.

## Replay Coverage

Fixtures under `.claude/scripts/__tests__/silent-drop/fixtures/postmortem-replay/`
pin six Context Engine postmortem issues to Category H.

| Issue | Category | Fixture | Items |
| --- | --- | --- | --- |
| 3 | WS broadcasts | `issue-3-broadcast-drop` | H.1 |
| 5 | frontend event routers | `issue-5-router-fallthrough` | H.1 |
| 6 | REST handler routers | `issue-6-card-routing` | H.1 |
| 7 | emitter fan-out | `issue-7-emitter-fanout` | H.1, H.2 |
| 9 | SSE | `issue-9-sse-stream` | H.1, H.3 |
| 10 | pub/sub | `issue-10-pubsub-drop` | H.1 |

## Verification

```bash
npx vitest run --config .claude/scripts/vitest.config.mjs .claude/scripts/__tests__/silent-drop
npx vitest run --config .claude/scripts/vitest.config.mjs .claude/scripts/__tests__/workflow-file-protection.regression.test.mjs
```

Coverage includes parser extraction, schemas, audit chain, preflight gates, SLA
monitoring, file protection, CODEOWNERS, code-reviewer Category H, incident
tracking, and replay fixtures.

Related surfaces:

- `.claude/memory-bank/best-practices/logging.md`
- `.claude/agents/code-reviewer.md`
- `.claude/scripts/lib/silent-drop-schemas.mjs`
- `.claude/metrics/silent-drop-incident-tracker.md`
- `.claude/prds/silent-drop-observability/AMENDMENT-LOG.md`
- `.claude/prds/silent-drop-observability/prd.md`
- `.claude/docs/HOOKS.md`
- `.claude/docs/deployment-verification-contracts.md`

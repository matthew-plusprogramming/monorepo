# Test Baseline System

Current owner: test-baseline regression guard.
Covers: pre-existing test failure tracking, baseline refresh, operator updates,
and CI wiring.

## Purpose

`.claude/test-baseline.json` pins the set of **known** pre-existing test failures
so CI / pre-commit checks can distinguish **new regressions** from inherited
failures. The pipeline has three pieces:

| Artifact                                   | Purpose                                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/test-baseline.json`               | Source of truth for pinned failures. Schema `{version: 1, entries: [{file, test, reason?, added_date}]}`.                                                                             |
| `.claude/scripts/test-baseline-check.mjs`  | Runs `npm test` via vitest JSON reporter, diffs failures against the baseline, emits `{new_failures, fixed_failures}` to stdout, and exits non-zero when `new_failures` is non-empty. |
| `.claude/scripts/test-baseline-update.mjs` | Operator-explicit CLI to add/remove entries with a visible diff summary and atomic write.                                                                                             |
| `.claude/test-baseline.refresh-log.jsonl`  | Append-only audit trail for `--refresh` runs. Each line is either a `removed`/`added` entry record or a `summary` record.                                                             |

## Commands

```bash
# Default regression check (runs npm test, diffs, emits JSON, exits non-zero on new failures)
npm run test:baseline

# Bootstrap: generate baseline from current failures (file must be absent)
npm run test:baseline -- --bootstrap

# Refresh: recompute baseline in place, log add/remove, append summary
npm run test:baseline -- --refresh

# Operator-explicit add/remove with diff preview
npm run test:baseline:update -- --add path/to.test.mjs::"AC1.1 foo" --reason flaky
npm run test:baseline:update -- --add path/to.test.mjs::"AC1.1 foo" --reason flaky --confirm
```

### Mutual exclusions

- `--bootstrap` and `--refresh` cannot be combined.
- `--bootstrap` errors if the baseline file already exists.
- `--refresh` errors if the baseline file is absent (directs operator to `--bootstrap`).

### Exit codes

| Code | `test-baseline-check`                             | `test-baseline-update`                      |
| ---- | ------------------------------------------------- | ------------------------------------------- |
| 0    | OK / graceful-degradation / bootstrap / refresh   | Confirmed write OR no-op dry-run            |
| 1    | New regressions detected                          | Dry-run with pending ops (confirm required) |
| 2    | Corrupt JSON / unknown version / schema violation | Same (fail-closed)                          |
| 3    | Argument misuse                                   | Argument misuse                             |
| 4    | Test runner failure                               | Write failed                                |

## Enforcement wiring (AC-024.1, AC-024.2)

### Pre-commit hook

`.husky/pre-commit` does NOT invoke `test-baseline-check` by default. The
check runs `npm test` which exceeds typical pre-commit latency budgets
(multi-minute vitest suite). Instead, we provide an opt-in environment
variable:

```sh
# Enable the pre-commit baseline check (default: off)
export CLAUDE_PRECOMMIT_BASELINE=1
git commit ...
```

When `CLAUDE_PRECOMMIT_BASELINE=1`, the pre-commit hook invokes
`npm run test:baseline` and blocks the commit on non-zero exit.

Operators who want a faster pre-commit experience should omit the env
variable and rely on CI enforcement (below).

### CI enforcement

CI should invoke `npm run test:baseline` as a dedicated step so that any
`new_failures` entry fails the pipeline. Suggested structure:

```yaml
- name: Baseline regression check
  run: npm run test:baseline
```

The exit-code contract (non-zero on new failures) ensures CI systems block
merges that introduce net-new failures.

## Baseline refresh workflow (DEC-CHK-010)

After Phase A/B/C remediation work merges, many of the inherited-baseline
failures will flip fail to pass. Running `--refresh` updates the baseline
without manual diffing.

Lifecycle:

1. **Phase D ships** the baseline file (all current failing tests tagged
   `inherited-baseline`).
2. **Phase A/B/C remediation lands**. Some inherited-baseline tests start
   passing; occasionally a new pass-to-fail regression appears as a side
   effect.
3. **Operator runs** `npm test` to confirm remediation reduces the failing
   set.
4. **Operator runs** `npm run test:baseline -- --refresh`. The CLI:
   - Re-runs the full suite.
   - Removes now-passing entries; logs each as
     `{action: "removed", file, test, reason: "fixed-by-remediation", refresh_date}`
     to `.claude/test-baseline.refresh-log.jsonl`.
   - Adds new regressions as `{reason: "new-post-remediation", added_date: <now>}`
     in the baseline and logs each as
     `{action: "added", file, test, reason: "new-post-remediation", refresh_date}`.
   - Appends a summary record
     `{action: "summary", refresh_date, removed_count, added_count,
  pre_refresh_entry_count, post_refresh_entry_count}`.
   - Writes the updated baseline atomically via tmp+rename (REQ-010.1).
5. **Operator reviews** `.claude/test-baseline.refresh-log.jsonl` for the
   summary and any `new-post-remediation` additions (these warrant
   investigation).
6. **Operator commits** the updated `.claude/test-baseline.json` plus the
   appended refresh-log lines.

The refresh workflow is operator-explicit. Routine pre-commit / CI
invocations (without `--refresh`) continue to run as the regression check.

## Schema (REQ-006.1)

```json
{
  "version": 1,
  "entries": [
    {
      "file": ".claude/scripts/__tests__/auto-convergence-docs.test.mjs",
      "test": "AC-7.1: should include investigation in the convergence gates table",
      "reason": "inherited-baseline",
      "added_date": "2026-04-19T07:22:04.213Z"
    }
  ]
}
```

- `file` is repo-relative, POSIX-separator normalized.
- `test` matches vitest `fullName` (ancestor titles joined by space +
  leaf title).
- `reason` is free-form; the pipeline uses three canonical tags:
  - `inherited-baseline` — populated during bootstrap / Phase D.
  - `fixed-by-remediation` — refresh-log tag for now-passing entries
    removed by `--refresh`.
  - `new-post-remediation` — baseline tag for pass-to-fail regressions
    introduced after bootstrap.
- `added_date` is ISO 8601.

## Fail-closed semantics (REQ-006.6)

| Condition                 | Behavior                                                                 |
| ------------------------- | ------------------------------------------------------------------------ |
| Corrupt JSON              | Exit 2, stderr `test-baseline.json parse failure; re-generate or revert` |
| Unknown `version`         | Exit 2, stderr names the offending value                                 |
| Schema violation          | Exit 2, stderr identifies the failing field                              |
| Missing file (check mode) | Exit 0, stderr warns operator to use `--bootstrap`                       |

## Related

- `.claude/scripts/test-baseline-check.mjs` and
  `.claude/scripts/test-baseline-update.mjs` -- baseline check, refresh, and
  operator update CLIs.
- `REQ-010.1` atomic write helper (`.claude/scripts/lib/atomic-write.mjs`)

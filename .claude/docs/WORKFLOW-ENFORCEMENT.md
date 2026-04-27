---
_source_modules: ['workflow-scripts']
last_reviewed: 2026-04-27
title: Workflow Enforcement Architecture
---

# Workflow Enforcement Architecture

Workflow enforcement has two layers:

- **Cooperative layer**: `session-checkpoint.mjs` advances workflow state and validates DAG obligations.
- **Coercive layer**: hooks block unsafe dispatches, protected-file writes, and invalid completion.

Use this doc as the current operator contract. Implementation details live in
the scripts named below.

## Runtime Surfaces

| Surface | Trigger | Role |
| --- | --- | --- |
| `.claude/scripts/session-checkpoint.mjs` | CLI | Sole writer for workflow/session mutations, convergence updates, route decisions, and local verification. |
| `.claude/scripts/workflow-gate-enforcement.mjs` | `PreToolUse` `Agent` | Blocks subagent dispatch when required prior gates have not converged. |
| `.claude/scripts/workflow-file-protection.mjs` | `PreToolUse` `Write` + `Bash` | Blocks agent writes and write-intent shell commands against protected enforcement files. |
| `.claude/scripts/workflow-stop-enforcement.mjs` | `Stop` | Blocks completion when required dispatches, obligations, completion checks, or deployment verification are missing. |
| `.claude/scripts/convergence-pass-recorder.mjs` | `SubagentStop` | Records pass evidence through the imported `recordPass()` API. |
| `.claude/scripts/lib/workflow-dag.mjs` | shared module | Owns phase graph, workflow exemptions, dispatch requirements, and risk-tier completion requirements. |
| `.claude/scripts/lib/stop-hook-checks.mjs` | shared module | Owns the five completion-invariant checks used by Stop and `session-checkpoint verify`. |
| `.claude/scripts/lib/bash-intent-classifier.mjs` | shared module | Classifies Bash read/write intent for protected enforcement targets. |

## Session Checkpoint CLI

Common operations:

```bash
node .claude/scripts/session-checkpoint.mjs start-work <sg-id> <workflow> "<objective>"
node .claude/scripts/session-checkpoint.mjs transition-phase <phase> [substage]
node .claude/scripts/session-checkpoint.mjs get-status
node .claude/scripts/session-checkpoint.mjs complete-work
node .claude/scripts/session-checkpoint.mjs archive-incomplete
node .claude/scripts/session-checkpoint.mjs override-skip <phase> "<rationale>"
node .claude/scripts/session-checkpoint.mjs reset-enforcement
```

Convergence operations:

```bash
node .claude/scripts/session-checkpoint.mjs update-convergence <gate_name>
node .claude/scripts/session-checkpoint.mjs reconcile-convergence <sg-id> [--dry-run]
node .claude/scripts/session-checkpoint.mjs verify [--spec-group <sg-id>]
node .claude/scripts/session-checkpoint.mjs update-circuit-breaker --gate <gate_name> --event <failure|success>
```

Rules:

- `start-work` creates or resumes `session.active_work`; non-exempt workflow downgrades are rejected.
- `transition-phase` validates the DAG and updates `active_work.current_phase`.
- `update-convergence` derives counters from evidence; it does not accept a numeric count.
- `verify` runs the same completion-invariant checks as the Stop hook.
- `record-pass` remains only as a rejection surface; every `--source` value exits 2 with `SOURCE_FORBIDDEN_VIA_CLI`.

## DAG and Phase Rules

Current phases:

`prd_gathering`, `spec_authoring`, `atomizing`, `enforcing`, `investigating`,
`awaiting_approval`, `auto_approval`, `challenging`, `implementing`, `testing`,
`verifying`, `reviewing`, `completion_verifying`, `documenting`, `journaling`,
`complete`

Mandatory predecessors:

| Target | Requirement |
| --- | --- |
| `implementing` | investigation convergence plus required challenger substage for the workflow. |
| `reviewing` | unifier dispatch. |
| `completion_verifying` | code-review and security-review clean-pass convergence. |
| `documenting` | code-review and security-review clean-pass convergence. |
| `complete` | phase-aware Stop requirements from `active_work.risk_tier`. |

Challenger substages:

| Substage | Current role |
| --- | --- |
| `pre-impl` | Required for `oneoff-spec`. |
| `pre-orch` | Required for `orchestrator`. |
| `pre-test` | Accepted only for compatibility with older session state. |

`pre-review` is historical and is not a current valid substage.

Workflow-scoped required sets:

| Workflow | Required substages |
| --- | --- |
| `oneoff-spec` | `pre-impl` |
| `orchestrator` | `pre-orch` |
| `oneoff-vibe`, `refactor`, `journal-only` | none |

`session.substages_visited` is object-shaped:

```json
{
  "substages_visited": {
    "challenging": ["pre-impl"]
  }
}
```

Malformed shape blocks with `dag.substage.malformed`; missing required substage
blocks with `dag.substage.skipped`; old bare `challenging` history entries are
logged as `dag.substage.legacy_visit_ignored` and ignored.

Enforcement levels:

| Level | Effect |
| --- | --- |
| `off` | Transitions are allowed. |
| `warn-only` | Violations warn but transition. |
| `graduated` | Violations block unless overridden. |

## Override Mechanism

Cooperative override:

```bash
node .claude/scripts/session-checkpoint.mjs override-skip <phase> "<rationale>"
```

This appends an override event to session history. The session cap is three
cooperative overrides; `start-work` resets the cap.

Coercive dispatch override:

```json
{
  "gate": "implementer",
  "session_id": "<session-id>",
  "timestamp": "<ISO 8601>",
  "rationale": "specific reason"
}
```

Write that JSON to `.claude/coordination/gate-override.json`. The file is
FULL_BLOCK-protected from agent writes; use an operator shell or trusted CLI.

## Kill Switch

Global sentinel:

```bash
touch .claude/coordination/gate-enforcement-disabled
```

Presence disables gate enforcement and Stop enforcement. File protection remains
active so agents cannot create or remove the sentinel themselves.

## Kill Switch Audit Log

Kill-switch changes should be recorded with:

```bash
node .claude/scripts/audit-append.mjs create --rationale "<reason>"
node .claude/scripts/audit-append.mjs remove --rationale "<reason>"
```

The append path writes `kill-switch.log.jsonl` and related rotated files through
the audit append flow. Direct agent writes are blocked by
`workflow-file-protection.mjs`.

## Dispatch and Stop Enforcement

Dispatch gates:

| Subagent | Blocked until |
| --- | --- |
| `implementer` | investigation and challenger convergence. |
| `test-writer` | no workflow gate; test isolation is enforced elsewhere. |
| `e2e-test-writer` | no workflow gate; black-box isolation is enforced elsewhere. |
| `code-reviewer` | unifier dispatched. |
| `security-reviewer` | unifier dispatched. |
| `documenter` | code-review and security-review convergence. |
| `completion-verifier` | code-review and security-review convergence. |

Risk-tier complete-phase requirements:

| `active_work.risk_tier` | Required dispatches at completion |
| --- | --- |
| `trust-bearing` or missing | `code-reviewer`, `security-reviewer`, `completion-verifier`, `documenter`, `e2e-test-writer` |
| `user-visible` | `code-reviewer`, `e2e-test-writer` |
| `shared-library` | `code-reviewer` |
| `local-feature` | `code-reviewer` |
| `docs-prompt-metadata` | none |
| `mechanical-cleanup` | none |

Stop hook blocks completion when any of these apply:

- phase-aware mandatory dispatches are missing;
- manifest status obligations are unsatisfied at `currentPhase === 'complete'`;
- completion-invariant checks fail for a non-exempt active spec group;
- deployment was detected without post-deploy verification.

Completion-invariant checks:

| Check | Blocks when |
| --- | --- |
| Convergence depth | any session-tracked gate has `clean_pass_count < 2`; missing or non-number is treated as 0. |
| Challenger stage coverage | required challenger stage is missing; `override_skip` is honored. |
| Phase DAG predecessors | a mandatory predecessor of `complete` was not visited; `override_skip` is honored. |
| Artifact inventory | required spec-group artifacts are missing. |
| Convergence-field sanity | manifest pass fields disagree with session clean-pass counters. |

`warn-only` affects only challenger-stage and phase-DAG predecessor checks.
Convergence depth, convergence-field sanity, and artifact inventory always
block.

## Deployment Verification Gate

Deployment-sensitive completion requires post-deploy verification evidence.
Intervention logs and verifier scripts are protected enforcement surfaces:

- `.claude/deployment-manifests/**`
- `.claude/coordination/deployment-interventions.log`
- `.claude/scripts/verify-deployment-audit-chain.mjs`

Use the deployment verification scripts and append-only intervention flow.
Direct agent edits to protected deployment state are blocked.

## Protected File Write Detection

`workflow-file-protection.mjs` blocks `Write` and write-intent Bash commands
against protected enforcement state.

| Command shape | Result |
| --- | --- |
| Read-only command against protected file | Allowed. |
| Known write verb or redirect to protected file | Blocked. |
| Parse failure, dynamic/evasive command, non-ASCII or encoded path, glob path, oversized command | Fail-closed with `HOOK_CLASSIFIER_FAIL_CLOSED`. |
| Attested audit append touching only audit-log patterns | Allowed. |
| Mixed audit-log and exact protected-file targets | Blocked. |

Classifier details live in
[`bash-intent-classifier.md`](./bash-intent-classifier.md) and
[`bash-intent-classifier-api.md`](./bash-intent-classifier-api.md).

## Fail-Open Policy

Structural errors in gate and Stop hooks fail open unless a specific rule says
otherwise:

- missing or malformed `session.json`;
- missing `active_work`;
- missing workflow type;
- malformed hook stdin;
- top-level script exception.

Fail-closed exceptions:

- missing convergence counters default to 0 for dispatch/completion gates;
- malformed `session.json` during `update-convergence` exits non-zero with
  `CONVERGENCE_SESSION_PARSE_FAILED`;
- protected-file Bash parsing failures fail closed.

## Two-Store Convergence Model

Convergence state intentionally lives in two stores.

| Store | Scope | Holds | Main writers |
| --- | --- | --- | --- |
| `manifest.json:.convergence` | durable and persistent per spec group | `<gate>_converged`, `<gate>_passed`, `spec_complete`, and related durable assertions | `session-checkpoint.mjs update-convergence`, `complete-work`, spec/documentation writers |
| `session.json:.convergence` | session-scoped cache | `<gate>.clean_pass_count`, `<gate>.iteration_count`, parse-failure counters, source provenance | `session-checkpoint.mjs update-convergence` and imported `recordPass()` |

Authoritative source per check:

| Consumer | Authoritative source |
| --- | --- |
| `workflow-gate-enforcement.mjs` dispatch prerequisites | `session.json:.convergence` |
| Stop convergence-depth check | `session.json:.convergence` |
| Stop convergence-field sanity check | both stores, cross-checked |
| `completion-verifier` | both stores, cross-checked |
| phase-transition manifest obligations | `manifest.json:.convergence` |

Drift scenarios:

- `active_work` switch: a new or resumed spec group has durable manifest
  convergence while session counters are empty.
- interrupted session: pass evidence exists but has not yet been mirrored to
  manifest convergence fields.
- manual edit: one store changes without the other.

Reconciliation rule: **manifest wins**. If
`manifest.json:.convergence.<gate>_converged === true` and
`session.json:.convergence.<gate>.clean_pass_count < 2`, `start-work` and
`reconcile-convergence` warn, seed the session counter to 2, and add provenance
with `record_source: "manifest_seed"`. Intentional re-verification uses
`--force-reset-convergence`, which flips manifest convergence booleans false,
sets session counters to 0, and records `convergence_force_reset`.

## Convergence State on `active_work` Switch

This is the operator-visible form of the
[Two-Store Convergence Model](#two-store-convergence-model).

Default seed behavior:

- manifest convergence persists across sessions;
- `start-work` detects manifest/session drift;
- stderr includes a WARN naming the stored values and saying `manifest wins`;
- `session.json:.convergence.<gate>.clean_pass_count` is seeded to 2;
- session history records `convergence_manifest_seeded`;
- gates with false manifest convergence fields are not seeded.

Operator response:

| Scenario | Response |
| --- | --- |
| Resuming an already-converged spec group | Accept the seed and continue. |
| Intentionally re-verifying a converged gate | Run `start-work ... --force-reset-convergence`. |
| WARN appears for a spec group that should not be converged | Inspect manifest history for manual or stale edits. |

Useful commands:

```bash
node .claude/scripts/session-checkpoint.mjs reconcile-convergence <sg-id> --dry-run
node .claude/scripts/session-checkpoint.mjs start-work <sg-id> <workflow> "<objective>" --force-reset-convergence
node .claude/scripts/session-checkpoint.mjs start-work <sg-id> <workflow> "<objective>" --clear-dangling
```

`completion-verifier` and `reconcile-convergence <sg-id>` use the same reconcile
helper as `start-work`.

## Convergence Reader Contract

Session-tracked gates:

- `code_review`
- `security_review`
- `investigation`
- `challenger`
- `unifier`
- `completion_verifier`

Readers:

| Reader | Reads | Writes |
| --- | --- | --- |
| `workflow-gate-enforcement.mjs` | session clean-pass counters | none |
| `workflow-stop-enforcement.mjs` | manifest obligations and session completion checks | none |
| `completion-verifier` | manifest and session convergence | none |
| `convergence-pass-recorder.mjs` | SubagentStop payload | pass evidence through `recordPass()` |
| `session-checkpoint.mjs` | both stores | canonical session and manifest updates |

After `start-work` returns for a non-exempt workflow, session convergence
counters are coherent with manifest convergence booleans unless an explicit
force-reset skip is active.

## Evidence-Based Convergence

Clean-pass counters are derived from
`session.convergence_evidence.<gate>.passes[]`. Agents do not set
`clean_pass_count` directly.

Derivation contract:

- `deriveConvergenceFromEvidence()` walks the last 200 records from the tail.
- canonical `record_source` values are `hook`, `parse_failed`, and
  `manual_fallback`;
- legacy `manual` and `hook_manual` records remain parseable for audit but are
  invisible to derived counts;
- canonical dirty records reset the clean streak;
- legacy records are skipped and logged as `convergence.legacy_source_rejected`;
- bound-hit without an eligible streak start emits
  `CONVERGENCE_TAIL_WALK_BOUNDED`.

`recordPass()` contract:

- exported by `session-checkpoint.mjs`;
- called in-process by `convergence-pass-recorder.mjs`;
- accepts only `hook`, `parse_failed`, and `manual_fallback`;
- writes by temp-file plus same-filesystem `rename()`;
- creates temp files with mode `0600`;
- refuses symlinked `session.json` with `SESSION_JSON_SYMLINK_REFUSED`;
- appends evidence records without editing or deleting existing records.

Extractor summary:

| Extractor | Result |
| --- | --- |
| severity / JSON findings block | classifies clean or dirty by gate threshold. |
| finding-list cues | dirty with finding count. |
| severity prose | dirty. |
| success marker | clean. |
| no match | dirty `parse_failed` record. |

Evidence integrity checks in `workflow-gate-enforcement.mjs` are advisory:
pass-number gaps, timestamp regressions, length mismatches, and implausible
timing warn but do not block dispatch by themselves.

## Session State

Cooperative fields under `phase_checkpoint`:

| Field | Purpose |
| --- | --- |
| `phase_skip_warnings` | predecessor skip counts. |
| `enforcement_counter` | monotonic enforcement event counter. |
| `_counter_checksum` | counter integrity checksum. |
| `enforcement_level` | `off`, `warn-only`, or `graduated`. |
| `override_count` | cooperative override count for the session. |

Coercive readers:

| Field | Purpose |
| --- | --- |
| `active_work.workflow` | workflow-specific enforcement rules. |
| `active_work.risk_tier` | Stop-hook completion dispatch set. |
| `subagent_tasks.in_flight` / `completed_this_session` | dispatch history. |
| `convergence.<gate>.clean_pass_count` | dispatch and completion gates. |
| `convergence_evidence.<gate>.passes[]` | evidence source for derived counters. |
| `convergence_log_failures.<gate>` | session.log circuit breaker state. |
| `substages_visited` | challenger substage obligations. |

## Structured Logs

Important stderr events:

| Event | Meaning |
| --- | --- |
| `convergence.streak.derived` | derived clean-pass and iteration counters. |
| `convergence.legacy_source_rejected` | legacy evidence source skipped. |
| `convergence.session_parse_failed` | fail-closed `session.json` read/parse error during update. |
| `convergence.record_pass_failed` | atomic evidence append failed. |
| `dag.substage.admitted` | valid challenger substage recorded. |
| `dag.substage.skipped` | required substage missing. |
| `dag.substage.legacy_visit_ignored` | old bare challenger phase ignored. |
| `dag.substage.malformed` | malformed `substages_visited` shape. |
| `WORKFLOW_IMMUTABLE` | attempted mid-session workflow change rejected. |

Structured errors avoid stack traces and raw source bytes; session IDs are
hashed before logging.

## Troubleshooting

| Symptom | Primary action |
| --- | --- |
| Transition blocked | Run `node .claude/scripts/session-checkpoint.mjs get-status`, then complete the missing phase or use `override-skip`. |
| Dispatch blocked | Complete the prerequisite, create `gate-override.json`, or use the kill switch. |
| Session completion blocked | Run `node .claude/scripts/session-checkpoint.mjs verify`; fix missing dispatches, convergence depth, artifacts, manifest/session drift, or deployment verification. |
| `WARN: convergence drift detected` | Accept manifest seed for resumed work, or use `--force-reset-convergence` for intentional re-verification. |
| `CONVERGENCE_SESSION_PARSE_FAILED` | Repair `.claude/context/session.json`; see [ENFORCEMENT-RECOVERY.md](ENFORCEMENT-RECOVERY.md). |
| `CONVERGENCE_TAIL_WALK_BOUNDED` | Inspect recent evidence for the affected gate. |
| `SESSION_JSON_SYMLINK_REFUSED` | Replace symlinked `session.json` with a regular file. |
| `SOURCE_FORBIDDEN_VIA_CLI` | Stop using CLI pass writes; evidence writes are programmatic through `recordPass()`. |
| Bash command blocked | Use the dedicated writer CLI or rewrite as a statically analyzable read command. |

## See Also

- [HOOKS.md](HOOKS.md) - live hook inventory and hook placement.
- [ENFORCEMENT-RECOVERY.md](ENFORCEMENT-RECOVERY.md) - recovery procedures.
- [bash-intent-classifier.md](bash-intent-classifier.md) - Bash classifier behavior.
- [bash-intent-classifier-api.md](bash-intent-classifier-api.md) - classifier API.
- `.claude/scripts/lib/workflow-dag.mjs` - DAG, workflow, and risk-tier source of truth.
- `.claude/scripts/lib/stop-hook-checks.mjs` - completion-invariant source of truth.

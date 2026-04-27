---
_source_modules: ['workflow-scripts']
last_reviewed: 2026-04-27
title: Workflow Enforcement Architecture
---

# Workflow Enforcement Architecture

Workflow enforcement has two layers:

- Cooperative layer: `session-checkpoint.mjs` is the writer for workflow state,
  convergence updates, route decisions, deployment markers, and verification.
- Coercive layer: hooks block unsafe dispatches, protected-file writes, invalid
  completion, and trust-bearing edits made through exempt workflows.

This is the current operator contract. Script internals remain in the files
named below.

## Runtime Surfaces

| Surface | Trigger | Role |
| --- | --- | --- |
| `.claude/scripts/session-checkpoint.mjs` | CLI | Mutates session/workflow state and runs read-only verification. |
| `.claude/scripts/workflow-gate-enforcement.mjs` | `PreToolUse` `Agent` | Blocks gated subagent dispatches when prerequisites are missing. |
| `.claude/scripts/workflow-stop-enforcement.mjs` | `Stop` | Blocks completion for missing dispatches, obligations, completion checks, or deployment verification. |
| `.claude/scripts/workflow-file-protection.mjs` | `PreToolUse` `Write` and `Bash` | Blocks direct writes to enforcement state and trust roots. |
| `.claude/scripts/convergence-pass-recorder.mjs` | `SubagentStop` | Calls `recordPass()` to append convergence evidence. |
| `.claude/scripts/lib/workflow-dag.mjs` | shared module | Owns workflows, phases, dispatch prerequisites, risk-tier stop rules, obligations, and substage rules. |
| `.claude/scripts/lib/stop-hook-checks.mjs` | shared module | Owns the completion-invariant checks used by Stop and `session-checkpoint verify`. |
| `.claude/scripts/lib/bash-intent-classifier.mjs` | shared module | Classifies Bash read/write intent for protected targets. |

## Session Checkpoint CLI

Common commands:

```bash
node .claude/scripts/session-checkpoint.mjs start-work <sg-id> <workflow> "<objective>"
node .claude/scripts/session-checkpoint.mjs start-work <sg-id> <workflow> "<objective>" --force-reset-convergence
node .claude/scripts/session-checkpoint.mjs transition-phase <phase>
node .claude/scripts/session-checkpoint.mjs dispatch-subagent <id> <type> <desc> [--stage <stage>]
node .claude/scripts/session-checkpoint.mjs complete-subagent <task_id> "<summary>"
node .claude/scripts/session-checkpoint.mjs update-convergence <gate_name>
node .claude/scripts/session-checkpoint.mjs reconcile-convergence <sg-id> [--dry-run]
node .claude/scripts/session-checkpoint.mjs verify [--spec-group <sg-id>]
node .claude/scripts/session-checkpoint.mjs complete-work
node .claude/scripts/session-checkpoint.mjs archive-incomplete
node .claude/scripts/session-checkpoint.mjs override-skip --phase <phase> --rationale "<reason>"
node .claude/scripts/session-checkpoint.mjs reset-enforcement --rationale "<reason>"
```

Rules:

- `start-work` creates or resumes `session.active_work`; non-exempt workflow
  downgrades are rejected.
- `transition-phase` validates the DAG and writes the active phase.
- `update-convergence` derives counters from evidence. It does not accept a
  caller-provided count.
- `record-pass` is not a public write path. CLI attempts exit 2 with
  `SOURCE_FORBIDDEN_VIA_CLI`; `convergence-pass-recorder.mjs` calls the
  exported `recordPass()` API in-process.
- `verify` runs the same completion-invariant library as the Stop hook.

## DAG Rules

Workflows:

| Workflow | Enforcement |
| --- | --- |
| `oneoff-spec` | DAG, dispatch, convergence, Stop, and obligation enforcement. |
| `orchestrator` | DAG, dispatch, convergence, Stop, and obligation enforcement. |
| `oneoff-vibe`, `refactor`, `journal-only` | Exempt unless the Stop hook detects trust-bearing enforcement edits. |

Main phase chain for enforced workflows:

```text
spec/prd -> investigate -> challenge -> approve -> implement -> test -> verify -> review -> completion_verifying -> document -> complete
```

Current required challenger substages:

| Workflow | Dispatch stage | Session substage |
| --- | --- | --- |
| `oneoff-spec` | `pre-implementation` | `pre-impl` |
| `orchestrator` | `pre-orchestration` | `pre-orch` |

`pre-test` remains accepted for older sessions but is not required. Other former
stage names are not current. `substages_visited` is object-shaped:

```json
{
  "substages_visited": {
    "challenging": ["pre-impl"]
  }
}
```

Malformed shape blocks with `dag.substage.malformed`; missing required
substages block with `dag.substage.skipped`; old bare `challenging` history is
logged as `dag.substage.legacy_visit_ignored` and ignored.

Enforcement levels:

| Level | Effect |
| --- | --- |
| `off` | Cooperative transitions are allowed. |
| `warn-only` | Selected DAG/coverage failures warn instead of blocking. |
| `graduated` | Violations block unless an override applies. |

## Dispatch and Stop Gates

Dispatch prerequisites:

| Subagent | Gate |
| --- | --- |
| `implementer` | `investigation` and `challenger` convergence at 2 clean passes. |
| `test-writer` | No workflow gate; isolation lives elsewhere. |
| `e2e-test-writer` | No workflow gate; black-box isolation lives elsewhere. |
| `code-reviewer`, `security-reviewer` | `unifier` dispatch exists. |
| `documenter`, `completion-verifier` | `code_review` and `security_review` convergence at 2 clean passes. |

Risk-tier Stop requirements:

| `active_work.risk_tier` | Dispatches required at terminal phases |
| --- | --- |
| `trust-bearing` or invalid/missing | `code-reviewer`, `security-reviewer`, `completion-verifier`, `documenter`, `e2e-test-writer` |
| `user-visible` | `code-reviewer`, `e2e-test-writer` |
| `shared-library`, `local-feature` | `code-reviewer` |
| `docs-prompt-metadata`, `mechanical-cleanup` | none |

The Stop hook also checks phase-aware dispatch requirements before terminal
completion. `e2e-test-writer` is dropped only when the active spec opts out with
`e2e_skip: true` and a valid `e2e_skip_rationale`.

Completion can also block on:

- unsatisfied manifest status obligations;
- failed completion-invariant checks;
- deployment detected without post-deploy verification;
- trust-bearing enforcement files edited from an exempt workflow.

## Completion Checks

The five completion-invariant checks run only when:

- `session.active_work.spec_group_id` is set and matches the spec-group id
  shape;
- `active_work.current_phase === "complete"`;
- the workflow is non-exempt.

| Check | Blocks when |
| --- | --- |
| Convergence depth | any tracked gate has `clean_pass_count < 2`; missing or non-number counts as 0. |
| Challenger stage coverage | required challenger stage dispatch is missing and no matching `override_skip` exists. |
| Phase DAG predecessors | required predecessor evidence is missing and no matching `override_skip` exists. |
| Artifact inventory | required spec-group artifacts are missing. |
| Convergence-field sanity | manifest convergence fields disagree with session counters. |

`warn-only` affects challenger-stage and phase-DAG predecessor failures. The
convergence-depth, artifact-inventory, and convergence-field checks still block.

## Overrides and Kill Switch

Cooperative phase override:

```bash
node .claude/scripts/session-checkpoint.mjs override-skip --phase <phase> --rationale "<reason>"
```

The session cap is three cooperative overrides; `start-work` resets it.

Coercive gate override file:

```json
{
  "gate": "implementer",
  "session_id": "<session-id>",
  "timestamp": "<ISO 8601>",
  "rationale": "specific reason"
}
```

Path: `.claude/coordination/gate-override.json`. It is protected from agent
writes.

Global kill switch:

```bash
touch .claude/coordination/gate-enforcement-disabled
```

Presence disables gate and Stop enforcement. File protection remains active, so
agents cannot create or remove the sentinel themselves.

Record kill-switch changes with:

```bash
node .claude/scripts/audit-append.mjs create --rationale "<reason>"
node .claude/scripts/audit-append.mjs remove --rationale "<reason>"
```

## Protected File Enforcement

`workflow-file-protection.mjs` blocks `Write` and write-intent Bash commands
against protected enforcement state.

| Command shape | Result |
| --- | --- |
| Read-only command against protected file | Allowed. |
| Known write verb or redirect to protected file | Blocked. |
| Parse failure, dynamic/evasive command, non-ASCII or encoded path, glob path, oversized command | Fail-closed with `HOOK_CLASSIFIER_FAIL_CLOSED`. |
| Attested audit append touching only audit-log patterns | Allowed. |
| Mixed audit-log and exact protected-file targets | Blocked. |

Protected trust roots include coordination sentinels, `session.json`,
deployment/audit logs, audit-chain verifiers, and deployment manifests. Bash
classifier details live in [bash-intent-classifier.md](bash-intent-classifier.md)
and [bash-intent-classifier-api.md](bash-intent-classifier-api.md).

## Fail-Open Policy

Gate and Stop hooks fail open for structural errors unless a rule says
otherwise:

- missing or malformed hook stdin;
- missing or malformed `session.json`;
- missing `active_work`;
- missing workflow type;
- top-level script exception.

Fail-closed paths:

- missing convergence counters count as 0 for dispatch and completion gates;
- `update-convergence` exits non-zero on malformed session JSON with
  `CONVERGENCE_SESSION_PARSE_FAILED`;
- protected-file Bash parse failures block.

## Two-Store Convergence Model

Convergence state lives in two stores:

| Store | Scope | Holds | Main writers |
| --- | --- | --- | --- |
| `manifest.json:.convergence` | durable and persistent per spec group | durable booleans such as `<gate>_converged`, `<gate>_passed`, and `spec_complete` | `session-checkpoint.mjs update-convergence`, `complete-work`, spec/document writers |
| `session.json:.convergence` | session-scoped cache | `<gate>.clean_pass_count`, iteration counters, parse-failure counters, source provenance | `session-checkpoint.mjs update-convergence`, imported `recordPass()` |

Authoritative source per reader:

| Reader | Source |
| --- | --- |
| Dispatch gates | `session.json:.convergence` |
| Stop convergence-depth check | `session.json:.convergence` |
| Stop convergence-field sanity check | both stores, cross-checked |
| `completion-verifier` | both stores, cross-checked |
| Phase-transition status obligations | `manifest.json:.convergence` |

Drift happens when `active_work` switches, a session is interrupted between
evidence and manifest writes, or a store is edited manually.

Reconciliation rule: manifest wins. If manifest convergence is true while the
session counter is below 2, `start-work` and `reconcile-convergence` warn, seed
the session counter to 2, and record `manifest_seed` provenance. Intentional
re-verification uses `--force-reset-convergence`, which clears manifest booleans
and session counters for the selected work.

## Convergence State on `active_work` Switch

This section is the operator-visible form of the
[Two-Store Convergence Model](#two-store-convergence-model).

Default behavior:

- manifest convergence persists across sessions;
- `start-work` detects manifest/session drift;
- stderr includes a `WARN` naming the stored values and saying `manifest wins`;
- `session.json:.convergence.<gate>.clean_pass_count` is seeded to 2;
- session history records `convergence_manifest_seeded`;
- false manifest convergence fields are not seeded.

Useful commands:

```bash
node .claude/scripts/session-checkpoint.mjs reconcile-convergence <sg-id> --dry-run
node .claude/scripts/session-checkpoint.mjs start-work <sg-id> <workflow> "<objective>" --force-reset-convergence
```

## Convergence State Reader Contract

Tracked gates:

`code_review`, `security_review`, `investigation`, `challenger`, `unifier`,
`completion_verifier`

| Reader | Reads | Writes |
| --- | --- | --- |
| `workflow-gate-enforcement.mjs` | session clean-pass counters | none |
| `workflow-stop-enforcement.mjs` | manifest obligations and session completion checks | none |
| `completion-verifier` | manifest and session convergence | none |
| `convergence-pass-recorder.mjs` | SubagentStop payload | pass evidence through `recordPass()` |
| `session-checkpoint.mjs` | both stores | canonical session and manifest updates |

After `start-work` returns for a non-exempt workflow, session counters are
coherent with manifest booleans unless a force reset is active.

## Evidence-Based Convergence

Clean-pass counters are derived from
`session.convergence_evidence.<gate>.passes[]`.

Derivation:

- walks the last 200 records from the tail;
- accepts canonical `record_source` values `hook`, `parse_failed`, and
  `manual_fallback`;
- legacy `manual` and `hook_manual` records remain parseable for audit but do
  not count;
- dirty records reset the streak;
- bound-hit without an eligible streak start emits `CONVERGENCE_TAIL_WALK_BOUNDED`.

`recordPass()` appends evidence by temp-file plus same-filesystem `rename()`,
creates temp files with mode `0600`, rejects symlinked `session.json`, and does
not edit existing records.

## State and Logs

Important session fields:

- `phase_checkpoint.enforcement_level`, `override_count`,
  `enforcement_counter`, and `_counter_checksum`;
- `active_work.workflow`, `active_work.risk_tier`, and
  `active_work.spec_group_id`;
- `subagent_tasks.in_flight` and `completed_this_session`;
- `convergence.<gate>.clean_pass_count`;
- `convergence_evidence.<gate>.passes[]`;
- `substages_visited`.

Common stderr/log events:

| Event | Meaning |
| --- | --- |
| `convergence.streak.derived` | clean streak was derived from evidence. |
| `convergence.legacy_source_rejected` | legacy evidence source was ignored for counting. |
| `convergence.session_parse_failed` | malformed session JSON blocked `update-convergence`. |
| `dag.substage.skipped` | required substage missing. |
| `dag.substage.malformed` | malformed `substages_visited` shape. |
| `WORKFLOW_IMMUTABLE` | mid-session workflow change rejected. |

Structured errors avoid stack traces and raw source bytes; session IDs are
hashed before logging.

## Troubleshooting

| Symptom | Primary action |
| --- | --- |
| Transition blocked | Run `session-checkpoint.mjs get-status`, then complete the missing phase or use `override-skip`. |
| Dispatch blocked | Complete the prerequisite, create `gate-override.json`, or use the kill switch. |
| Completion blocked | Run `session-checkpoint.mjs verify`; fix missing dispatches, convergence depth, artifacts, manifest/session drift, or deployment verification. |
| `WARN: convergence drift detected` | Accept manifest seed for resumed work, or use `--force-reset-convergence`. |
| `CONVERGENCE_SESSION_PARSE_FAILED` | Repair `.claude/context/session.json`; see [ENFORCEMENT-RECOVERY.md](ENFORCEMENT-RECOVERY.md). |
| `CONVERGENCE_TAIL_WALK_BOUNDED` | Inspect recent evidence for the affected gate. |
| `SESSION_JSON_SYMLINK_REFUSED` | Replace symlinked `session.json` with a regular file. |
| Bash command blocked | Use the dedicated writer CLI or rewrite as a statically analyzable read command. |

## See Also

- [HOOKS.md](HOOKS.md)
- [ENFORCEMENT-RECOVERY.md](ENFORCEMENT-RECOVERY.md)
- [bash-intent-classifier.md](bash-intent-classifier.md)
- [bash-intent-classifier-api.md](bash-intent-classifier-api.md)
- `.claude/scripts/lib/workflow-dag.mjs`
- `.claude/scripts/lib/stop-hook-checks.mjs`

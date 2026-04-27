---
_source_modules: ['workflow-scripts']
last_reviewed: 2026-04-21
title: Workflow Enforcement Architecture
---

# Workflow Enforcement Architecture

Workflow enforcement operates in two layers. The **cooperative layer** (DAG-based phase transitions via `session-checkpoint.mjs`) enables agents to self-advance through workflow stages with warnings for violations. The **coercive layer** (PreToolUse/Stop hooks) physically blocks tool execution when prerequisites are not met, bypassing cooperative participation.

This document describes the full enforcement architecture including predecessor graphs, override mechanisms, evidence-based convergence, and failure modes.

---

## Enforcement Layers

### Cooperative Layer

Handled by `session-checkpoint.mjs`. DAG-based phase transitions validate predecessors and emit warnings/blocks based on enforcement level.

**Transition commands**:

```bash
node .claude/scripts/session-checkpoint.mjs transition-phase <phase>
node .claude/scripts/session-checkpoint.mjs override-skip <phase> <rationale>
node .claude/scripts/session-checkpoint.mjs reset-enforcement
```

**Enforcement levels**:

- `off`: No enforcement; all transitions allowed (informational checklist only)
- `warn-only`: Log warnings for skipped mandatory stages but allow transitions
- `graduated`: Block transitions that skip mandatory predecessors; require explicit override

### Coercive Layer

Handled by PreToolUse and Stop hooks. Blocks execution regardless of cooperative state.

| Hook                                            | Trigger                                         | Purpose                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `.claude/scripts/workflow-gate-enforcement.mjs` | PreToolUse Agent                                | Block dispatch of enforced subagent types when prerequisites not met                                          |
| `.claude/scripts/workflow-file-protection.mjs`  | PreToolUse Write + Bash                         | Block agent writes (Write tool) and write-intent Bash commands targeting protected enforcement files          |
| `.claude/scripts/workflow-stop-enforcement.mjs` | Stop                                            | Block session completion on missing dispatches, obligation violations, or completion-invariant check failures |
| SubagentStop convergence pass recorder          | `.claude/scripts/convergence-pass-recorder.mjs` | Automated pass evidence recording for convergence gates                                                       |

### Shared DAG Module

Single source of truth for predecessor graphs, enforcement tables, and query functions: `.claude/scripts/lib/workflow-dag.mjs`. Consumed by both cooperative and coercive layers.

### Shared Stop-Hook Checks Module

Pure-function library at `.claude/scripts/lib/stop-hook-checks.mjs`. Exports the `shouldRunChecks()` guard plus five deterministic check functions (`checkConvergenceDepth`, `checkChallengerStages`, `checkPhaseDagPredecessors`, `checkArtifactInventory`, `checkConvergenceFieldSanity`) consumed by both the Stop hook and the `session-checkpoint.mjs verify` CLI. Ensures enforcement cannot drift between the two surfaces. See [Coercive Enforcement: Session Completion](#coercive-enforcement-session-completion) § Completion-Invariant Checks below.

### Protected File Write Detection (Bash)

The Bash path of `workflow-file-protection.mjs` uses `.claude/scripts/lib/bash-intent-classifier.mjs` to classify commands before they touch protected enforcement state.

Current contract:

| Command shape | Result |
| --- | --- |
| Read-only verb against protected file | Allowed |
| Known write verb or shell redirection to protected file | Blocked |
| Parse failure, dynamic/evasive command, non-ASCII/encoded/glob path, command > 65,536 bytes | Fail-closed with `HOOK_CLASSIFIER_FAIL_CLOSED` |
| Attested audit append touching only audit-log patterns | Allowed |
| Mixed audit-log and exact protected-file targets | Blocked |

The protected-file list is owned by `workflow-file-protection.mjs` and re-exported by the classifier. Detailed parser behavior lives in [`bash-intent-classifier.md`](./bash-intent-classifier.md) and [`bash-intent-classifier-api.md`](./bash-intent-classifier-api.md).

---

## DAG Predecessor Graph

The DAG defines valid phase transitions. Each phase declares its valid predecessors and mandatory prerequisites.

### Phase List (16)

`prd_gathering`, `spec_authoring`, `atomizing`, `enforcing`, `investigating`, `awaiting_approval` (backwards compat), `auto_approval`, `challenging`, `implementing`, `testing`, `verifying`, `reviewing`, `completion_verifying`, `documenting`, `journaling`, `complete`

### Mandatory Predecessors (by phase)

| Phase                  | Mandatory predecessor / gate                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `implementing`         | `investigating` + required challenger substage (`pre-impl` for oneoff-spec, `pre-orch` for orchestrator) |
| `reviewing`            | `unifier` dispatch                                                                            |
| `completion_verifying` | `code_review` and `security_review` clean-pass convergence for `completion-verifier` dispatch |
| `documenting`          | `code_review` and `security_review` clean-pass convergence for `documenter` dispatch          |
| `complete`             | phase-aware Stop-hook dispatch requirements selected by `active_work.risk_tier`               |

Phases not listed have no mandatory predecessors beyond the standard DAG edges (they always pass predecessor validation).

### Challenger Sub-Stage Nodes

The challenger phase (`challenging`) has two current required sub-stage nodes.
The `pre-test` short form is still accepted for in-flight session compatibility,
but it is not required by any workflow. `pre-review` is historical and is not a
current valid substage.

| Short form | Status | Trigger point |
| ---------- | ------ | ------------- |
| `pre-impl` | required for oneoff-spec | Before implementation |
| `pre-orch` | required for orchestrator | Before orchestration / implementation |
| `pre-test` | compatibility only | Accepted in old session state; no current gate requires it |

Workflow-scoped required sets (source: `REQUIRED_SUBSTAGES_BY_WORKFLOW` in `workflow-dag.mjs`):

| Workflow                                  | Required sub-stages |
| ----------------------------------------- | ------------------- |
| `oneoff-spec`                             | `{pre-impl}`        |
| `orchestrator`                            | `{pre-orch}`        |
| `oneoff-vibe`, `refactor`, `journal-only` | exempt (empty set)  |

The `pre-impl` sub-stage does NOT apply to `orchestrator` -- the workflow visits `pre-orch` once at workflow entry, not per-workstream.

**Sub-stage tracking**: `session.substages_visited` is an object keyed by phase name (not a flat array). Example:

```json
{
  "substages_visited": {
    "challenging": ["pre-impl"]
  }
}
```

Populated by `session-checkpoint.mjs transition-phase <phase> <substage>` when `phase === 'challenging'`. The populate call is the sole writer (pass-evidence is not scanned for sub-stage presence). Invalid substages (outside `VALID_SUBSTAGES`) are rejected before any mutation. Legacy bare `challenging` phase entries in `session.history[]` do NOT contribute to `substages_visited`; the obligation check emits `dag.substage.legacy_visit_ignored` per encountered legacy entry and continues.

**Workflow immutability**: The workflow value on `active_work.workflow` is immutable mid-session. A `--workflow` flag passed to `transition-phase` that differs from the current workflow is rejected with `WORKFLOW_IMMUTABLE` (stderr + non-zero exit); session state is not mutated. Exempt workflows are unaffected.

### Enforcement Levels at Transition

| Level       | On violation                                 | Override allowed |
| ----------- | -------------------------------------------- | ---------------- |
| `off`       | Transition succeeds silently                 | N/A              |
| `warn-only` | Transition succeeds with stderr warning      | N/A              |
| `graduated` | Transition blocked with stderr BLOCK message | Yes              |

---

## Override Mechanism

When graduated enforcement blocks a transition or dispatch, agents may bypass specific phases or gates.

### Cooperative Override

```bash
node .claude/scripts/session-checkpoint.mjs override-skip <phase> "<rationale>"
```

Records an `override` event in session history with rationale and phase. Cap: 3 overrides per session (resets on `start-work`).

### Coercive Override

Write to `.claude/coordination/gate-override.json`:

```json
{
  "gate": "implementer",
  "session_id": "<session-id>",
  "timestamp": "<ISO 8601>",
  "rationale": "Override rationale (min 10 chars)"
}
```

Per-gate rationales. Once written, the gate enforcement hook exits 0 on match. The override file itself is FULL_BLOCK-protected -- only human terminal writes or trusted CLI scripts can create it.

### Kill Switch

```bash
touch .claude/coordination/gate-enforcement-disabled
```

Disables gate enforcement and stop enforcement entirely. Write protection remains active (agents cannot self-bypass enforcement by creating overrides).

---

## Coercive Enforcement: Subagent Dispatch

### Enforcement Table

`.claude/scripts/workflow-gate-enforcement.mjs` blocks the following subagent dispatches when prerequisites are not met:

| Blocked Subagent      | Prerequisite                                                                      |
| --------------------- | --------------------------------------------------------------------------------- |
| `implementer`         | `investigation` and `challenger` convergence clean-pass counts                    |
| `test-writer`         | none; works from spec input                                                       |
| `e2e-test-writer`     | none; black-box read/write isolation is enforced by separate hooks                |
| `code-reviewer`       | `unifier` dispatched                                                              |
| `security-reviewer`   | `unifier` dispatched                                                              |
| `documenter`          | `code_review` and `security_review` convergence clean-pass counts                 |
| `completion-verifier` | `code_review` and `security_review` convergence clean-pass counts                 |

### Block Message Format

When dispatch is blocked, the hook writes to stderr and exits 2:

```
BLOCKED: <subagent-type> dispatch requires:
  - Missing prerequisites (dispatch or convergence)

Override: create .claude/coordination/gate-override.json with:
  { "gate": "<subagent-type>", "session_id": "<current-session>", "timestamp": "<ISO>", "rationale": "<rationale>" }

Or run recommended convergence check first:
  - <skill-command-from-skill-map>
```

### Skill Map

Maps gate names to recommended skill commands in the help message:

| Gate Name                         | Recommended Skill   |
| --------------------------------- | ------------------- |
| `investigation_convergence`       | `/investigate`      |
| `challenger_convergence`          | `/challenge`        |
| `unifier_convergence`             | `/unify`            |
| `code_review_convergence`         | `security-reviewer` |
| `security_review_convergence`     | `documenter`        |
| `completion_verifier_convergence` | `documenter`        |

---

## Coercive Enforcement: Session Completion

`.claude/scripts/workflow-stop-enforcement.mjs` blocks session completion when:

- Phase-aware mandatory dispatches for the route `risk_tier` are missing
- Manifest status obligations are unsatisfied (when `currentPhase === 'complete'`)
- Any of five completion-invariant checks fail (when `currentPhase === 'complete'` with an active spec group, non-exempt workflow -- gated by `shouldRunChecks()`)
- Deployment detected without post-deploy verification

Stop-hook dispatch requirements are selected by
`getStopPhaseRequirements(phase, session)`. Missing or invalid `risk_tier`
defaults to `trust-bearing`, which preserves the historical full dispatch set.
Lower tiers intentionally avoid legacy review/completion/documentation
dispatches when the route gate plan does not require them.

| Risk tier | Complete-phase dispatches |
| --- | --- |
| `trust-bearing` | `code-reviewer`, `security-reviewer`, `completion-verifier`, `documenter`, `e2e-test-writer` |
| `user-visible` | `code-reviewer`, `e2e-test-writer` |
| `shared-library` | `code-reviewer` |
| `local-feature` | `code-reviewer` |
| `docs-prompt-metadata` | none |
| `mechanical-cleanup` | none |

### Completion-Invariant Checks

Beyond dispatch-presence and obligation checks, the Stop hook enforces five completion invariants via the shared library `.claude/scripts/lib/stop-hook-checks.mjs`. Checks run only when `shouldRunChecks(session)` returns true (ALL THREE must hold: `spec_group_id` matches `/^sg-[a-z0-9-]+$/`, `current_phase === 'complete'` strict, workflow is non-exempt). When false, all five checks skip; dispatch-presence and obligation checks continue under their own guards.

| #   | Check                     | Source                  | Blocks when                                                                                                                                    |
| --- | ------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Convergence depth         | `session.convergence`   | any gate's `clean_pass_count < 2` (missing / non-number treated as 0 via strict `typeof` guard)                                                |
| 2   | Challenger stage coverage | `subagent_tasks.*`      | a stage in `REQUIRED_CHALLENGER_STAGES[workflow]` is absent (override_skip honored)                                                            |
| 3   | Phase DAG predecessors    | `session.history`       | a mandatory predecessor of `complete` was not visited (override_skip honored; empty history emits `history_missing`)                           |
| 4   | Artifact inventory        | filesystem (spec group) | oneoff-spec missing `investigation-report.md`, `unify-report.md`, or `docs/COVERAGE.md`; orchestrator additionally missing `atomic/*.md`       |
| 5   | Convergence-field sanity  | `manifest` + `session`  | `manifest.convergence.<gate>_passed === true` disagrees with `session.convergence[gate].clean_pass_count >= 2` (strict `=== true` on manifest) |

**Enforcement-level policy** (codified in `CHECK_ENFORCEMENT_POLICY` in the shared library):

- **Always block** (ignore `warn-only`): convergence depth, convergence-field sanity, artifact inventory
- **Respect `warn-only`**: challenger stages, phase DAG predecessors -- emit stderr warning without blocking when `enforcement_level === 'warn-only'`

### Local Verification CLI

`session-checkpoint.mjs verify [--spec-group <sg-id>]` runs the same five checks locally and prints a deterministic PASS/FAIL summary. Shares the library with the Stop hook, so the outcome matches. Respects the kill switch and exempt workflows.

```bash
# Verify the session's active spec group
node .claude/scripts/session-checkpoint.mjs verify

# Verify a specific spec group (no active session required)
node .claude/scripts/session-checkpoint.mjs verify --spec-group <spec-group-id>
```

Exit 0 on clean; exit 1 on any check failure or resolution error (invalid sg-id format, nonexistent spec group, no active spec group and no flag). This section owns the completion-check semantics; HOOKS.md documents where the Stop hook invokes them.

### Fail-Open Policy

All structural errors result in fail-open (exit 0):

- Missing `session.json`
- Malformed JSON in `session.json`
- Missing `active_work` field
- Missing workflow type
- Script errors (top-level try/catch)
- Malformed stdin input

**Fail-Closed Exception**: Missing convergence fields (`convergence.code_review.clean_pass_count`, `convergence.security_review.clean_pass_count`) default to 0. This blocks downstream dispatch until convergence is explicitly recorded. The completion-invariant convergence-depth check (Check 1 above) extends this to all gates in `session.convergence`, treating missing or non-numeric `clean_pass_count` values as 0.

---

## Two-Store Convergence Model

Convergence state is stored in **two** places by design, not by oversight. This section is the single authoritative reference.

### (a) What each store holds

| Store                                         | Scope                                    | Fields                                                                                                     | Writers                                                                    |
| --------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `manifest.json:.convergence` (per spec group) | Persistent; survives session boundaries  | `<gate>_converged` (boolean), `<gate>_passed` (boolean), `spec_complete`, `all_acs_implemented`, etc.      | `session-checkpoint.mjs update-convergence` after verified evidence, `complete-work`, spec-author, documenter |
| `session.json:.convergence` (per session)     | Session-scoped; re-derived at start-work | `<gate>.clean_pass_count` (int), `<gate>.iteration_count`, `<gate>.parse_failed_count`, `<gate>.sources[]` | `session-checkpoint.mjs update-convergence` / `recordPass()` module export |

`manifest.json` owns the **durable assertion** that a gate converged for a given spec group. `session.json` owns the **live counter** that a gate-enforcement hook consults before permitting downstream dispatch in the current session.

### (b) Authoritative store per check

| Check                                                                            | Authoritative Source         | Rationale                                                                    |
| -------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| `workflow-gate-enforcement.mjs` dispatch prerequisites                           | `session.json:.convergence`  | Must reflect the running session's live pass count                           |
| `workflow-stop-enforcement.mjs` completion-invariant Check 1 (convergence depth) | `session.json:.convergence`  | Session-owned counter is the ground truth for the active work window         |
| `workflow-stop-enforcement.mjs` Check 5 (convergence-field sanity)               | Both (cross-check)           | Detects drift between the two stores at completion time                      |
| `completion-verifier` agent evaluation                                           | Both (cross-check)           | Verifies the manifest's durable assertion matches the session's live counter |
| Phase-transition obligations (`transition-phase`)                                | `manifest.json:.convergence` | Durable record of per-phase gate completion                                  |

### (c) Drift scenarios

The two stores can legitimately disagree:

1. **`active_work` switch**: Operator runs `session-checkpoint.mjs start-work <sg-B>` after a session in which sg-A reached convergence. `manifest.json:.convergence.investigation_converged = true` for sg-A; `session.json:.convergence.investigation.clean_pass_count` is session-scoped and may be `0` for sg-B with no prior evidence in that session.
2. **Interrupted session**: A session crashes mid-run after pass recording but before `update-convergence`; `session.json.convergence_evidence` has evidence but `session.json.convergence.<gate>.clean_pass_count` has not been re-derived.
3. **Manual edit**: Operator or another tool directly edits one store without the other (BLOCKED by `workflow-file-protection.mjs` for `session.json`, but may occur on `manifest.json` during spec authoring).

### (d) Reconciliation rule (**manifest wins**)

When a drift is detected at `start-work` or `completion-verifier` time:

- `manifest.json:.convergence.<gate>_converged === true` AND `session.json:.convergence.<gate>.clean_pass_count < 2` -> WARN log naming both values; **seed `session.json.convergence.<gate>.clean_pass_count` to 2** (the required threshold).
- The seed event SHALL be recorded in `session.json.convergence.<gate>.sources[]` with `record_source: "manifest_seed"`.
- `--force-reset-convergence` (intentional re-verification) flips `manifest.json:.convergence.<gate>_converged = false` AND sets `session.json.convergence.<gate>.clean_pass_count = 0`; an audit entry is appended to `manifest.decision_log[]` with `action: convergence_force_reset`.

**Rationale**: The manifest's `_converged` flag is set only after the full gate loop (check + 2 consecutive clean passes) completed for a spec group. That assertion should not be silently invalidated by a session-scope reset; intentional re-verification uses the explicit `--force-reset-convergence` path instead.

See also:

- The `start-work` reconciliation contract implemented in `session-checkpoint.mjs`
- The reconciliation code path in `session-checkpoint.mjs` (seeded by `start-work`) and the cross-check evaluator in `completion-verifier`
- Completion-invariant Check 5 (Convergence-field sanity) in [Coercive Enforcement: Session Completion](#coercive-enforcement-session-completion)

---

## Convergence State on `active_work` Switch

This section documents the operator-visible behavior when `session-checkpoint.mjs start-work` opens a spec group whose manifest already records converged gates from a prior session. It is the runtime form of the [Two-Store Convergence Model](#two-store-convergence-model).

### Seed behavior (default path)

When `manifest.json:.convergence.<gate>_converged === true` and `session.json:.convergence.<gate>.clean_pass_count < 2`, `session-checkpoint.mjs` treats the manifest as authoritative:

- emits a WARN line that names both stored values and says `manifest wins`
- seeds `session.json:.convergence.<gate>.clean_pass_count = 2`
- appends a provenance source entry with `record_source: "manifest_seed"`
- records `convergence_manifest_seeded` in `session.history[]`

Gates whose manifest field is false are not seeded.

### Expected operator response on observed WARN

The WARN is not an error when resuming an already-converged spec group. It is an audit signal that the session cache was restored from durable manifest truth.

| Scenario                                               | Correct response                                        |
| ------------------------------------------------------ | ------------------------------------------------------- |
| You resumed an already-converged spec group            | Accept the seed; the WARN is audit-trail only. Proceed. |
| You intentionally want to re-verify the converged gate | Rerun with `--force-reset-convergence` (see below).     |
| You see the WARN on a spec group you never converged   | Investigate: manifest may have been manually edited.    |

### `--force-reset-convergence` escape hatch

For intentional re-verification, use:

```sh
session-checkpoint.mjs start-work <spec-group-id> <workflow> <objective> --force-reset-convergence
```

The flag resets previously converged gates by flipping manifest convergence booleans to false, setting session clean counts to 0, adding `force_reset` provenance, and appending `convergence_force_reset` to both manifest decision log and session history. There is no silent reset path.

### Completion-verifier consistency

`completion-verifier` and `session-checkpoint.mjs reconcile-convergence <sg-id>` use the same reconcile helper as `start-work`, so manifest-vs-session disagreement is handled consistently without starting new work.

---

## Convergence State Reader Contract

This is the consumer contract for the [Two-Store Convergence Model](#two-store-convergence-model).

### 1. Store authority

`manifest.json:.convergence.<gate>_converged` / `<gate>_passed` is the durable truth. `session.json:.convergence.<gate>.clean_pass_count` is the session-scoped cache reconciled from the manifest on each non-exempt `start-work`.

### 2. Reader contract per consumer

| Consumer                          | Reads                                                               | Writes                                                                                                    | Role                                                   |
| --------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `workflow-gate-enforcement.mjs`   | `session.convergence.<gate>.clean_pass_count` (hot path)            | None                                                                                                      | PreToolUse dispatch guard; relies on eager reconcile   |
| `workflow-stop-enforcement.mjs`   | `manifest.convergence.<gate>_converged` via `validateObligations()` | None                                                                                                      | Stop-hook completion guard; operates on durable truth  |
| `completion-verifier` (subagent)  | `session.convergence.<gate>.clean_pass_count`                       | None                                                                                                      | Post-convergence verification; post-eager-reconcile    |
| `convergence-pass-recorder.mjs`   | N/A                                                                 | Invokes `recordPass()` module export (appends evidence + `session.history[]` + `last_pass_history_index`) | PostToolUse pass writer; sole caller of `recordPass()` |
| `session-checkpoint.mjs` (itself) | Both stores                                                         | `session.json` counters/history and verified manifest convergence mirrors                                | Canonical convergence writer                           |

### 3. Cache coherence guarantee

After `session-checkpoint.mjs start-work <sg> <workflow>` returns, `session.convergence.<gate>.clean_pass_count` is coherent with `manifest.convergence.<gate>_converged` for every session-tracked gate. The two bridges are `start-work`/`reconcile-convergence` from manifest to session, and verified `update-convergence` from session evidence back to manifest.

### 4. EC-14 + EC-18 precedence summary

When both apply, EC-18 wins:

| Case | Effect |
| --- | --- |
| EC-18 force-reset skip | `session.force_reset_reconcile_skip[<spec_group_id>]` short-circuits reconcile after explicit `--force-reset-convergence`. |
| EC-14 recent-pass preservation | A recent `convergence_pass_recorded` entry can preserve a session counter before it has been mirrored to the manifest. Requires `last_pass_history_index`. |

### 5. Session-tracked vs manifest-only gate distinction

The reconciler iterates exactly the six session-tracked gates in `VALID_CONVERGENCE_GATES`:

- `code_review`
- `security_review`
- `investigation`
- `challenger`
- `unifier`
- `completion_verifier`

Other manifest convergence fields are durable-only or auxiliary and are ignored by the session reconciler.

### 6. Operator-facing drift remediation

Drift is visible as a `[session-checkpoint] WARN: convergence drift detected ...` line in stderr. Remediation options:

1. **Accept the seed** — the default path. The WARN is audit-trail only; the session counter has been seeded from the manifest.
2. **Inspect without mutation**: `node .claude/scripts/session-checkpoint.mjs reconcile-convergence <sg> --dry-run` — reads state and emits drift warnings prefixed with `[dry-run] `; does not mutate `session.json`.
3. **Force reset**: `node .claude/scripts/session-checkpoint.mjs start-work <sg> <workflow> --force-reset-convergence` — flips manifest booleans to `false` and resets session counters to 0 for re-verification. Also writes `session.force_reset_reconcile_skip[<sg>]` to suppress downstream reconcile attempts in the same session.
4. **Clear a dangling pointer**: `node .claude/scripts/session-checkpoint.mjs start-work <sg> <workflow> --clear-dangling` — clears `session.active_work` when it references a spec-group directory that no longer exists. No-op with explanatory stderr when nothing to clear.

### 7. Forward reference

Manifest convergence writer enforcement is the remaining boundary: until every manifest write is forced through canonical writers, drift introduced by manual edits is remediated with `reconcile-convergence <sg>` or `spec-author` re-entry.

---

## Evidence-Based Convergence

Convergence gates use evidence-derived counters. A gate advances only after the required clean-pass threshold is derived from `session.convergence_evidence.<gate>.passes[]`; agents do not self-report `clean_pass_count`.

### How It Works

1. `convergence-pass-recorder.mjs` records SubagentStop results through the imported `recordPass()` API.
2. `session-checkpoint.mjs update-convergence <gate_name>` derives `clean_pass_count` and `iteration_count` from evidence.
3. Gate/Stop enforcement reads derived session counters and completion sanity checks compare them with manifest fields.

### Derivation Contract

`deriveConvergenceFromEvidence(passes, gateName, sessionId)` is pure and read-only over `passes[]`. It walks the last 200 entries from the tail:

- canonical sources `hook`, `parse_failed`, and `manual_fallback` contribute to `iteration_count`
- `clean === true` contributes to `clean_pass_count` only while the streak is live
- any canonical dirty record freezes the clean streak
- legacy/unknown records are skipped and logged as `convergence.legacy_source_rejected`
- bound-hit without an eligible streak start emits `CONVERGENCE_TAIL_WALK_BOUNDED`

### Source Enum and Visibility

| Source                 | Contributes to `iteration_count` | Contributes to `clean_pass_count` (when `clean: true`) | Streak behavior on dirty | Writer                                          |
| ---------------------- | -------------------------------- | ------------------------------------------------------ | ------------------------ | ----------------------------------------------- |
| `hook`                 | Yes                              | Yes                                                    | Resets streak            | `recordPass()` via hook (canonical)             |
| `parse_failed`         | Yes                              | Yes                                                    | Resets streak            | `recordPass()` on extractor miss (canonical)    |
| `manual_fallback`      | Yes                              | Yes                                                    | Resets streak            | `recordPass()` on log write failure (canonical) |
| `manual` (legacy)      | No (INVISIBLE)                   | No (INVISIBLE)                                         | Does NOT reset streak    | None; pre-existing on disk only                 |
| `hook_manual` (legacy) | No (INVISIBLE)                   | No (INVISIBLE)                                         | Does NOT reset streak    | None; pre-existing on disk only                 |

Legacy records predate the current CLI source contract. They remain parseable for audit; derivation treats them as if they do not exist. When a tail-walk encounters a legacy record, it skips and continues -- the streak's liveness from the records around the legacy entry is preserved.

### Pass Evidence Records

Each convergence pass is recorded as a structured evidence record in `session.convergence_evidence.<gate>.passes[]`:

```json
{
  "pass_number": 1,
  "timestamp": "2026-04-02T14:30:00.000Z",
  "agent_type": "interface-investigator",
  "findings_count": 3,
  "findings_hash": "a1b2c3d4...",
  "clean": false,
  "record_source": "hook"
}
```

Records are append-only. No command may modify or delete existing entries. Duplicate `pass_number` values are rejected.

### Tail-Walk Bound

The walk is bounded to the last 200 entries (legacy-pollution defense). When the bound is hit without a canonical eligible streak start, `countConsecutiveCleanFromTail` emits `CONVERGENCE_TAIL_WALK_BOUNDED` to stderr with the gate name. This signals operators that the evidence history warrants inspection.

### Session Parse-Failure Recovery

When `update-convergence` cannot read or parse `session.json`, it emits a `convergence.session_parse_failed` structured log line (path + truncated error detail, ≤200 chars, no stack) and exits non-zero with `CONVERGENCE_SESSION_PARSE_FAILED`. This is fail-closed: a corrupt `session.json` blocks convergence updates rather than silently returning zeros that could mislead downstream hooks. The audit log line provides enough detail for operator triage without leaking source bytes.

### Atomic Write Contract (recordPass)

`recordPass()` uses an inline atomic read-modify-write helper (`recordPassAtomicWrite`) rather than shared lockfiles. Contract:

| Property              | Implementation                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| Write primitive       | Write-to-tmp + POSIX `rename()` on the same filesystem                                                    |
| Tmp filename          | `session.json.tmp.<pid>.<timestamp_ms>`                                                                   |
| Tmp file mode         | Explicit `0o600` (owner read/write only; does NOT rely on `umask`)                                        |
| Symlink defense       | `lstat()` pre-check on target; `open()` with `O_NOFOLLOW` (defense-in-depth); abort on symlink            |
| Symlink error code    | `SESSION_JSON_SYMLINK_REFUSED` (thrown as `RecordPassError` with `.code`)                                 |
| Stale-tmp sweep       | Post-rename readdir on target's directory; unlink `session.json.tmp.*` files with mtime > 60s             |
| Sweep failure policy  | Best-effort: errors logged to stderr, never propagated (parent write already succeeded)                   |
| Locks                 | None. No `proper-lockfile`, `flock`, or advisory locks. Concurrent recordPass calls race on `rename()`.   |
| Append-only invariant | Modifier callback uses `passes.push(record)`; existing entries are preserved by `JSON.stringify` ordering |
| Workflow immutability | `recordPass()` does not read or write the session's workflow field                                        |

On any `RecordPassError`, the hook emits `convergence.record_pass_failed` with `gate`, `agent_type`, and a truncated `error` field.

### 4-Tier Agent-Type Extractor

`convergence-pass-recorder.mjs` resolves agent identity from the SubagentStop payload by first match:

| Tier | Path                                     | Rationale                                                       |
| ---- | ---------------------------------------- | --------------------------------------------------------------- |
| 1    | `input.agent_type`                       | Documented canonical field                                      |
| 2    | `input.subagent_type`                    | Alternate envelope key (used by sibling `dispatch-record-hook`) |
| 3    | `input.tool_input.subagent_type`         | PreToolUse-style nested envelope                                |
| 4    | `input.hookSpecificOutput.subagent_type` | Hook-specific envelope                                          |

Null resolution records a `parse_failed` dirty pass instead of silently dropping the event.

### 4-Tier Findings Extraction Pipeline

The recorder runs four first-match extractors against the agent response:

| Tier | Path name        | Detection                                                                                  | Classification                         |
| ---- | ---------------- | ------------------------------------------------------------------------------------------ | -------------------------------------- |
| 1    | `severity`       | Severity regex (`critical:`, `high:`, etc.) or JSON `findings-summary` code block          | CLEAN or DIRTY based on gate threshold |
| 2    | `finding_list`   | Bulleted / numbered / bare-indent finding-ID lists (prefix allow-list) or heading cues     | DIRTY with finding-count               |
| 3    | `severity_prose` | Line-anchored severity-word prose with negation guard (fenced code + blockquotes stripped) | DIRTY                                  |
| 4    | `success_marker` | Normalized last non-empty line matches `no issues found`, `all checks passed`, etc.        | CLEAN                                  |

Severity-zero output falls through to later tiers; `code_review` clears on 0 High+ findings and all other gates clear on 0 Medium+ findings. No extractor match records a streak-breaking `parse_failed` pass.

### --source CLI Rejection

The CLI `record-pass` command rejects **every** `--source` value and exits with code 2 before any state mutation:

```
SOURCE_FORBIDDEN_VIA_CLI: pass recording via --source <value> is not supported.
All pass evidence writes are programmatic, performed by convergence-pass-recorder.mjs
via module import only.
```

Every `--source` value is rejected: `hook`, `manual`, `hook_manual`, `parse_failed`, `manual_fallback`. All pass evidence writes are programmatic via `recordPass()` imported directly from `session-checkpoint.mjs`. The sole in-process caller is `convergence-pass-recorder.mjs`. Rejection is unconditional on environment state (no `CLAUDE_HOOK_EVENT`, `NODE_ENV`, or `$USER`-dependent bypass).

### CLI Commands

#### record-pass (CLI surface removed)

`record-pass` is retained only to reject stale callers. Every `--source` value exits 2 with `SOURCE_FORBIDDEN_VIA_CLI`; pass evidence writes happen through the imported `recordPass()` API.

#### update-convergence (derivation-only API)

```bash
node .claude/scripts/session-checkpoint.mjs update-convergence <gate_name>
```

Derives both counters from evidence, mirrors satisfied gates to the manifest, logs `convergence.streak.derived`, warns when >50% of records are non-hook-sourced, and fails closed with `CONVERGENCE_SESSION_PARSE_FAILED` on unreadable/malformed `session.json`. A numeric count argument is rejected.

#### verify (local completion-invariant check)

```bash
node .claude/scripts/session-checkpoint.mjs verify [--spec-group <sg-id>]
```

Runs the five completion-invariant checks against the active or specified spec group. Exit 0 on clean; exit 1 on check failure, invalid spec-group id, nonexistent spec group, or missing active spec group. Respects the kill switch and exempt workflows.

#### update-circuit-breaker

```bash
node .claude/scripts/session-checkpoint.mjs update-circuit-breaker \
  --gate <gate_name> --event <failure|success>
```

Updates `session.json.convergence_log_failures.<gate>` after session.log write success/failure. Three consecutive failures enter degraded mode; a success clears it. Exit 2 on invalid gate/event.

### Circuit Breaker (Degraded Mode)

Per-gate circuit breaker for repeated `.claude/context/session.log` write failures. State shape:

```json
{
  "consecutive_count": 2,
  "last_failure_at": "2026-04-17T04:30:00.000Z",
  "degraded_mode": false,
  "entered_degraded_at": null
}
```

At `consecutive_count >= 3`, degraded mode suppresses session.log writes and emits stderr diagnostics while still recording safe `parse_failed` evidence. The next successful session.log write clears degraded mode. The session.log file is FULL_BLOCK-protected against agent Edit/Write paths; recorder-owned appends create/chmod it as `0600`.

### Canonical Findings Hash

Finding IDs are sorted lexicographically, JSON-stringified, and SHA-256 hashed by `computeFindingsHash()` so passes can prove they examined the same finding set.

### Module-Import API

`session-checkpoint.mjs` exports `recordPass()` for in-process writes:

```javascript
import { recordPass } from '.claude/scripts/session-checkpoint.mjs';

await recordPass({
  source: 'hook', // or 'parse_failed' | 'manual_fallback' (only 3 canonical values)
  gate: 'investigation', // one of VALID_CONVERGENCE_GATES
  clean: true, // boolean (required)
  findingCount: 0, // optional
  findingsHash: '<64-hex>', // optional
  agentType: 'interface-investigator',
  agentId: '<uuid>', // optional
});
```

`recordPass()` is the sole permitted writer for pass evidence records. Its source enum is narrowed to the 3 legitimate hook-path values (`hook`, `parse_failed`, `manual_fallback`), byte-equal to the `record_source` enum in `session.schema.json`. It performs enum + gate + atomic-write validation and throws on invalid input or write failure. The sole importer is `convergence-pass-recorder.mjs`.

**Error codes** (`RecordPassError.code`):

| Code                            | When                                                                  |
| ------------------------------- | --------------------------------------------------------------------- |
| `SESSION_JSON_SYMLINK_REFUSED`  | `lstat()` pre-check detected a symlink at the target path             |
| `SESSION_JSON_LSTAT_FAILED`     | `lstat()` syscall failed (permission, I/O)                            |
| `SESSION_JSON_READ_FAILED`      | `session.json` read or JSON parse failed                              |
| `SESSION_JSON_TMP_OPEN_FAILED`  | `open(tmp, O_CREAT\|O_WRONLY\|O_TRUNC\|O_NOFOLLOW)` failed            |
| `SESSION_JSON_TMP_WRITE_FAILED` | Write/fsync to tmp failed; tmp left on disk per append-only invariant |
| `SESSION_JSON_TMP_CLOSE_FAILED` | Close of tmp failed                                                   |
| `SESSION_JSON_RENAME_FAILED`    | `rename(tmp -> target)` failed; target bytes preserved                |

Each error triggers `emitRecordPassFailedLog()` which writes one `convergence.record_pass_failed` JSON line to stderr (≤200 char error field; no stack).

### Backward Compatibility

Sessions without `convergence_evidence` can still use legacy `clean_pass_count`; missing counters default to 0. Existing `manual` / `hook_manual` evidence remains valid on disk but invisible to derivation.

### Evidence Integrity Verification

The gate enforcement hook (`workflow-gate-enforcement.mjs`) performs optional integrity verification when evidence arrays are present:

- Sequential `pass_number` values with no gaps
- Sequential timestamps (no time-travel)
- Array length matches highest `pass_number`
- Timing plausibility (minimum 10 seconds between passes)

All integrity issues produce advisory warnings only. The hook never blocks dispatch based on integrity alone -- it falls back to count-only verification on any anomaly or script error (fail-open).

---

## Session State Fields

### Cooperative Layer Fields

Enforcement adds these fields to `phase_checkpoint` in `session.json`:

| Field                 | Type   | Purpose                                                     |
| --------------------- | ------ | ----------------------------------------------------------- |
| `phase_skip_warnings` | Object | Map of predecessor key to skip count                        |
| `enforcement_counter` | Number | Monotonic counter of all enforcement events                 |
| `_counter_checksum`   | Number | XOR checksum for counter integrity verification             |
| `enforcement_level`   | String | Current enforcement level (`off`, `warn-only`, `graduated`) |
| `override_count`      | Number | Number of overrides used this session (cap: 3)              |

### Sub-Stage Tracking

`session.substages_visited` holds the set of challenger sub-stages visited during the current active-work window.

| Field                           | Type                       | Purpose                                                                             |
| ------------------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `substages_visited`             | Object (keyed by phase)    | Maps phase name to array of visited substage short-forms                            |
| `substages_visited.challenging` | String[] (VALID_SUBSTAGES) | Unique set of visited sub-stages (`pre-impl`, `pre-test`, `pre-orch`) |

Populated by `transition-phase <phase> <substage>` when `phase === 'challenging'`. Absent shape (missing top-level) blocks with `dag.substage.skipped`. Malformed shape (non-object top, non-array per-phase, non-string element, out-of-enum element) blocks with `dag.substage.malformed` carrying the specific reason. Legacy bare-`challenging` history entries emit `dag.substage.legacy_visit_ignored` per encountered entry and contribute nothing to the visited set.

### Coercive Layer Fields

The coercive layer reads (but does not write) these session.json fields:

| Field                                          | Purpose                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `active_work.workflow`                         | Determines enforcement rules (workflow type; immutable mid-session) |
| `subagent_tasks.in_flight`                     | Dispatch history (in-flight tasks)                                  |
| `subagent_tasks.completed_this_session`        | Dispatch history (completed tasks)                                  |
| `convergence.code_review.clean_pass_count`     | Code review convergence tracking                                    |
| `convergence.security_review.clean_pass_count` | Security review convergence tracking                                |
| `convergence_evidence.<gate>.passes[]`         | Pass evidence arrays (evidence-based verification)                  |
| `convergence_log_failures.<gate>`              | Per-gate circuit-breaker state for session.log failures             |
| `substages_visited`                            | Challenger sub-stage obligation tracking                            |

---

## Structured Log Contract

The derivation and sub-stage paths emit closed-enum structured log lines to stderr. Each is a single JSON line for ingestion by observability pipelines.

| Event                                | Emitter                         | Payload fields                                                    | Purpose                                             |
| ------------------------------------ | ------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| `convergence.streak.derived`         | `deriveConvergenceFromEvidence` | `gate`, `clean_pass_count`, `iteration_count`                     | Final derivation result per call                    |
| `convergence.legacy_source_rejected` | `deriveConvergenceFromEvidence` | `gate`, `source`, `recordIndex`, `sessionId` (16-char hash)       | Legacy record skipped during tail-walk              |
| `convergence.session_parse_failed`   | `opUpdateConvergence`           | `path`, `error_detail` (≤200 chars)                               | session.json read/parse failure (fail-closed)       |
| `convergence.record_pass_failed`     | `emitRecordPassFailedLog`       | `gate`, `agent_type`, `error` (class + msg ≤200 chars)            | recordPass atomic-write failure                     |
| `dag.substage.admitted`              | `populateSubstageVisited`       | `phase`, `substage`, `session_id` (16-char hash)                  | Valid substage added to visited set                 |
| `dag.substage.skipped`               | `validateSubstages`             | `phase`, `substage`, `session_id` (16-char hash)                  | Required substage missing at obligation check       |
| `dag.substage.legacy_visit_ignored`  | `validateSubstages`             | `session_id` (16-char hash), entry metadata                       | Legacy bare-`challenging` history entry encountered |
| `dag.substage.malformed`             | `validateSubstages`             | `gate`, `observed_type`, `observed_value`, `session_id`, `reason` | `substages_visited` shape violated                  |
| `WORKFLOW_IMMUTABLE`                 | `checkWorkflowImmutable`        | (stderr text)                                                     | Workflow downgrade attempt rejected                 |

Error field formats avoid source bytes, stack traces, or raw file paths beyond truncated filenames. Session IDs are always hashed (first 16 hex chars of SHA-256).

---

## Troubleshooting

| Symptom | Primary action |
| --- | --- |
| Transition blocked | Run `node .claude/scripts/session-checkpoint.mjs get-status`, then complete the missing phase or use `override-skip`. |
| Dispatch blocked | Complete the missing prerequisite, create `.claude/coordination/gate-override.json`, or activate `.claude/coordination/gate-enforcement-disabled`. |
| Session completion blocked | Reproduce with `node .claude/scripts/session-checkpoint.mjs verify`; fix missing dispatches, convergence depth, artifacts, manifest/session drift, or deployment verification. |
| Enforcement degraded to warn-only | `session.json` counter/checksum integrity drift was detected; enforcement self-heals checksum but stays warn-only for the session. |
| Override cap reached | Three cooperative overrides have been used; start new work or escalate to the human operator. |
| Evidence integrity warning | Pass numbers, timestamps, or timing look suspicious; warning is advisory unless another gate fails. |
| `CONVERGENCE_TAIL_WALK_BOUNDED` | Evidence history has at least 200 entries without an eligible streak start; inspect recent `convergence_evidence.<gate>.passes[]`. |
| `CONVERGENCE_SESSION_PARSE_FAILED` | `session.json` is absent/malformed/unreadable; inspect JSON and recover through [ENFORCEMENT-RECOVERY.md](ENFORCEMENT-RECOVERY.md). |
| Circuit breaker degraded mode | Fix session.log write failures; a later successful pass clears degraded mode through `update-circuit-breaker --event success`. |
| `update-convergence` rejects count argument | Use `node .claude/scripts/session-checkpoint.mjs update-convergence <gate>`. Counts are derived. |
| `SESSION_JSON_SYMLINK_REFUSED` | Replace symlinked `session.json` with a regular file. |
| `WORKFLOW_IMMUTABLE` | Complete current work and start new work; mid-session workflow changes are rejected. |
| `SOURCE_FORBIDDEN_VIA_CLI` | `record-pass --source` has no remediation path; only `convergence-pass-recorder.mjs` may call `recordPass()`. |
| Bash command blocked | Use the dedicated CLI or rewrite as statically analyzable read/write intent. Classifier details live in [`bash-intent-classifier.md`](./bash-intent-classifier.md). |

---

## See Also

- [HOOKS.md](HOOKS.md) - Live hook inventory and hook placement reference
- [ENFORCEMENT-RECOVERY.md](ENFORCEMENT-RECOVERY.md) - Operator recovery procedures for convergence/workflow friction
- [bash-intent-classifier.md](bash-intent-classifier.md) - Architecture of the Bash intent classifier that gates protected-file write detection
- [bash-intent-classifier-api.md](bash-intent-classifier-api.md) - Library API reference
- CLAUDE.md, "Workflow Enforcement" section - Prose-level enforcement rules
- `.claude/memory-bank/tech.context.md` - Phase list and validation hooks reference

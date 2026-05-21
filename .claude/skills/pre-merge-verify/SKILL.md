---
name: pre-merge-verify
description: Pre-merge fixture-and-probe gate. Boots a consumer fixture, polls readiness, probes routes filtered by phases=["pre-merge"], tears down. Returns structured pass/fail/skipped with closed-enum reason. Stop-hook gate (NOT a convergence-DAG phase). Self-exempt when no consumer scripts declared.
user-invocable: true
allowed-tools: Read, Grep, Bash, Write
---

# Pre-Merge-Verify Skill

## Required Context

Before beginning work, read these files for project-specific guidelines:

- `.claude/memory-bank/best-practices/spec-authoring.md`
- `.claude/memory-bank/best-practices/code-quality.md`
- `.claude/memory-bank/best-practices/logging.md`
- `.claude/memory-bank/self-answer-protocol.md`

## Purpose

Run the **first gate that asks "does this work in production?"** rather than "does this match the spec?" — a single, bounded, audit-traceable orchestration of consumer-controlled commands against a real fixture-bootable target.

This skill is a **Stop-hook gate** (NOT a convergence-DAG phase). It sits in `.claude/scripts/workflow-stop-enforcement.mjs` parallel to the existing `deployment-verify` block, both contributing to the early-exit conjunction `completion allowed iff !deploymentBlocked && !preMergeBlocked`.

This skill is NOT a replacement for `/test`, `/e2e-test`, `/manual-test`, or `/code-review`. Those gates exist independently. Pre-merge-verify is the boot-and-probe layer — verifying that the running artifact answers an HTTP probe with a 200, against routes the consumer has declared as health-bearing.

## When to Use

Dispatched by the Stop hook when:

1. The active spec group has not declared `pre_merge_verify_skip: true` in its frontmatter.
2. The operator-controlled flag at `.claude/coordination/pre-merge-verify-enforcement-disabled` is NOT set.
3. `session.pre_merge_verify.status` is absent or non-`"passed"`/`"skipped"`.

Manual invocation via `/pre-merge-verify` is also supported (e.g., for diagnostics or vibe-mode override per EDGE-020).

## Consumer Command Contract

Consumers declare three scripts and three optional config fields in `package.json`. The optional fields go at the **package.json TOP LEVEL**, NOT under `scripts`.

```json
{
  "name": "your-service",
  "scripts": {
    "pre-merge-fixture-setup": "node ./scripts/seed-fixture.mjs",
    "pre-merge-boot": "node ./scripts/boot-server.mjs",
    "pre-merge-teardown": "node ./scripts/teardown.mjs"
  },
  "pre_merge_verify_timeout_ms": 60000,
  "pre_merge_readiness_path": "/api/health",
  "pre_merge_verify_port_allowlist": [8080]
}
```

### Scripts

| Script                    | Required | Behavior                                                                                                                                                                                                                                                                                            |
| ------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pre-merge-fixture-setup` | Yes      | Idempotent. Seeds fixtures (DB rows, files, env). Exits 0 on success.                                                                                                                                                                                                                               |
| `pre-merge-boot`          | Yes      | Idempotent at the boot level. Boots the service in a detached process group. MUST emit a JSON line on stdout: `{"url": "http://...", "pid": <int>}`. The runner parses the FIRST matching line. Boot binds to ephemeral port (port=0); the runner validates the resulting OS-assigned port. |
| `pre-merge-teardown`      | Yes      | Idempotent. ALWAYS invoked via try/finally even when steps 1-4 failed. Failure sets `quarantine_until_acknowledged` flag (see Quarantine below).                                                                                                                                                    |

When ALL THREE scripts are absent, the verifier emits SKIP with reason `no_contract_declared` (the **self-exempt path** — the metaclaude-assistant repo itself takes this path).

### Optional config fields

| Field                             | Default    | Constraint                                                                                                                                                                            | Failure reason if invalid                  |
| --------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `pre_merge_verify_timeout_ms`     | 30000      | Integer; max 300000 (5 minutes); validated by Zod at gate-start (TECH-104).                                                                                                           | `config_invalid_timeout`                   |
| `pre_merge_readiness_path`        | `/healthz` | String; readiness probe target; polled with 250ms backoff within a 30s envelope (per DEC-010); each HTTP call has 5s sub-timeout to prevent head-of-line blocking on a stuck request. | `boot_failed_not_ready` (envelope timeout) |
| `pre_merge_verify_port_allowlist` | `[]`       | Array of integers; ports outside ephemeral [49152..65535] rejected unless in allow-list (TECH-102).                                                                                   | `boot_failed_port_static`                  |

## Spec Frontmatter Opt-Out

Specs may opt out of pre-merge-verify by declaring in frontmatter:

```yaml
pre_merge_verify_skip: true
pre_merge_verify_skip_rationale: 'no fixture-bootable target for this CLI-only project'
```

Per DEC-003, `pre_merge_verify_skip_rationale` is **FREE-TEXT** (≥15 chars minimum) — NOT a closed enum like `e2e_skip_rationale`. Pre-merge-verify skip reasons are project-specific and don't fit a small fixed taxonomy. Examples:

- `"no fixture-bootable target for this CLI-only project"`
- `"pre-merge guards already provided by external CI"`
- `"library project — verification belongs to consumer projects"`

The spec frontmatter check rejects specs with `pre_merge_verify_skip: true` AND missing or <15-char rationale.

## NFR-26 Dispatch Ordering

At every dispatch, the runner runs these seven ordered checks. First-fail short-circuits.

1. **Vibe-mode short-circuit** (EDGE-003) — if `session.active_work` is absent, emit SKIP with reason `vibe_mode_no_active_work` (unless invoked manually via `/pre-merge-verify` per EDGE-020 override; manual vibe-mode dispatch runs the full pipeline and emits a `dispatch_mode: manual_vibe` audit tag).
2. **Self-exempt detection** (NFR-9) — if `package.json` lacks ALL three pre-merge scripts, emit SKIP with reason `no_contract_declared`. The metaclaude-assistant repo itself takes this path.
3. **Quarantine-flag check** (NFR-25) — if `session.pre_merge_verify.quarantine_until_acknowledged === true`, HALT immediately with operator-acknowledge prompt: "pre-merge-verify quarantined due to prior teardown failure. Inspect teardown-orphan state, then run `node .claude/scripts/session-checkpoint.mjs clear-pre-merge-quarantine` to acknowledge."
4. **Lock acquisition** (NFR-24+EDGE-016+TECH-103) — `O_CREAT | O_EXCL` open of `.claude/coordination/pre-merge-verify.lock` with contents `{pid, hostname, acquired_at}`. 30s acquisition timeout emits `pre_merge_verify_lock_timeout`. Staleness detection: `kill(pid, 0) === ESRCH` OR `acquired_at` older than 2× max step timeout (default 60s) reclaims the lock.
5. **Audit-chain monotonicity check** (NFR-22+SEC-107) — assert `session.audit.next_seq` (lazily initialized to `{next_seq: 0}` if absent per DEC-009). Non-monotonic detection emits `audit_chain_tamper_detected`.
6. **Resume-from-incomplete check** (NFR-23) — if `session.pre_merge_verify` exists, lacks `status`, AND no quarantine flag, run `pre-merge-teardown` BEFORE step 1 to clean leaked state. Max-resume-attempts: 3; if pre-step-1 teardown fails 3× across consecutive sessions, set quarantine flag and HALT permanently.
7. **Enforcement-flag read** (EDGE-004+EDGE-017) — read `.claude/coordination/pre-merge-verify-enforcement-disabled` once and cache state for the run. Mid-run flag flips do NOT affect the in-flight gate. Flag re-read happens per dispatch, NOT cached across dispatches.

## Five-Step Pipeline

After NFR-26 completes and the timeout-validation Zod validator passes (TECH-104), the runner runs five ordered steps under per-step timeout. Each step emits two audit-chain entries (`*_start`, `*_complete`):

1. **Setup** — `execFile pre-merge-fixture-setup --ignore-scripts`.
2. **Boot** — `execFile pre-merge-boot` in a detached process group. Parse FIRST stdout JSON line `{"url": "http://...", "pid": <int>}`. Validate URL via the NEW `validatePreMergeUrl` helper.
3. **Readiness** — Single-envelope poll of `pre_merge_readiness_path` with 250ms backoff between attempts; each HTTP call gets a 5s sub-timeout (per DEC-010). Envelope timeout emits `boot_failed_not_ready`.
4. **Verify** — `runVerifyDeploy({endpointUrl, phase_filter: "pre-merge"})`. Routes filtered to those whose `phases` array includes `"pre-merge"`. CODE_DEFECT bucket on FAIL.
5. **Teardown** — `execFile pre-merge-teardown` in try/finally. ALWAYS runs even when steps 1-4 failed. Teardown failure sets `quarantine_until_acknowledged: true` (NFR-25) and emits ADVISORY-bucket reason.

The verifier writes the final result via:

```bash
node .claude/scripts/session-checkpoint.mjs record-pre-merge-verify-result <sg-id> \
  --status <passed|failed|skipped> \
  --reason <enum> \
  [--evidence <json>] \
  [--audit-seq <int>] \
  [--cumulative-ms <int>]
```

`session-checkpoint.mjs` is the sole writer for `session.pre_merge_verify` (NFR-2).

## Operator Enforcement Flag

The operator can disable pre-merge-verify enforcement for a session by placing a sentinel file:

```bash
# Operator-only — agents are blocked from writing this path by workflow-file-protection.mjs.
# The operator must use a signed commit (per org-context.md line 94) to create or remove the file.
git add .claude/coordination/pre-merge-verify-enforcement-disabled
git commit -S -m "operator: disable pre-merge-verify for one session"
```

When the sentinel exists, the verifier still runs (audit signal is preserved), but its outcome does NOT block completion. `preMergeBlocked` is forced to `false`.

Per AC-11.4 / EDGE-004: the flag is read once per gate dispatch and cached for the run. Per AC-11.5 / EDGE-017: the flag is re-read on each new dispatch (NOT cached across dispatches). Per AC-11.6 / EC-15: the audit chain captures both the dispatch-time flag state and any flag transition during the gate run.

## Quarantine Flow

When `pre-merge-teardown` fails:

1. The runner persists `session.pre_merge_verify.quarantine_until_acknowledged: true`.
2. Audit chain logs the quarantine-set event.
3. Subsequent gate dispatches detect the flag at NFR-26 step 3 and HALT immediately with the structured operator-acknowledge prompt.
4. Operator inspects the leaked state (orphan processes, stale fixtures, port conflicts), manually resolves it, then runs:

```bash
node .claude/scripts/session-checkpoint.mjs clear-pre-merge-quarantine <sg-id> \
  --reason "describe how the leaked state was resolved"
```

5. Quarantine auto-clears on subsequent successful teardown when the operator manually resolves the underlying issue and re-dispatches.

When `pre-merge-teardown` is NOT declared (per EC-3 / EDGE-022), the gate emits `teardown_skipped` (advisory) AND notes "no quarantine possible when teardown not declared" — the quarantine flag depends on teardown-failure detection.

## Audit-Chain Integrity

`session.audit.next_seq` is the monotonic sequence counter for pre-merge-verify audit-chain entries. Per DEC-009, it is OPTIONAL in the JSON-Schema (default `{next_seq: 0}` on read); pre-existing pre-Item-B sessions without the field are migrated lazily on first `recordAuditEvent` call — NO explicit migration step is required.

Per DEC-006: the runner at `.claude/scripts/lib/pre-merge-verify.mjs` imports `recordAuditEvent` (or equivalent named export) IN-PROCESS from `session-checkpoint.mjs` and calls it for each pipeline event (10 events on a happy-path run). It does NOT spawn `execFileSync` against the CLI 10x per pipeline run; that would cost 5-30s on slow consumer machines and violate NFR-19's 5-minute operator-experience target. In-process emission keeps cumulative overhead <1s. Sole-writer invariant is preserved because runner + CLI run in the same Node process.

On `audit_chain_tamper_detected`, the gate persists `status: "failed", reason: "audit_chain_tamper_detected"`, blocks completion, and emits an operator-actionable error directing the operator to:

```bash
node .claude/scripts/session-checkpoint.mjs repair-audit-chain <sg-id>
```

## Failure-Reason Vocabulary (22-value closed enum)

See the `pre-merge-verifier.md` agent doc for the full enum and bucket mapping (REQ-007 / NFR-12). Future reasons require PRD amendment per the closed-enum stability discipline.

## V1 Falsifiable Failure Criterion

Per BIZ-008: at **60 days post-ship of Item B**, if the total count of consumer projects that have declared `pre-merge-fixture-setup` in `.claude/projects.json` is exactly zero, **v1 is FAILED** and the gate is **REMOVED via amendment**.

The removal procedure (per BIZ-013):

1. Author an amendment PRD documenting the failed adoption metric.
2. Delete the Stop-hook block in `.claude/scripts/workflow-stop-enforcement.mjs`.
3. Mark the agent + skill as `deprecated: true` in `.claude/metaclaude-registry.json`.
4. Leave the `phases` field on `RouteSchema` (no schema rollback; fields are append-only).
5. Leave the `infra_blocked` enum on `manual_test_result.result` (Item A's contribution).
6. Update `CLAUDE.md` to remove the pre-merge-verify entry from the Stop-hook Gates sub-list.
7. Sync registry hashes via `node .claude/scripts/compute-hashes.mjs --update`.

The metaclaude-assistant repo itself takes the self-exempt path (no `pre-merge-fixture-setup` declared); per BIZ-008's falsifiable criterion, adoption beyond the contract author is the success metric.

## Stop-hook Composition

Per AC-6.4 + NFR-8 truth table: the new `pre-merge-verify` Stop-hook block sits AFTER the existing `deployment-verification` block at `.claude/scripts/workflow-stop-enforcement.mjs:1489-1564` (grep-anchor: `// Step 7.8: Deployment verification gate`). Both blocks contribute to the early-exit conjunction:

```
completion allowed iff !deploymentBlocked && !preMergeBlocked
```

When BOTH gates fail concurrently, the Stop-hook output names BOTH structured reasons in the operator-facing message — neither short-circuits the other (per AC-6.6).

Per DEC-008: each block has its own self-contained try/catch boundary. Structural errors in pre-merge-verify block fail-open WITHIN that block (`preMergeBlocked` stays `false` on caught structural exception) and DO NOT affect deployment-verify processing (and vice versa).

## INFRA_BLOCKED Contract Reference

INFRA_BLOCKED-bucket emissions reuse the contract first ground-truthed by Item A (`sg-manual-tester-infra-blocked-20260508`, committed at `c018147`). Identical halt-and-surface semantics: NO retry, terminal regardless of `runtime_validation_required`, evidence-before-halt audit ordering, ≥2-emission counter triggering an additional Stop-hook block-reason `pre_merge_verify_human_confirmation_required` (parallel to Item A's `infra_blocked_human_confirmation_required`).

The verifier participates in Item A's existing `session.active_work.dispatch_infra_blocked_count` counter map; deletion at `opTransitionPhase` on `documenting → !documenting` transition (per Item A DEC-007/DEC-008) is unchanged. Implementer MUST NOT introduce a parallel counter.

## Communication Style (skill ↔ agent)

Use Caveman-lite: direct, full-sentence, evidence-complete. Hedge only when uncertainty matters. Keep exact terms and code unchanged.

- Always reference absolute paths.
- Surface the closed-enum reason verbatim in audit-chain entries; do not paraphrase.
- For clear communication, avoid emojis.

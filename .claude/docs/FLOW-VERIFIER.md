# Flow Verifier

Cross-boundary wiring verification for independently-created systems. Catches missing imports, unregistered routes, mismatched event names, wrong config references, disconnected handlers, and missing middleware -- the six categories of wiring bugs that are the leading source of integration failures in parallel agent development.

---

## Overview

When subagents produce code in parallel, the interfaces between their outputs are the highest-risk failure surface. Today, spec-time checks (interface-investigator) catch contract inconsistencies and E2E tests catch runtime failures, but nothing systematically verifies that the **implementation graph** -- the actual imports, registrations, event subscriptions, and data flows -- is properly wired together.

The flow verifier fills this gap with continuous, stage-aware verification across the entire lifecycle: from PRD through implementation.

**Architecture**: Two-layer split (following the doc-audit pattern):

1. **`flow-verify-checks.mjs`** -- standalone script run by the main agent (requires Bash). Performs trace parsing, git-based file discovery, regex source scanning, and outputs structured JSON.
2. **`flow-verifier` agent** -- read-only agent (tools: Read, Glob, Grep). Consumes pre-computed results, evaluates carry-forward, produces structured findings.

---

## Quick Start

```bash
# Impl-verify gate (most common -- after implementation, before unifier)
node .claude/scripts/flow-verify-checks.mjs --sg <spec-group-id> --stage impl-verify
# Then dispatch: /flow-verify --stage impl-verify --sg <spec-group-id>

# PRD review (5th parallel critic during PRD critique loop)
/flow-verify --stage prd-review --prd <prd-path>

# Spec review (parallel with interface-investigator)
/flow-verify --stage spec-review --sg <spec-group-id>

# Post-impl coverage report (after unifier, before code review)
node .claude/scripts/flow-verify-checks.mjs --sg <spec-group-id> --stage post-impl
# Then dispatch: /flow-verify --stage post-impl --sg <spec-group-id>
```

---

## Stage Modes

| Stage         | When                                     | Runs With              | Pre-Computation | Key Output                                           |
| ------------- | ---------------------------------------- | ---------------------- | --------------- | ---------------------------------------------------- |
| `prd-review`  | PRD Phase 2 critique loop                | 4 existing PRD critics | No              | Findings on missing flow descriptions in PRD         |
| `spec-review` | Investigation convergence loop           | Interface-investigator | No              | Findings on integration interfaces and contracts     |
| `impl-verify` | After all ACs implemented (serial gate)  | None (standalone)      | Yes             | Gate decision: block / warn / pass                   |
| `post-impl`   | After unifier passes, before code review | None (standalone)      | Yes             | Coverage report, wiring diagrams, flow-coverage.yaml |

**Pre-computation**: For `impl-verify` and `post-impl`, the orchestrating agent runs `flow-verify-checks.mjs` before dispatching the agent. The script outputs `.flow-verify-precomputed.json` into the spec group directory.

---

## Wiring Bug Taxonomy

Six categories define the verification scope:

| Category               | Description                                                   | Example                                                              |
| ---------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `missing-import`       | Component does not import or invoke its dependency            | Service A calls `authService.verify()` but never imports it          |
| `unregistered-route`   | Endpoint defined but not mounted in router                    | `loginHandler` exists but is not registered in `server.ts`           |
| `mismatched-event`     | Publisher and consumer use different event strings            | Publisher emits `"user.created"`, subscriber listens `"userCreated"` |
| `wrong-config`         | Component references different config function than its peers | Module A uses `getDbConfig()`, Module B uses `getDatabaseConfig()`   |
| `disconnected-handler` | UI element has no event binding or callback                   | Button rendered but `onClick` handler is undefined                   |
| `missing-middleware`   | Request path skips required middleware                        | Auth-protected route missing the auth middleware mount               |

---

## Gate Output (impl-verify)

The impl-verify stage produces a gate decision that controls workflow progression:

| Decision  | Condition                                          | Effect                                           |
| --------- | -------------------------------------------------- | ------------------------------------------------ |
| **block** | Any Critical finding                               | Workflow halts until resolved or human overrides |
| **warn**  | No Critical, but High findings or partial coverage | Proceeds with human acknowledgment               |
| **pass**  | Only Medium/Low findings with full coverage        | Proceeds directly to unifier                     |

**Partial coverage rule**: When trace data is incomplete (stale traces, untraced files, fallback caps exceeded), the gate is capped at `warn` regardless of finding severity. This does not override `block`.

**Override**: When blocked, a human may override via `.claude/coordination/gate-override.json`:

```json
{
  "overrides": [
    {
      "gate": "flow-verify",
      "session_id": "<current-session>",
      "timestamp": "<ISO timestamp>",
      "rationale": "Reviewed FLOW-IMPL-001, determined false positive because..."
    }
  ]
}
```

---

## Carry-Forward

Findings persist across stages via `.claude/specs/groups/<sg>/flow-findings.json`:

- Each stage appends its findings to the file
- Later stages read prior findings for context
- **Severity elevation**: A gap that persists from an earlier stage is elevated one severity level per stage transition (Low -> Medium -> High -> Critical). Critical is the ceiling.
- **Re-run semantics**: When a stage re-runs during a convergence loop, it replaces its own prior findings (keyed by stage + finding_id) while preserving other stages' findings.
- **Single writer**: Only the flow-verifier agent writes to this file.
- **Graceful degradation**: Missing or malformed carry-forward file triggers fresh analysis, not failure.

---

## Workflow Integration

### oneoff-spec Workflow

```
PRD -> prd-review (5th critic) ->
  Spec -> spec-review (with investigator) ->
    Implement -> impl-verify (gate) -> Unifier ->
      post-impl (coverage report) -> Code Review -> ...
```

For large oneoff-spec work with internal slices, run the same stages against the full `spec.md`. If trace data is incomplete, the verifier uses Grep/Glob fallback (`coverage: "partial"`).

Flow verifier is not dispatched for oneoff-vibe workflows.

---

## Practice 4.5 Migration

The flow verifier **subsumes** Practice 4.5's four integration checks. The mapping:

| Practice 4.5 Check            | Flow Verifier Category | Verification                                              |
| ----------------------------- | ---------------------- | --------------------------------------------------------- |
| Route registration            | `unregistered-route`   | Spec-declared endpoints have corresponding router mounts  |
| Event name alignment          | `mismatched-event`     | Publisher event strings match subscriber event strings    |
| Config function consistency   | `wrong-config`         | Same service references use same config function          |
| Assumption conflict detection | `missing-import`       | No contradictory assumptions about same integration point |

Practice 4.5 prose in CLAUDE.md references the flow verifier as its implementation.

---

## Contracts

Four contracts define the data exchange formats:

| Contract                 | Entity                   | Required Shape                                                                                                                                     |
| ------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract-flow-finding`  | `FlowFinding`            | `finding_id`, `category`, `severity`, `flow_type`, `source`, `target`, `integration_point`, `evidence`, `recommendation`, `stage`, `confidence`   |
| `contract-gate-output`   | `FlowVerifierGateOutput` | `status`, severity counts, `findings`, `coverage`, `unchecked_files`                                                                               |
| `contract-carry-forward` | `CarryForwardEntry`      | `finding_id`, `severity`, `summary`, `stage`, `pass_number`, `integration_point`, `status`, `superseded_by`, `written_by`                         |
| `contract-flow-coverage` | `FlowCoverageReport`     | `doc_type`, `spec_group`, `timestamp`, `integration_points`, `verified_count`, `gap_count`, `coverage_percentage`, `gaps`                         |

Enums: `status` is `pass | warn | block`; `coverage` is `full | partial`; finding severity is `Critical | High | Medium | Low`; stages are `prd-review | spec-review | impl-verify | post-impl`; finding categories are the six taxonomy values above.

---

## Configuration and Artifacts

| Artifact               | Path                                                      | Written By               |
| ---------------------- | --------------------------------------------------------- | ------------------------ |
| Pre-computed analysis  | `.claude/specs/groups/<sg>/.flow-verify-precomputed.json` | `flow-verify-checks.mjs` |
| Carry-forward findings | `.claude/specs/groups/<sg>/flow-findings.json`            | `flow-verifier` agent    |
| Flow coverage report   | `.claude/docs/structured/flows/flow-coverage.yaml`        | `flow-verifier` agent    |
| Wiring diagram         | `.claude/docs/structured/generated/flow-wiring-<sg>.mmd`  | `flow-verifier` agent    |

### Script Options

```
node .claude/scripts/flow-verify-checks.mjs
  --sg <id>                  Spec group ID (required)
  --stage <stage>            prd-review | spec-review | impl-verify | post-impl
  --scope <scope>            full (default) | workstream | post-merge
  --workstream <ws-id>       Workstream ID (for per-workstream scoping)
  --project-root <path>      Override project root
```

### Fallback Behavior

When trace data is unavailable (missing modules, stale traces), the script falls back to Grep/Glob-based source analysis, capped at 500 files and 120 seconds. Results are returned with `coverage: "partial"` and an `unchecked_files` array.

---

## Diff-Scope Mode

Scoping flow-verification to files changed in the current branch diff. Applies at `impl-verify` and `post-impl` stages only; `prd-review` and `spec-review` always run full-scope. Extends existing scope-mode parameterization at `flow-verify-checks.mjs:94, 1459`. Closes the `38 out-of-scope findings on pure-refactor diffs` evidence pattern (REQ-006 / SC-6).

### Parameters

| Param           | Values                                  | Default                                                               | Stage Applicability                           |
| --------------- | --------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| `scope`         | `"full"` \| `"diff"`                    | `"full"` at prd-review/spec-review; `"diff"` at impl-verify/post-impl | `"diff"` rejected at prd-review / spec-review |
| `diff_base`     | git ref (branch / SHA)                  | `<branch-base>`                                                       | All diff-scope dispatches                     |
| `fallback_enum` | `"none"` \| `"head-1"` \| `"full-repo"` | recorded (not supplied)                                               | Output-only; records actual fallback applied  |

### Stage Mapping

| Stage         | Default `scope` | `scope: "diff"` Accepted? | Carry-Forward Re-Evaluation |
| ------------- | --------------- | ------------------------- | --------------------------- |
| `prd-review`  | `full`          | No (rejected)             | N/A (first stage)           |
| `spec-review` | `full`          | No (rejected)             | Yes                         |
| `impl-verify` | `diff`          | Yes                       | Yes (regardless of scope)   |
| `post-impl`   | `diff`          | Yes                       | Yes (regardless of scope)   |

### Carry-Forward Rule

Findings surfaced at earlier stages (`prd-review`, `spec-review`) are **always re-evaluated** at impl-verify / post-impl, even when `scope: "diff"`. Diff-scope filters _new_ findings to affected modules; it does not suppress persisted prior-stage findings. Severity elevation rules (Low -> Medium -> High -> Critical, one level per stage) apply unchanged.

### Empty-Diff Trivial-Pass

| Condition                                              | Outcome                                                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `git diff --name-only <base>..HEAD` returns zero files | Trivial-pass; structured log entry `{ scope: "diff", diff_base, changed_files: 0, outcome: "trivial-pass" }`; NOT a failure |
| Non-empty diff, no affected modules                    | Trivial-pass (diff outside traced fileGlobs); structured log                                                                |

### New-Symbol Degradation (NFR-10 Gate Condition)

When the diff introduces **new boundary-crossing symbols** (new exports in cross-module surfaces, new route registrations, new event publishers/subscribers), the flow-verifier degrades from diff-scope to **full-scope regardless of `scope` param**. This preserves coverage on genuinely new integration surfaces. Output records `fallback: "new-symbol-degradation"` and `actual_scope: "full"`.

### Fallback Enum

When `git diff <base>..HEAD` fails (missing ancestor, single-commit history, post-reset), the following fallbacks apply in order:

| Fallback    | Trigger                                   | Logged As     |
| ----------- | ----------------------------------------- | ------------- |
| `none`      | Diff resolved cleanly against base        | `"none"`      |
| `head-1`    | `<base>` unresolvable; `HEAD~1` available | `"head-1"`    |
| `full-repo` | `HEAD~1` unavailable; fallback to full    | `"full-repo"` |

Fallbacks are recorded in the structured log (`.claude/specs/groups/<sg>/flow-findings.json` `fallback_log` field) and returned in the agent output.

### Example Dispatch

```bash
# Pre-computation at impl-verify with diff scope
node .claude/scripts/flow-verify-checks.mjs \
  --sg <spec-group-id> \
  --stage impl-verify \
  --scope diff \
  --diff-base main

# Agent dispatch consumes pre-computed result
/flow-verify --stage impl-verify --sg <spec-group-id> --scope diff
```

Helper library: `.claude/scripts/lib/flow-verify-diff-scope.mjs` exports `resolveDiffScope({ base, stage })` returning `{ scope, changed_files, affected_modules, fallback }`. Consumers in `flow-verify-checks.mjs` filter findings to `affected_modules` before emitting. Module resolution uses `trace.config.json` `fileGlobs` (see TRACES.md § Consumer: Flow-Verifier Diff-Scope).

---

## See Also

- `.claude/agents/flow-verifier.md` -- Agent definition
- `.claude/skills/flow-verify/SKILL.md` -- Skill file with full parameter reference
- `.claude/scripts/flow-verify-checks.mjs` -- Pre-computation script
- `.claude/scripts/lib/flow-verify-diff-scope.mjs` -- Diff-scope resolver helper
- `.claude/prds/flow-verifier/prd.md` -- PRD with motivation and success metrics
- `.claude/docs/TRACES.md` -- Trace system (fileGlobs -> module mapping consumed by diff-scope)
- `.claude/docs/DOC-AUDIT.md` -- Doc-audit system (analogous two-layer architecture)

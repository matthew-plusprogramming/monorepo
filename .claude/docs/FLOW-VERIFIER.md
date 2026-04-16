# Flow Verifier

Cross-boundary wiring verification for independently-created systems. Catches missing imports, unregistered routes, mismatched event names, wrong config references, disconnected handlers, and missing middleware -- the six categories of wiring bugs that are the leading source of integration failures in parallel agent development.

---

## Overview

When 21 subagents produce code in parallel across worktrees, the seams between their outputs are the highest-risk failure surface. Today, spec-time checks (interface-investigator) catch contract inconsistencies and E2E tests catch runtime failures, but nothing systematically verifies that the **implementation graph** -- the actual imports, registrations, event subscriptions, and data flows -- is properly wired together.

The flow verifier fills this gap with continuous, stage-aware verification across the entire lifecycle: from PRD through implementation.

**Architecture**: Two-layer split (following the doc-audit pattern):

1. **`flow-verify-checks.mjs`** -- standalone script run by the orchestrator (requires Bash). Performs trace parsing, git-based file discovery, regex source scanning, and outputs structured JSON.
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

### orchestrator Workflow

Same as oneoff-spec, plus per-workstream and post-merge phases:

1. **Per-workstream**: After each workstream completes, `impl-verify` runs scoped to that workstream. Cross-workstream references use Grep/Glob fallback (`coverage: "partial"`).
2. **Post-merge**: After all workstreams merge, `impl-verify` runs against the combined codebase with full trace data. Post-merge findings supersede per-workstream findings for the same integration point.

### NOT dispatched for oneoff-vibe workflows.

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

| Contract                 | Entity                   | Purpose                                                  |
| ------------------------ | ------------------------ | -------------------------------------------------------- |
| `contract-flow-finding`  | `FlowFinding`            | Single wiring finding (ID, category, severity, evidence) |
| `contract-gate-output`   | `FlowVerifierGateOutput` | Impl-verify gate result (status, counts, coverage)       |
| `contract-carry-forward` | `CarryForwardEntry`      | Persistent finding entry across stages                   |
| `contract-flow-coverage` | `FlowCoverageReport`     | Post-impl coverage summary for structured docs           |

Full contract definitions are in the spec at `.claude/specs/groups/sg-flow-verifier/spec.md`.

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

## See Also

- `.claude/agents/flow-verifier.md` -- Agent definition
- `.claude/skills/flow-verify/SKILL.md` -- Skill file with full parameter reference
- `.claude/scripts/flow-verify-checks.mjs` -- Pre-computation script
- `.claude/specs/groups/sg-flow-verifier/spec.md` -- Full specification (40 ACs, contracts)
- `.claude/prds/flow-verifier/prd.md` -- PRD with motivation and success metrics
- `.claude/docs/DOC-AUDIT.md` -- Doc-audit system (analogous two-layer architecture)

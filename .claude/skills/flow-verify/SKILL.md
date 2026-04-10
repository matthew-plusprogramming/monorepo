---
name: flow-verify
description: Verify cross-boundary wiring correctness across independently-created systems. Catches missing imports, unregistered routes, mismatched event names, wrong config references, disconnected handlers, and missing middleware.
agent: flow-verifier
user-invocable: true
allowed-tools: Read, Glob, Grep
---

# Flow Verify Skill

## Purpose

Verify that cross-boundary wiring is correct across all independently-created systems in a spec group. Catches six categories of wiring bugs: missing imports, unregistered routes, mismatched event names, wrong config references, disconnected handlers, and missing middleware.

Uses a two-layer architecture (following the doc-audit pattern):

1. **`flow-verify-checks.mjs`** (standalone script): Pre-computes trace-based wiring analysis, run by the orchestrating agent before dispatch
2. **`flow-verifier` agent** (read-only): Consumes pre-computed results, evaluates carry-forward, produces structured findings

## Usage

```
/flow-verify --stage impl-verify --sg <spec-group-id>        # Standalone gate after implementation
/flow-verify --stage prd-review --prd <prd-path>              # 5th parallel PRD critic
/flow-verify --stage spec-review --sg <spec-group-id>         # Parallel with interface-investigator
/flow-verify --stage post-impl --sg <spec-group-id>           # Comprehensive coverage report
```

## Parameters

| Parameter    | Type   | Required | Default | Description                                                         |
| ------------ | ------ | -------- | ------- | ------------------------------------------------------------------- |
| `stage`      | string | Yes      | --      | Stage mode: `prd-review`, `spec-review`, `impl-verify`, `post-impl` |
| `sg`         | string | Yes\*    | --      | Spec group ID (required for all stages except prd-review)           |
| `prd`        | string | No       | --      | PRD file path (used for prd-review stage)                           |
| `scope`      | string | No       | `full`  | Verification scope: `full`, `workstream`, `post-merge`              |
| `workstream` | string | No       | --      | Workstream ID (for per-workstream scoping in orchestrator)          |

## Workflow Applicability

- **oneoff-spec**: All four stages applicable
- **orchestrator**: All four stages applicable, plus per-workstream and post-merge phases
- **oneoff-vibe**: NOT dispatched (skip entirely)

## Pre-Flight Challenge

Before beginning flow verification work, address these operational feasibility questions:

1. Does `trace.config.json` exist for trace-based wiring analysis? (If not, Grep/Glob fallback will be used)
2. Are low-level traces available and fresh for modified modules? (Stale traces trigger fallback)
3. Does the spec group have a defined scope boundary for in-scope flow identification?
4. Is the carry-forward file (`flow-findings.json`) accessible? (Missing is normal for first stage)

If any question cannot be answered from available context, surface it as a finding -- do not skip.

## Execution Flow

### Stage: impl-verify (Standalone Gate)

This is the highest-value stage and the most critical for catching wiring bugs.

#### Step 1: Pre-Computation (Orchestrator runs this)

```bash
node .claude/scripts/flow-verify-checks.mjs --sg <spec-group-id> --stage impl-verify
```

This produces `.claude/specs/groups/<sg>/.flow-verify-precomputed.json` with:

- Trace-based wiring analysis (imports, exports, dependencies)
- Six wiring check results (routes, events, config, imports, handlers, middleware)
- Coverage indicator (full/partial)
- Unchecked files array (when caps exceeded)

#### Step 2: Agent Dispatch

Dispatch the flow-verifier agent with stage `impl-verify`, providing the pre-computed results path and spec group ID.

#### Step 3: Gate Decision

The agent returns a gate output:

- **block**: Any Critical finding present. Workflow halts until resolved or human overrides via `gate-override.json`
- **warn**: No Critical but High findings present, OR coverage is partial. Requires human acknowledgment
- **pass**: Only Medium/Low findings with full coverage. Workflow proceeds to unifier

### Stage: prd-review (5th Parallel Critic)

Dispatched during `/prd` Phase 2 (critique loop) in parallel with the four existing PRD critics. Checks whether the PRD describes all cross-boundary connections, data handoffs, and event flows.

No pre-computation needed -- the agent reads the PRD directly.

### Stage: spec-review (Parallel with Investigator)

Dispatched during `/investigate` convergence loop in parallel with the interface-investigator. Checks spec integration interfaces, subgraph completeness, and event/data contract coverage.

No pre-computation needed -- the agent reads spec artifacts directly.

Findings feed into the investigation convergence loop and are deduplicated with investigator findings by `integration_point` key.

### Stage: post-impl (Comprehensive Report)

Dispatched after unifier passes, before code review. Produces:

- Comprehensive flow coverage report (flow-coverage.yaml)
- Wiring diagrams (Mermaid .mmd files)
- Summary of fully verified flows, flows with gaps, and undocumented flows

Pre-computation required (same as impl-verify).

## Orchestrator Workflow

In orchestrator workflows with multiple workstreams, impl-verify runs in two phases:

1. **Per-workstream**: After each workstream completes, scoped to that workstream's file set
   ```bash
   node .claude/scripts/flow-verify-checks.mjs --sg <sg-id> --stage impl-verify --scope workstream --workstream <ws-id>
   ```
2. **Post-merge**: After all workstreams merge, against combined codebase
   ```bash
   node .claude/scripts/flow-verify-checks.mjs --sg <sg-id> --stage impl-verify --scope post-merge
   ```

Post-merge findings supersede per-workstream findings for the same integration point.

## Carry-Forward Mechanism

Findings carry forward between stages via `.claude/specs/groups/<sg>/flow-findings.json`:

- Each stage appends its findings to the carry-forward file
- Later stages read prior findings for context
- Persisting gaps are elevated by one severity level per stage transition (cap: Critical)
- Re-runs during convergence loops replace (not append) prior findings for the same stage
- Only the flow-verifier agent writes to this file (single writer, multiple readers)

## Gate Override

When impl-verify returns `block`, the human may override using:

```json
// .claude/coordination/gate-override.json
{
  "overrides": [
    {
      "gate": "flow-verify",
      "session_id": "<current-session>",
      "timestamp": "<ISO timestamp>",
      "rationale": "Reviewed Critical finding FLOW-IMPL-001, determined false positive due to..."
    }
  ]
}
```

Overridden findings are marked `status: "human-overridden"` in the carry-forward file.

## Output Artifacts

| Artifact               | Path                                                      | Stage                  |
| ---------------------- | --------------------------------------------------------- | ---------------------- |
| Pre-computed analysis  | `.claude/specs/groups/<sg>/.flow-verify-precomputed.json` | impl-verify, post-impl |
| Carry-forward findings | `.claude/specs/groups/<sg>/flow-findings.json`            | All stages             |
| Flow coverage report   | `.claude/docs/structured/flows/flow-coverage.yaml`        | post-impl              |
| Wiring diagram         | `.claude/docs/structured/generated/flow-wiring-<sg>.mmd`  | post-impl              |

## Integration with Other Skills

- **Before**: `/implement` (all ACs implemented), `/investigate` (spec-review stage)
- **After**: `/unify` (impl-verify gate passes), `/code-review` (post-impl report available)
- **Parallel with**: PRD critics (prd-review), interface-investigator (spec-review)
- **Replaces**: Practice 4.5 inline integration checks (subsumed by impl-verify stage)

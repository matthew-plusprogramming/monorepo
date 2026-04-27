# Routing Heuristic — Raised Orchestrator Bar

> **Canonical reference** for the `/route` skill's Complexity Heuristics. The `/route` SKILL.md
> cross-references this document for the full multi-domain criteria list and the migration
> guidance for in-flight orchestrator work.

## Purpose

The `/route` skill decides which workflow (`oneoff-vibe`, `oneoff-spec`, `orchestrator`, `refactor`, `journal-only`) a user request should take. The decision matters: orchestrator workflows burn ~2-4M tokens and ~4-5h wall-clock per workstream (per the ws-2 and ws-3 retrospectives of the pipeline-efficiency PRD), while oneoff-spec workflows run in a fraction of that. Routing a medium-complexity task to orchestrator pays the full orchestration tax (worktree setup, parallel batches, convergence dispatches, cross-workstream integration) without commensurate benefit.

This document defines the current **raised orchestrator bar** and the multi-domain evidence requirement for `/route`.

## TL;DR

| Workflow       | When                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `oneoff-vibe`  | Truly trivial changes (typo fix, missing import) OR explicit user override ("just do it", "skip spec")          |
| `refactor`     | Explicit behavior-preserving refactor — no feature or behavior change                                           |
| `journal-only` | Documenting completed work, decisions, investigations                                                           |
| `orchestrator` | **Raised bar**: 10+ atomic specs AND ≥2 multi-domain criteria (with evidence) AND tight parallelization benefit |
| `oneoff-spec`  | **DEFAULT** — everything else                                                                                   |

**Key change from the prior heuristic**: the orchestrator bar moved from "5+ files, 4+ hours" (triggered on almost every feature) to the three-condition gate above. Most medium-complexity work that formerly routed to orchestrator now routes to oneoff-spec.

## The Three-Condition Gate

`/route` recommends `workflow: orchestrator` **only when all three are true**.

### Condition 1 — 10+ anticipated atomic specs

If you cannot plausibly enumerate ≥10 atomic units of work (each ~100-line spec, each with its own ACs and test plan), do not route to orchestrator.

- Below ~10 atomic specs, the fixed orchestration overhead (worktree setup, cross-workstream convergence, facilitator coordination) dominates the per-spec benefit.
- Practical test: can you draft a workstream table with ≥3 workstreams, each holding ≥3 atomic specs? If yes, condition 1 is met. If not, stay in oneoff-spec.

### Condition 2 — Genuine multi-domain integration (≥2 criteria)

Name **at least two distinct criteria** from the canonical list below, each with a concrete evidence anchor.

**Canonical multi-domain criteria**:

1. **3+ services** — the work touches three or more separately-deployed services. Evidence: list the specific services (e.g., "websocket-server, auth-service, notification-service").
2. **Distinct test surfaces** — the work requires independently-operated test infrastructures (e.g., unit tests + integration tests + E2E tests + load tests, each with separate fixtures/harnesses). Evidence: list the test surfaces.
3. **Independent contracts** — the work defines or modifies ≥2 wire protocols / shared schemas / API contracts that have separate ownership or lifecycles. Evidence: list the contracts.
4. **Cross-runtime boundaries** — the work spans ≥2 runtimes (browser + Node, browser + server, Node + worker threads, native + wasm, etc.). Evidence: name the runtimes.
5. **Independently-releasable components** — the work produces ≥2 components that ship on separate release cycles (e.g., multi-package monorepo, independently-versioned artifacts). Evidence: name the components.

Each named criterion must be a **first-order claim backed by evidence**. "This feature affects the whole codebase" is not a criterion. "WebSocket server (`src/ws/`), auth middleware (`src/auth/`), and db schema (`prisma/schema.prisma`) — three services" is.

**Fallback rule**: if fewer than 2 criteria can be named with evidence, `/route` MUST recommend `oneoff-spec` with a rationale note. Do not fake a second criterion to clear the bar.

### Condition 3 — Tight parallelization benefit

The work decomposes cleanly into independent workstreams with minimal cross-coupling. Sequential dependencies between most workstreams indicate orchestrator is the wrong tool — the parallelization benefit doesn't materialize when workstream N+1 cannot start until workstream N completes.

- Practical test: can the workstreams execute in parallel git worktrees without frequent cross-workstream synchronization? If yes, condition 3 is met.
- A single-workstream orchestrator run (even with many atomic specs) is a misclassification — use oneoff-spec.

## Evidence Requirement — `multi_domain_justification`

When all three conditions are met, `/route` emits a routing decision block that includes a `multi_domain_justification` field enumerating the ≥2 criteria with evidence:

```yaml
workflow: orchestrator
rationale: Real-time notifications across WebSocket server, browser client, and persistence layer.
multi_domain_justification:
  - criterion: '3+ services'
    evidence: 'websocket-server, notification-service, db-schema (3 independently-deployed services)'
  - criterion: 'cross-runtime boundaries'
    evidence: 'browser (notification-client) and Node.js (websocket-server) runtimes'
```

The decision is persisted to `session.json.active_work.route_decisions[]` via:

```bash
node .claude/scripts/session-checkpoint.mjs record-route-decision orchestrator "<rationale>" \
  --multi-domain-justification '[{"criterion":"3+ services","evidence":"..."},{"criterion":"cross-runtime boundaries","evidence":"..."}]'
```

The CLI rejects:

- `workflow: orchestrator` with no `multi_domain_justification` (code: `ROUTE_DECISION_JUSTIFICATION_REQUIRED`)
- Non-orchestrator workflows with `multi_domain_justification` (code: `ROUTE_DECISION_JUSTIFICATION_FORBIDDEN`)
- Fewer than 2 entries in the justification array (code: `ROUTE_DECISION_JUSTIFICATION_INVALID`)
- Malformed JSON or missing `criterion` / `evidence` fields (code: `ROUTE_DECISION_JUSTIFICATION_INVALID`)

## Worked Examples

### Example 1 — Clear orchestrator

**Request**: "Implement real-time notifications across the application — WebSocket server, frontend client, notification persistence, and auth middleware integration."

**Analysis**:

- Anticipated atomic specs: ~15 (WS connection handling, message routing, frontend subscription, reconnect logic, persistence schema, delivery guarantees, auth integration, load testing, migration, etc.). **Condition 1 met.**
- Multi-domain criteria:
  - `3+ services`: websocket-server + notification-service + db-schema + auth-middleware.
  - `cross-runtime boundaries`: browser notification-client + Node.js WS server.
  - `distinct test surfaces`: unit tests for message routing + integration tests for WS handshake + E2E tests for browser reconnect.
  - **3 criteria met** (need ≥2). **Condition 2 met.**
- Parallelization: WS server, frontend client, and persistence can develop in parallel with thin contract stubs. **Condition 3 met.**

**Decision**: `workflow: orchestrator` with `multi_domain_justification` enumerating 3+ services + cross-runtime.

### Example 2 — Borderline → oneoff-spec (raised bar)

**Request**: "Add a logout button to the user dashboard."

**Analysis**:

- Anticipated atomic specs: 1 (the whole thing is one spec with 4 ACs: UI, token clearing, redirect, error handling). **Condition 1 NOT met.**

**Decision**: `workflow: oneoff-spec`. This is the exact scenario the raised bar targets — prior heuristic would have routed to orchestrator on "multiple files affected" (component, service, route handler, test). Under the raised bar, it's unambiguously oneoff-spec.

### Example 3 — Borderline → oneoff-spec (weak multi-domain)

**Request**: "Refactor the authentication module and add MFA support."

**Analysis**:

- Anticipated atomic specs: ~6 (MFA enrollment, MFA verification, recovery codes, UI prompts, session model changes, tests). **Condition 1 NOT met** (below 10).
- Multi-domain criteria: only `3+ services` plausibly (auth-service + session-store + UI). But UI alone doesn't count as a separate service by itself, and session-store is internal to auth-service. **At most 1 criterion.** Condition 2 not met.

**Decision**: `workflow: oneoff-spec` with a rationale note: "Below 10-atomic-spec threshold; multi-domain criteria do not clearly reach 2 with evidence."

### Example 4 — Self-reference (walk-the-talk)

**Request**: "Author a small oneoff-spec that raises the bar for routing to orchestrator — change SKILL.md heuristic text, add ROUTING.md, CLAUDE.md note, baseline instrumentation, and fixture tests."

**Analysis**:

- Anticipated atomic specs: 10 tasks, each small (SKILL.md edit, ROUTING.md create, CLAUDE.md append, collector script, record CLI, classifier, doc, etc.). **Condition 1 borderline** — 10 tasks but most are documentation edits, not atomic specs in the usual sense.
- Multi-domain criteria: 0-1. All changes land in `.claude/skills/`, `.claude/docs/`, `.claude/scripts/`. No distinct services. Same runtime. **Condition 2 NOT met.**

**Decision**: `workflow: oneoff-spec`. This spec walks its own talk (AC-WALK-THE-TALK).

## Migration Guidance

### In-flight orchestrator work (REQ-004 / EDGE-04)

Spec groups whose `manifest.json` already records `workflow: orchestrator` at the time the raised heuristic shipped are **not reclassified**. Detection is manifest-field-based: the persistent `workflow` field is authoritative for in-flight work.

- New `/route` invocations after the heuristic change apply the raised bar.
- Existing orchestrator spec groups continue under their originally-assigned workflow.
- No migration script. No re-routing. No bulk reclassification.

The raised bar is forward-only.

### Human override

The heuristic is **advisory**. Operators can override any recommendation:

- "Just do it" / "vibe" → `oneoff-vibe` (honored verbatim)
- "Write a full spec first" → `oneoff-spec`
- "Orchestrate this" / "use orchestrator" → `orchestrator` (honored verbatim, even when the three-condition gate is not met; the operator carries the warrant)

Overrides are documented in the decision's `rationale` field ("operator-override: explicit request for orchestrator despite heuristic recommendation of oneoff-spec").

## Measurement

Post-ship impact is measurable via the baseline collector and its comparison runs:

```bash
node .claude/scripts/metrics/pipeline-efficiency-routing-thresholds-collect.mjs \
  --output-path .claude/metrics/routing-baseline-<timestamp>.json \
  --run-id <timestamp>
```

The collector reads `session.json.active_work.route_decisions[]` (populated by `record-route-decision`) and emits a baseline JSON artifact with the sample, distribution, and T0 bootstrap note when the log is empty.

**T0 case**: the first baseline run after the heuristic ships produces `sample_size: 0` + `bootstrap_note` because the append-only log is newly introduced by this spec. Subsequent runs (after `/route` records real decisions) reflect the true distribution and allow post-change comparison against the bootstrap baseline.

## Current Surfaces

- `.claude/skills/route/SKILL.md` §Complexity Heuristics §Large subsection — rewritten to encode the three-condition gate.
- `.claude/skills/route/SKILL.md` §Step 5 — `multi_domain_justification` added to the output schema; `record-route-decision` CLI invocation mandated.
- `.claude/skills/route/SKILL.md` §Edge Cases §In-Flight Orchestrator Work — backwards-compat rule for existing orchestrator spec groups.
- `.claude/scripts/session-checkpoint.mjs record-route-decision` — new CLI subcommand; sole-writer for `active_work.route_decisions[]`.
- `.claude/scripts/metrics/pipeline-efficiency-routing-thresholds-collect.mjs` — baseline instrumentation (mirrors `pipeline-efficiency-ws3-collect.mjs` pattern).
- `.claude/scripts/lib/routing-heuristics.mjs` — pure classifier module for fixture-based tests (deterministic, no LLM invocation).
- `CLAUDE.md §Skills & Subagents System §Workflow Routing` — brief cross-reference note linking to this document.

## References

- Parent PRD: `.claude/prds/pipeline-efficiency/prd.md`
- Retrospective origin: `.claude/context/archive/2026-04-23-routing-threshold-oneoff-handoff.md`
- Memory-bank (orchestrator economics): `.claude/memory-bank/delegation.guidelines.md`

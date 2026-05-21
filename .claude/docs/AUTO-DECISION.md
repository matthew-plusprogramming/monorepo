# Auto-Decision Engine

> Canonical reference for the auto-decision engine used in investigation and challenger convergence loops. CLAUDE.md § Autonomous Convergence carries a compact pointer to this doc; the full protocol, audit-trail schema, and graceful-degradation behavior live here.

## Scope

The Auto-Decision Engine evaluates findings produced by convergence-loop gates (`/investigate` and `/challenge` at pre-implementation) and auto-accepts qualifying findings so the workflow proceeds autonomously in the common case (zero escalations).

**Applies to**:

- Investigation convergence loop (interface-investigator)
- Challenger convergence loop (pre-implementation stage — implementer is fix agent)

**Does NOT apply to**:

- PRD gather-criticize loop (fully human-in-the-loop — see "PRD Loop Unchanged" below)
- Deleted challenger stages now handled by `/unify` preflight, reviewer-focus metadata, or ordinary spec amendment
- Non-convergence gates (code_review, security_review, unifier, completion_verifier findings are evaluated by their own review machinery, not by this engine)

## Autonomous Convergence Workflow

The workflow from spec authoring to implementation is fully autonomous for the common case (zero escalations). The legacy `awaiting_approval` phase has been replaced by convergence-based quality gates:

1. **Investigation convergence loop**: Interface investigator runs iteratively until 2 consecutive clean passes (no Medium+ findings). Auto-decision engine evaluates findings between passes.
2. **Challenger convergence loop**: Challenger runs iteratively for `pre-implementation` until 2 consecutive clean passes. Fix agent: implementer.
3. **Auto-approval**: After both convergence loops complete, a passthrough `auto_approval` phase is recorded for audit purposes. No human gate required.

## Auto-Decision Engine

`.claude/scripts/auto-decision.mjs` evaluates findings against three validation criteria:

- **Criterion 1**: Recommendation contains an explicit action verb
- **Criterion 2**: Recommendation references a specific field or section
- **Criterion 3**: Finding includes a structured confidence enum (high or medium)

Findings meeting all three criteria are auto-accepted. All others escalate to human.

## Safety Rails

- **Oscillation detection**: If a finding ID recurs after its fix was applied, escalate immediately without burning remaining iterations
- **Circuit breaker**: Disables auto-accept when accuracy (from human override events) drops below 90% over a rolling 10-cycle window; re-enables above 95%
- **Iteration cap**: Max 5 iterations per convergence loop
- **Cross-stage resolution guidance**: If resolving a blocker at one stage introduces a blocker at another, the operator should escalate after ~3 round-trips rather than continue indefinitely. (Advisory — not code-enforced.)
- **Security escalation**: Security-tagged findings always escalate regardless of recommendation quality
- **All-or-nothing batch**: If the auto-decision engine crashes mid-batch, no decisions are committed

## Audit Trail

Every auto-decision is recorded with sequential entry IDs, finding ID, recommendation, confidence, and timestamp. Append-only — existing entries cannot be modified. Gap detection on entry IDs indicates corruption.

## Graceful Degradation

If the auto-decision engine script crashes or is missing, all findings are presented to the human for manual resolution. The convergence loop is not blocked.

## PRD Loop Unchanged

The PRD gather-criticize loop remains fully human-in-the-loop. Auto-decision logic does NOT apply to PRD critic findings.

> **Note**: The "PRD Loop Unchanged" clause is also retained inline in `CLAUDE.md` § Autonomous Convergence (not only here) as a load-bearing scope invariant readers need without dereferencing the pointer.

## See Also

- `CLAUDE.md` § Autonomous Convergence — compressed pointer to this doc
- `.claude/scripts/auto-decision.mjs` — engine implementation
- `.claude/skills/investigate/SKILL.md` — investigation convergence-loop mechanics
- `.claude/skills/challenge/SKILL.md` — challenger convergence-loop mechanics
- `.claude/templates/auto-decision-log.template.md` — audit-trail entry template

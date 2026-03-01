<!--
## When to Use This Template

Use this template to capture interrupted work session state when:

(a) **Significant work interruptions**: Complex investigation, orchestrator-level work, or multi-session
    efforts where losing context means losing hours of investigation. The handoff doc preserves the
    "why" and "what next" that session.json cannot capture.

(b) **session.json is for routine phase tracking**: session.json captures *where* work stopped
    (phase, pending specs, subagent state). Use it for standard SDLC checkpoint/resume.

(c) **Handoff docs complement session.json**: They are not a replacement. session.json is
    machine-readable workflow state; handoff docs are human-readable resumption context.
    Create both when interrupting significant work.

### How to Use

1. Copy this template to `.claude/context/archive/<descriptive-slug>-handoff.md`
2. Fill in all sections below (remove placeholder guidance text)
3. Also run `node .claude/scripts/session-checkpoint.mjs archive-incomplete` for machine state
4. The next session's `/route` Step 0 will detect this handoff document automatically
-->

# Handoff: <Descriptive Title>

**Date**: <YYYY-MM-DD>
**Spec Group**: <sg-xxx if applicable, or N/A>
**Session Phase**: <phase from session.json if applicable, or N/A>

## Objective

<!-- What was being worked on and why. Be specific about the goal and its importance. -->

<Describe the work objective and motivation here.>

## Commits Made

<!-- List commits made during this work session, most recent first. -->

- `<hash>` - <description>
- `<hash>` - <description>

## Current Behavior

<!-- What the system does right now, including any broken or incomplete state.
     Be specific about what works and what doesn't. -->

<Describe the current state of the system here.>

## Root Cause Analysis

<!-- Why things are broken, incomplete, or blocked.
     Include investigation findings, hypotheses tested, and evidence gathered. -->

<Describe root causes, investigation findings, and evidence here.>

## Architecture Diagram

<!-- Relevant subsystem diagrams showing the components involved.
     Use ASCII art or Mermaid syntax. Focus on the parts relevant to the handoff. -->

```
<ASCII or Mermaid diagram here>
```

## Environment Variables

<!-- Required env vars, config values, and their current state.
     Use placeholder values (e.g., sk-...xxx) rather than actual secrets. -->

| Variable   | Value                        | Notes                         |
| ---------- | ---------------------------- | ----------------------------- |
| <VAR_NAME> | <placeholder or description> | <context about this variable> |

## Next Steps

<!-- Ordered list of remaining work to complete the objective.
     Be specific enough that someone with no prior context can execute these. -->

1. <First step to take>
2. <Second step to take>
3. <Third step to take>

## Open Questions

<!-- Unresolved decisions or unknowns that need answers before proceeding.
     Include any options considered and recommendations if you have them. -->

- Q1: <Question that needs an answer>
- Q2: <Question that needs an answer>

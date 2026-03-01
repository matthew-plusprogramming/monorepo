# Subagent Dispatch Guide

## Structured Return Contract

Every subagent must return using this format:

- **status**: `success` | `partial` | `failed` — machine-readable, not prose
- **summary**: < 200 words (HARD BUDGET) — what was accomplished, key changes
- **blockers**: List of blocking issues (empty if success)
- **artifacts**: Files created or modified

Without explicit word limits, summaries drift toward 500+ words. The budget is the enforcement mechanism — it protects the orchestrator's context efficiency.

### Error Escalation

- `success` → proceed to next step
- `partial` → list what completed vs. what didn't, orchestrator reviews and retries incomplete portion
- `failed` → include error category; orchestrator retries once silently, then escalates to human
- Never silently swallow failures

## Tool Assignment (Least Privilege)

| Agent Type       | Tools                               | Rationale                  |
| ---------------- | ----------------------------------- | -------------------------- |
| Explore/research | Read, Glob, Grep                    | Information gathering only |
| Implementer      | Read, Write, Edit, Bash, Glob, Grep | Full implementation        |
| Reviewer         | Read, Glob, Grep                    | Read-only analysis         |
| Validator        | Read, Glob, Grep, Bash              | Read + verify              |

Read-only agents never get Write/Edit. Research agents never get Edit.

## Escalation Triggers

Subagents should escalate (not assume) when:

- Spec is ambiguous about a requirement
- Discovered behavior conflicts with spec assumption
- Implementation would break existing functionality
- Security concern not addressed in spec
- Task scope expands beyond original spec

### Escalation Format

Provide: (1) Issue, (2) Context — where this occurred, (3) Options — possible resolutions, (4) Recommendation, (5) Whether work is blocked

## Parallel Safety

When multiple agents work in parallel:

- Coordinate file access via spec's file list
- Implementation writes to `src/`, tests write to `__tests__/`
- Both can read, only one modifies each file
- Do not change contract signatures without updating the contract registry

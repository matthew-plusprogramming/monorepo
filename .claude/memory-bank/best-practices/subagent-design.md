# Subagent Dispatch Guide

## Structured Return Contract

Every subagent must return using this format:

- **status**: `success` | `partial` | `failed` — machine-readable, not prose
- **summary**: what was accomplished and the key changes
- **blockers**: List of blocking issues (empty if success)
- **artifacts**: Files created or modified

Return structured status and evidence pointers rather than raw data. The contract protects main-agent context efficiency without using numeric response caps.

### Error Escalation

- `success` → proceed to next step
- `partial` → list what completed vs. what didn't; the main agent reviews and retries the incomplete portion
- `failed` → include error category; the main agent retries once silently, then escalates to human
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

## Agent Design Patterns

### Parameterized Agent Pattern

A single agent definition that accepts a parameter (e.g., `stage` for challenger, `perspective` for prd-critic) to serve multiple workflow contexts. Prefer parameterization over creating N separate agents when the core logic is the same but the context differs.

**When to use**: The agent performs the same fundamental operation (challenge feasibility, critique a document) but needs different context or focus depending on the workflow stage.

**Examples**:

- `challenger` — parameterized by `stage` (`pre-implementation`). Keep the parameter because the dispatch interface is stage-aware, but do not add extra challenger stages without a current workflow need.
- `prd-critic` — parameterized by `perspective` (completeness, feasibility, clarity, consistency). Same evaluation structure, different lens.

**Anti-pattern**: Creating separate challenger agents for stage variants when a single `challenger` with a `stage` parameter covers the active case.

### Direct-Dispatch Pattern

Some agents are dispatched directly by the orchestrating agent without a skill wrapper (`/command`). Use direct dispatch when:

- **(a)** The agent is always invoked as part of a larger workflow (never standalone)
- **(b)** No user-facing invocation is needed

**Examples of direct dispatch**: `completion-verifier` (always part of the post-review convergence loop), `challenger` (always dispatched by skills as part of pre-flight checks).

**Use skill wrappers when**: The agent needs to be user-invocable via `/command` (e.g., `/implement`, `/code-review`, `/security`). Skills provide the entry point, parameter parsing, and user-facing documentation that direct dispatch skips.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# General Assistant Agent — Core Constraints & Contracts

This file defines invariant rules for how the agent operates.
Task-specific behavior lives in Skills. Do not encode routing logic here.

---

## Core Operating Constraints

### Route-first discipline (MANDATORY)
- **ALWAYS invoke `/route` as the first action for any new user request.**
- The routing skill determines workflow (vibe/spec/orchestrator) AND delegation strategy.
- Skip routing ONLY for: follow-up questions, clarifications, or explicit user override ("just do it").
- Routing includes delegation analysis: identify subtasks that can run in parallel via subagents.

### Plan-first discipline
- Do not execute non-trivial work without a plan.
- Plans must be concise and scoped to the minimum necessary horizon.
- Large or uncertain efforts must be broken into explicit phases.

### Clarification before commitment
- Surface unresolved questions before irreversible decisions.
- If assumptions are required, state them explicitly.
- Do not silently guess when ambiguity materially affects outcomes.

---

## Delegation & Autonomy Constraints

### Delegation is the DEFAULT
- **Delegation is not optional—it is the primary execution mode for non-trivial tasks.**
- The `/route` skill produces a delegation plan as part of every routing decision.
- For any task with 2+ independent components, dispatch parallel subagents.

**Default delegation triggers**:
- Exploration/research needed → Dispatch Explore subagent
- Implementation + tests → Dispatch implementer and test-writer in parallel
- Review gates → Dispatch code-reviewer, security-reviewer in parallel
- Multi-file changes → Dispatch subagents per concern area
- Uncertainty about scope → Dispatch Explore subagent before planning

**Only execute directly when**:
- Single-file trivial change (typo, config tweak)
- Task explicitly requires tight coordination
- User explicitly requests "just do it" / direct execution

### Main-agent responsibility
- You retain ownership of:
  - the global plan and delegation strategy
  - integration and normalization of sub-agent outputs
  - final decisions, tradeoffs, and conflict resolution
- Sub-agent output must be summarized before reuse in main context.
- Main agent orchestrates; subagents execute.

---

## Context & Attention Management

### Context is scarce
- Treat the context window as a limited resource.
- Avoid carrying large bodies of irrelevant or stale information forward.
- Prefer fetching information on demand over preloading.
- Also prefer dispatching subagents to handle isolated tasks and return summaries

### Progressive disclosure
- Load details only when they are required to proceed.
- When interacting with tools, skills, or documents:
  - start with high-level understanding
  - drill down only as needed

---

## Persistence & State Guarantees

### Externalize state aggressively
- Long-lived plans, decisions, or discoveries must be persisted externally.
- Do not rely on conversation history as durable memory.

### Resumability contract
- At any stopping point, ensure an external artifact exists that captures:
  - current objective
  - completed work
  - current phase (if applicable)
  - next concrete steps
  - unresolved questions or risks

This artifact must be sufficient to resume work after context reset.

---

## Execution Constraints

### Small, safe steps
- Prefer incremental progress over large speculative changes.
- Validate assumptions early (tests, probes, experiments).
- Minimize blast radius of changes.

### Determinism over cleverness
- Favor clear, auditable reasoning paths.
- Avoid unnecessary novelty if a standard approach suffices.

---

## Output Contract (Always Required)

Every response must include:

1. **Intent**
   - What is being done right now and why.

2. **Next actions**
   - Concrete, ordered steps that move the work forward.

3. **Open items**
   - Blocking questions, assumptions, or risks.

4. **State updates**
   - What was persisted, updated, or needs persistence next.

---

## Skills & Subagents System

This repository uses Claude Code's native skills and subagents for structured software engineering workflows.

### Workflow Routing (MANDATORY FIRST STEP)

**Every new user request MUST begin with `/route`** (except follow-ups and clarifications).

The routing skill determines:
1. **Workflow**: oneoff-vibe | oneoff-spec | orchestrator
2. **Delegation plan**: Which subtasks run in parallel via subagents
3. **Exploration needs**: Whether to dispatch Explore subagent first

Workflow outcomes:
- **Small tasks (oneoff-vibe)**: Direct execution, no delegation
- **Medium tasks (oneoff-spec)**: TaskSpec + parallel delegation (implement + test)
- **Large tasks (orchestrator)**: MasterSpec + full parallel workstream delegation

### Core Skills

| Skill | Purpose | When to Use |
|-------|---------|-------------|
| `/route` | Analyze task complexity and route to workflow | Start of any new task |
| `/pm` | Interview user to gather requirements | Before spec authoring, feedback collection |
| `/spec` | Author specifications (TaskSpec, WorkstreamSpec, MasterSpec) | After requirements gathering |
| `/implement` | Implement from approved specs | After spec approval |
| `/test` | Write tests for acceptance criteria | Parallel with implementation or after |
| `/unify` | Validate spec-impl-test alignment | After implementation and tests complete |
| `/code-review` | Code quality and best practices review | After convergence, before security review |
| `/security` | Security review of implementation | After code review, before merge |
| `/docs` | Generate documentation from implementation | After security review, before merge |
| `/refactor` | Code quality improvements | Tech debt sprints, post-merge cleanup |
| `/orchestrate` | Coordinate multi-workstream projects | For large tasks with 3+ workstreams |
| `/browser-test` | Browser-based UI testing | For UI features, after security review |

### Specialized Subagents

| Subagent | Model | Purpose |
|----------|-------|---------|
| `product-manager` | opus | Interview users, gather/refine requirements |
| `spec-author` | opus | Author workstream specs (no code) |
| `implementer` | opus | Implement from approved specs |
| `test-writer` | opus | Write tests for acceptance criteria |
| `unifier` | opus | Validate convergence |
| `code-reviewer` | opus | Code quality review (read-only, runs before security) |
| `security-reviewer` | opus | Security review (read-only) |
| `documenter` | opus | Generate docs from implementation |
| `refactorer` | opus | Code quality improvements with behavior preservation |
| `facilitator` | opus | Orchestrate multi-workstream projects with git worktrees |
| `browser-tester` | opus | Browser-based UI testing |

### Spec is Contract Principle

**The spec is the authoritative source of truth.**

- Implementation must conform to spec
- Tests must verify spec requirements
- Any deviation requires spec amendment first (never deviate silently)
- Unifier validates alignment before approval

### Iteration Cycle

#### Small Task (oneoff-vibe)
```
Request → Route → Execute → Commit
```

#### Medium Task (oneoff-spec)
```
Request → Route → PM Interview → Spec → Approve →
  [Parallel: Implement + Test] → Unify → Code Review → Security → Commit
```

#### Large Task (orchestrator)
```
Request → Route → PM Interview → ProblemBrief →
  [Parallel: WorkstreamSpecs] → MasterSpec → Approve →
  [Parallel per workstream: Implement + Test] →
  Unify → Code Review → Security → Browser Test → Docs → Commit
```

### Persistence

All artifacts are stored in `.claude/`:

```
.claude/
├── agents/              # Subagent specifications
├── skills/              # Skill definitions
├── specs/
│   ├── active/          # Current specs
│   └── archive/         # Completed specs
├── context/
│   └── session.json     # Session state
├── scripts/             # Code quality checks (project-specific)
├── templates/           # Spec templates
└── settings.json        # Hooks configuration
```

### Parallel Execution

For large tasks, the main agent orchestrates parallel execution:
- Multiple `spec-author` subagents for workstreams
- `implementer` and `test-writer` run in parallel
- Main agent handles integration and validation

### Convergence Gates

Before merge, all gates must pass:
- Spec complete and approved
- All ACs implemented
- All tests passing (100% AC coverage)
- Unifier validation passed
- Code review passed (no High/Critical issues)
- Security review passed
- Browser tests passed (if UI)
- Documentation generated (if public API)

### Example Workflow

```markdown
User: "Add a logout button to the dashboard"

1. `/route` → oneoff-spec (medium complexity)
2. `/pm` → Interview user about placement, behavior, error handling
3. `/spec` → Create TaskSpec with 4 ACs, 6 tasks
4. User approves spec
5. [Parallel] `/implement` + `/test`
6. `/unify` → Validate convergence (all ACs implemented and tested)
7. `/code-review` → Quality review (style, maintainability, best practices)
8. `/security` → Security review (auth endpoint validated)
9. `/browser-test` → UI testing (logout button click, toast, redirect)
10. `/docs` → Generate API docs for logout endpoint
11. Commit with spec evidence
```

---

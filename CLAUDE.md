# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# General Assistant Agent — Core Constraints & Contracts

This file defines invariant rules for how the agent operates.
Task-specific behavior lives in Skills. Do not encode routing logic here.

---

## Core Operating Constraints

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

### Delegation is expected
- You are allowed and encouraged to delegate work to sub-agents.
- Delegation should be used to:
  - reduce main-context load
  - parallelize work
  - isolate exploratory or disposable reasoning

### Main-agent responsibility
- You retain ownership of:
  - the global plan
  - integration of sub-agent outputs
  - final decisions and tradeoffs
- Sub-agent output must be summarized and normalized before reuse.

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

### Workflow Routing

Use the routing skill to determine the appropriate workflow for each task:
- **Small tasks (oneoff-vibe)**: Direct execution without formal spec
- **Medium tasks (oneoff-spec)**: TaskSpec workflow with requirements and test plan
- **Large tasks (orchestrator)**: MasterSpec with parallel workstreams

### Core Skills

| Skill | Purpose | When to Use |
|-------|---------|-------------|
| `/route` | Analyze task complexity and route to workflow | Start of any new task |
| `/pm` | Interview user to gather requirements | Before spec authoring, feedback collection |
| `/spec` | Author specifications (TaskSpec, WorkstreamSpec, MasterSpec) | After requirements gathering |
| `/implement` | Implement from approved specs | After spec approval |
| `/test` | Write tests for acceptance criteria | Parallel with implementation or after |
| `/unify` | Validate spec-impl-test alignment | After implementation and tests complete |
| `/security` | Security review of implementation | After convergence, before merge |
| `/orchestrate` | Coordinate multi-workstream projects | For large tasks with 3+ workstreams |
| `/browser-test` | Browser-based UI testing | For UI features, after security review |

### Specialized Subagents

| Subagent | Model | Purpose |
|----------|-------|---------|
| `product-manager` | opus | Interview users, gather/refine requirements |
| `spec-author` | opus | Author workstream specs (no code) |
| `implementer` | sonnet | Implement from approved specs |
| `test-writer` | sonnet | Write tests for acceptance criteria |
| `unifier` | opus | Validate convergence |
| `security-reviewer` | sonnet | Security review (read-only) |
| `facilitator` | opus | Orchestrate multi-workstream projects with git worktrees |
| `browser-tester` | sonnet | Browser-based UI testing |

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
  [Parallel: Implement + Test] → Unify → Security → Commit
```

#### Large Task (orchestrator)
```
Request → Route → PM Interview → ProblemBrief →
  [Parallel: WorkstreamSpecs] → MasterSpec → Approve →
  [Parallel per workstream: Implement + Test] →
  Unify → Security → Browser Test → Commit
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
- Security review passed
- Browser tests passed (if UI)

### Example Workflow

```markdown
User: "Add a logout button to the dashboard"

1. `/route` → oneoff-spec (medium complexity)
2. `/pm` → Interview user about placement, behavior, error handling
3. `/spec` → Create TaskSpec with 4 ACs, 6 tasks
4. User approves spec
5. [Parallel] `/implement` + `/test`
6. `/unify` → Validate convergence (all ACs implemented and tested)
7. `/security` → Security review (auth endpoint validated)
8. `/browser-test` → UI testing (logout button click, toast, redirect)
9. Commit with spec evidence
```

---

# Project: Monorepo

## Overview

Full-stack TypeScript monorepo with multiple applications, shared packages, and infrastructure-as-code.

## Tech Stack

- **Language**: TypeScript
- **Runtime**: Node.js
- **Build**: Turborepo
- **Infrastructure**: CDK (AWS) + CDKTF (Terraform)
- **Effect System**: Effect-ts for functional error handling

## Directory Structure

```
monorepo/
├── apps/                    # Deployed applications
│   ├── admin-portal/
│   ├── analytics-lambda/
│   ├── client-website/
│   └── node-server/
├── packages/                # Shared libraries
│   ├── configs/
│   ├── core/
│   └── utils/
├── cdk/                     # Infrastructure as Code
│   └── platform-cdk/
├── scripts/                 # Infrastructure scripts (deploy, scaffold)
├── .claude/                 # Agentic system
└── turbo.json              # Turborepo configuration
```

## Commands

```bash
npm run build          # Build all packages
npm run test           # Run all tests
npm run lint:fix       # Fix linting issues
npm run phase:check    # Full quality gate (lint + quality checks + build + test)
```

## Code Quality Gates

This monorepo uses automated code quality checks that run as part of the phase check process.

### Phase Check Command

```bash
npm run phase:check
```

This runs:
1. `npm run lint:fix` - Auto-fix linting issues
2. `node .claude/scripts/check-code-quality.mjs` - Domain-specific quality checks
3. `npm run build` - Build all packages
4. `npm run test` - Run all tests

### Quality Check Scripts

Located in `.claude/scripts/`:

| Script | Purpose |
|--------|---------|
| `check-code-quality.mjs` | Orchestrates all quality checks |
| `check-effect-run-promise.mjs` | Validates Effect.runPromise usage patterns |
| `check-effect-promise.mjs` | Validates Effect.promise() patterns |
| `check-env-schema-usage.mjs` | Ensures process.env accesses match EnvironmentSchema |
| `check-console-usage.mjs` | Prevents console.log in production code |
| `check-resource-names.mjs` | Validates AWS resource naming conventions |
| `check-test-aaa-comments.mjs` | Enforces AAA (Arrange-Act-Assert) test comments |

## Infrastructure Scripts

Located in `scripts/` (separate from agentic `.claude/scripts/`):

| Script | Purpose |
|--------|---------|
| `deploy-orchestrator.mjs` | Smart CDK/CDKTF deployment orchestration |
| `manage-cdktf-state.mjs` | Bootstrap, deploy, output management |
| `run-sequence.mjs` | Named command chains |
| `create-repository-service.mjs` | Scaffold new repository services |
| `create-node-server-handler.mjs` | Scaffold new API handlers |

## Conventions

- All Effect-ts code must use proper error handling patterns
- Environment variables must be declared in EnvironmentSchema
- Tests must use AAA (Arrange-Act-Assert) comments
- AWS resources follow naming conventions checked by quality scripts

## Memory Bank Retrieval Policy

The memory bank at `.claude/memory-bank/` contains persistent project knowledge.

| File | Load When |
|------|-----------|
| `project.brief.md` | Starting new major feature, onboarding |
| `tech.context.md` | Making architectural decisions, choosing patterns |
| `testing.guidelines.md` | Writing tests, reviewing test coverage |
| `best-practices/typescript.md` | TypeScript-specific implementation questions |
| `best-practices/software-principles.md` | Design pattern decisions |

---

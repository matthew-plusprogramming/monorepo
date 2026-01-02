# Agentic Software Development — Operator's Guide

**Version**: 1.0
**Last Updated**: 2026-01-01

This guide explains how to operate the agentic software development system from a user/operator perspective. It covers when to use different workflows, how to interact with the system, and what to expect at each phase.

---

## Table of Contents

- [System Overview](#system-overview)
- [Choosing the Right Workflow](#choosing-the-right-workflow)
- [Workflow Reference](#workflow-reference)
  - [Orchestrator Workflow](#orchestrator-workflow)
  - [Spec Author Workflow](#spec-author-workflow)
  - [Implementer Workflow](#implementer-workflow)
  - [One-off Spec Workflow](#one-off-spec-workflow)
  - [One-off Vibe Workflow](#one-off-vibe-workflow)
- [Essential Commands](#essential-commands)
- [Memory Bank Structure](#memory-bank-structure)
- [Task Specifications](#task-specifications)
- [Approval Gates & Sign-offs](#approval-gates--sign-offs)
- [Quality Gates](#quality-gates)
- [Common Patterns](#common-patterns)
- [Troubleshooting](#troubleshooting)
- [Nuances & Gotchas](#nuances--gotchas)

---

## System Overview

The agentic software development system is a **spec-first orchestration framework** built on three pillars:

1. **Memory Bank** (`agents/memory-bank/`)
   - Durable, structured markdown knowledge base
   - Single source of truth for patterns, decisions, and project context
   - Version-controlled alongside code

2. **Workflows** (`agents/workflows/`)
   - Executable markdown guides that drive agent behavior
   - Four-phase structure: Requirements → Design → Implementation Planning → Execution
   - Each phase has explicit inputs, outputs, and gates

3. **Task Specs** (`agents/specs/task-specs/`)
   - Per-task specifications capturing the full lifecycle
   - Requirements (EARS format), Design (diagrams + flows), Implementation Planning (tasks + tests), Execution (evidence + reflections)
   - Durable artifacts that enable resumability and context preservation

### Core Philosophy

**Plan-first discipline**: Agents create specs and obtain approval before implementing. This ensures:
- Durable context that survives across sessions
- Visible approval gates
- Testable acceptance criteria
- Clear traceability from requirements → design → code → tests

---

## Choosing the Right Workflow

When starting work, choose the workflow that matches your task's scope and complexity:

```
┌─────────────────────────────────────────────────────┐
│ Does this involve multiple workstreams, repos,      │
│ or cross-cutting contracts?                         │
└─────────────────┬───────────────────────────────────┘
                  │
        ┌─────────┴─────────┐
        │                   │
       YES                 NO
        │                   │
        ▼                   ▼
┌───────────────┐   ┌──────────────────┐
│ ORCHESTRATOR  │   │ Is this clearly  │
│  WORKFLOW     │   │ bounded and      │
└───────────────┘   │ small?           │
                    └────────┬─────────┘
                             │
                   ┌─────────┴─────────┐
                   │                   │
                  YES                 NO
                   │                   │
                   ▼                   ▼
            ┌─────────────┐   ┌──────────────┐
            │ ONE-OFF     │   │ ONE-OFF      │
            │ VIBE        │   │ SPEC         │
            │ (no spec)   │   │ (with spec)  │
            └─────────────┘   └──────────────┘
```

### Quick Decision Guide

| Scenario | Workflow | Why |
|----------|----------|-----|
| Adding a feature across frontend + backend + DB | **Orchestrator** | Multiple components, shared contracts |
| Implementing a spec someone else created | **Implementer** | Executing from approved spec |
| Writing a spec (no code yet) for a workstream | **Spec Author** | Spec-only deliverable |
| Adding a new API endpoint with tests | **One-off Spec** | Single bounded change, needs design approval |
| Fixing a typo or small refactor | **One-off Vibe** | Trivial, no spec overhead needed |

**Golden Rule**: When in doubt, ask the operator: _"Should this be orchestrator mode or one-off?"_ If one-off: _"Spec or vibe?"_

---

## Workflow Reference

### Orchestrator Workflow

**File**: `agents/workflows/orchestrator.workflow.md`

**Use when**:
- Multiple workstreams (e.g., frontend + backend + infrastructure)
- Cross-cutting contracts or interfaces
- Changes spanning multiple repositories or services

**Phases**:
1. **Requirements**: Normalize request into ProblemBrief
2. **Design**: Decompose into workstreams, identify contracts
3. **Implementation Planning**: Assign spec authors, merge workstream specs into MasterSpec
4. **Execution**: Gate implementers, track progress, integrate deliverables

**Key Outputs**:
- `ProblemBrief.md`: Normalized goals, constraints, success criteria
- Workstream specs (one per workstream)
- `MasterSpec.md`: Merged spec with gate report
- Contract registry entries (`agents/contracts/registry.yaml`)

**Commands**:
```bash
# Create problem brief
node agents/scripts/reset-active-context.mjs --slug "feature-name"

# Provision per-workstream worktrees
node agents/scripts/manage-worktrees.mjs ensure --workstreams ws1,ws2,ws3

# Merge workstream specs
node agents/scripts/spec-merge.mjs --specs "ws1.md,ws2.md,ws3.md" --output MasterSpec.md

# Validate specs + Memory Bank references
npm run spec:finalize
```

**Approval Gates**:
1. After Requirements: Approve ProblemBrief
2. After Design: Approve workstream decomposition
3. After Implementation Planning: Approve MasterSpec + gate report
4. After Execution: Approve final integration

---

### Spec Author Workflow

**File**: `agents/workflows/spec-author.workflow.md`

**Use when**:
- Assigned to write a workstream spec (no code implementation)
- Deliverable is a schema-compliant spec only

**Phases**:
1. **Requirements**: Clarify scope, dependencies, contracts
2. **Design**: Document flows, diagrams, interfaces
3. **Implementation Planning**: Break into tasks, map tests to acceptance criteria
4. **Execution**: Finalize and validate spec (no code)

**Key Outputs**:
- Workstream spec file (`agents/specs/workstream-specs/<name>.md`)
- Contract registry entries (if owning shared interfaces)

**Commands**:
```bash
# Validate spec compliance
node agents/scripts/spec-validate.mjs --specs agents/specs/workstream-specs/my-workstream.md

# Check schema compliance (front matter, required sections)
npm run spec:validate
```

**Approval Gates**:
- After Implementation Planning: Spec approval before handing off to implementer

---

### Implementer Workflow

**File**: `agents/workflows/implementer.workflow.md`

**Use when**:
- Executing code from an approved MasterSpec or workstream spec
- Translating spec into working implementation

**Prerequisites**:
- Approved MasterSpec or workstream spec
- Gate report (if from orchestrator mode)

**Phases**:
1. **Requirements**: Understand assigned workstream scope
2. **Design**: Review flows, contracts, test strategy
3. **Implementation Planning**: Sequence tasks, identify blockers
4. **Execution**: Deliver code, map tests to acceptance criteria, validate

**Key Outputs**:
- Working code in per-workstream git branch
- Tests with evidence mapped to acceptance criteria
- Updated Memory Bank (if patterns/decisions emerged)

**Commands**:
```bash
# Create per-workstream git worktree
node agents/scripts/create-worktree.mjs --name ws-api --branch feature/api-impl

# Run quality checks (lint + code quality)
npm run phase:check

# Finalize before shipping (format + validate + quality)
npm run agent:finalize
```

**Approval Gates**:
- After Implementation Planning: Task sequencing approval
- After Execution: Code review + tests validation

---

### One-off Spec Workflow

**File**: `agents/workflows/oneoff-spec.workflow.md`

**Use when**:
- Single, bounded change with clear scope
- Needs design approval before implementation
- Not trivial enough for "vibe mode"

**Phases**:
1. **Requirements**: EARS user stories + acceptance criteria
2. **Design**: Flows, diagrams, edge cases
3. **Implementation Planning**: Task breakdown, test mapping
4. **Execution**: Implement, validate, reflect

**Key Outputs**:
- Task spec file (`agents/specs/task-specs/<YYYY-MM-DD>-<slug>.md`)
- Code implementation with tests
- Memory Bank updates (if applicable)

**Commands**:
```bash
# Create task spec
node agents/scripts/reset-active-context.mjs --slug "add-caching" --title "Add response caching"

# Load context for task
node agents/scripts/load-context.mjs --task agents/specs/task-specs/2025-01-01-add-caching.md

# Finalize before shipping
npm run agent:finalize
```

**Approval Pattern**:
- After Implementation Planning: Record human approval in "Decision & Work Log" section
- Format: `Approval: [Name] approved spec on [date]`

**Example Flow**:
```bash
# 1. Create spec
node agents/scripts/reset-active-context.mjs --slug "auth-middleware"

# 2. Fill Requirements phase (EARS + acceptance criteria)
# 3. Fill Design phase (at least one Mermaid diagram)
# 4. Fill Implementation Planning (tasks + test mapping)

# 5. Get approval (record in Decision & Work Log)

# 6. Execute (implement code)
# 7. Map tests to acceptance criteria in Execution log
# 8. Run quality gates
npm run agent:finalize

# 9. Commit
git commit -m "feat: implement auth middleware
- Satisfies AC1, AC2, AC3
- See: agents/specs/task-specs/2025-01-01-auth-middleware.md"
```

---

### One-off Vibe Workflow

**File**: `agents/workflows/oneoff-vibe.workflow.md`

**Use when**:
- Small, clearly bounded change
- No spec overhead needed
- Examples: typo fixes, small refactors, trivial additions

**Phases**:
1. **Intake**: Confirm scope is genuinely small
2. **Execution**: Implement + validate

**Scope Guardrail**: If scope grows during execution, immediately switch to one-off-spec workflow.

**Key Outputs**:
- Code changes
- Quality gate pass
- Conventional commit message

**Commands**:
```bash
# Just implement directly, then finalize
npm run agent:finalize

# Commit with conventional format
git commit -m "fix: correct typo in README"
```

**No Formal Spec**: Approvals and decisions can be recorded in the final response or commit message.

---

## Essential Commands

### Context Loading

```bash
# Load required Memory Bank + workflow files for current task
node agents/scripts/load-context.mjs [--include-optional] [--list] [--task <path>]

# Example: Load context for a specific task spec
node agents/scripts/load-context.mjs --task agents/specs/task-specs/2025-01-01-my-feature.md

# List what would be loaded (dry run)
node agents/scripts/load-context.mjs --list
```

**Always Loaded**:
- `agents/workflows/oneoff.workflow.md`
- `agents/workflows/oneoff-spec.workflow.md`
- `agents/memory-bank/project.brief.md`
- `agents/memory-bank/operating-model.md`
- `agents/memory-bank/task-spec.guide.md`
- Current task spec (if `--task` flag provided)

**Conditionally Loaded** (with `--include-optional`):
- `agents/memory-bank/tech.context.md` (only if substantive content)
- `agents/memory-bank/best-practices/*.md` (matched by domain/tags)

---

### Task Spec Management

```bash
# Create a new per-task spec
node agents/scripts/reset-active-context.mjs --slug "<task-slug>" [--title "..."] [--date YYYY-MM-DD]

# Example:
node agents/scripts/reset-active-context.mjs --slug "add-caching" --title "Add response caching"
# Creates: agents/specs/task-specs/2025-01-01-add-caching.md
```

---

### File Discovery (Preferred Over grep/find)

```bash
# List files recursively with metadata
node agents/scripts/list-files-recursively.mjs --root <path> --pattern <pattern> [--types ts|md|all] [--regex] [--case-sensitive]

# Smart regex search with context lines and numbered output
node agents/scripts/smart-file-query.mjs --regex "<pattern>" [--glob "*.ts"] [--contextLines 3] [--json]

# Read multiple files with line numbers (enables single-pass note taking)
node agents/scripts/read-files.mjs --files "path1.md,path2.md" [--json]
```

**Single-Pass Discipline**: These scripts emit line numbers so you can cite `path:line` without re-reading files. This conserves context and follows workflow discipline.

---

### Spec Management (Orchestrator Mode)

```bash
# Validate spec compliance (front matter, required sections, registry references)
node agents/scripts/spec-validate.mjs --specs "<path[,path...]>" [--registry agents/contracts/registry.yaml]

# Merge workstream specs into MasterSpec and generate gate report
node agents/scripts/spec-merge.mjs --specs "<path[,path...]>" --output <path> [--registry agents/contracts/registry.yaml]

# Create/manage per-workstream git worktrees
node agents/scripts/manage-worktrees.mjs ensure [--workstreams <ids>]
node agents/scripts/manage-worktrees.mjs list|status|remove|prune

# Create a single git worktree for implementer
node agents/scripts/create-worktree.mjs --name "<workstream-id>" [--branch "<branch-name>"] [--base "<git-ref>"]
```

---

### Validation & Quality Gates

```bash
# Run all quality checks: format markdown + validate Memory Bank + lint + code quality
npm run agent:finalize

# Format markdown files under agents/
npm run format:markdown

# Validate Memory Bank: ensure referenced paths exist
npm run memory:validate

# Run linting fix + code quality check
npm run phase:check

# Spec-specific validation
npm run spec:finalize  # Validate specs + Memory Bank references
npm run spec:validate  # Validate spec compliance only
npm run spec:merge     # Merge specs and generate gate report
```

---

### Git Utilities

```bash
# Capture diff with line numbers for verification reports
node agents/scripts/git-diff-with-lines.mjs [--cached]
```

---

## Memory Bank Structure

The Memory Bank (`agents/memory-bank/`) is the **single source of truth** for durable knowledge.

### Core Files (Always Present)

| File | Purpose |
|------|---------|
| `memory-bank.md` | Overview, retrieval policy (canonical for discovery rules) |
| `operating-model.md` | Four-phase loop expectations, artifact locations, tool references |
| `task-spec.guide.md` | Template and guidance for per-task specs |
| `project.brief.md` | High-level project context (filled in over time) |
| `tech.context.md` | Stack, tooling, entrypoints (include only if substantive) |

### Optional Canonical Files

| Path | Purpose |
|------|---------|
| `spec-orchestration.design.md` | Detailed spec-first pipeline, workstream decomposition |
| `testing.guidelines.md` | Testing boundaries, dependency injection, evidence mapping |
| `best-practices/software-principles.md` | General design principles (SoC, DRY, composition) |
| `best-practices/typescript.md` | TypeScript-specific patterns |
| `best-practices/<domain>.md` | Domain-specific reusable guidance |

### Retrieval Policy

**Always include** when loading context:
- `agents/workflows/oneoff.workflow.md`
- `agents/workflows/oneoff-spec.workflow.md`
- `agents/memory-bank/project.brief.md`
- `agents/memory-bank/operating-model.md`
- `agents/memory-bank/task-spec.guide.md`
- Current task spec (if it exists) via `--task` flag

**Optional** (gate by substance):
- `agents/memory-bank/tech.context.md` (only if non-placeholder content)
- `agents/memory-bank/best-practices/*.md` (match by `domain`/`tags` in front matter)

---

## Task Specifications

Every task gets a per-task spec file at `agents/specs/task-specs/<YYYY-MM-DD>-<slug>.md`.

### Required Sections

#### 1. Requirements
- EARS-formatted user stories + acceptance criteria (atomic, testable)
- Non-goals, constraints, risks, invariants
- Impacted components, interfaces, candidate files/tests to touch
- Retrieval sources consulted

**EARS Format** (Explicit, Atomic, Realistic, Specific):
- ✅ "When user clicks 'Save', endpoint returns 201 within 200ms"
- ❌ "System saves data quickly"

#### 2. Design
- Architecture notes (logical, data, control flows)
- **At least one Mermaid sequence diagram** for the primary path
- Interfaces/contracts, data shapes, edge/failure behaviors
- Performance, security, migration considerations

#### 3. Implementation Planning
- Discrete tasks with outcomes, dependencies, owners
- Non-primitive fields and storage format definitions (if applicable)
- **Test-to-acceptance-criteria traceability** (each AC has planned verification)
- Documentation updates needed (user/dev/runbook/README and target files)
- Memory Bank canonical updates needed (which files and why)
- Sequencing, blockers, checkpoints

#### 4. Execution
- Progress log (updates as reality changes)
- Evidence/tests tied to acceptance criteria
- Follow-ups and adjustments to the spec
- Final reflections

### Phase Reflections & Approvals

After each phase, **log a reflection** in the task spec and **record approvals in the Decision & Work Log** section:

```markdown
## Decision & Work Log

### [Phase Name] Phase
- **Decision**: [What was decided]
- **Approval**: [Who approved and when]
- **Work Log**: [Progress notes this phase]
```

---

## Approval Gates & Sign-offs

### When Approval is Required

| Workflow | Gate Point | What Needs Approval |
|----------|-----------|---------------------|
| **Orchestrator** | After Requirements | ProblemBrief |
| **Orchestrator** | After Design | Workstream decomposition |
| **Orchestrator** | After Implementation Planning | MasterSpec + gate report |
| **Spec Author** | After Implementation Planning | Workstream spec |
| **Implementer** | After Implementation Planning | Task sequencing |
| **One-off Spec** | After Implementation Planning | Task spec |

### Recording Approvals

Approvals must be recorded in the **Decision & Work Log** section of the spec:

```markdown
## Decision & Work Log

### Implementation Planning Phase
- **Approval**: John Smith approved spec on 2025-01-01 at 14:30
- **Rationale**: Reviewed task breakdown, test mapping, and Memory Bank update plan. All acceptance criteria have corresponding tests.
```

**Critical**: Do not proceed to Execution phase without recorded approval for spec-based workflows.

---

## Quality Gates

Before shipping, all work must pass quality gates:

### Validation Checklist

Run before creating PR or final commit:

```bash
npm run agent:finalize
```

This runs:
1. **Markdown formatting** (`npm run format:markdown`)
2. **Memory Bank validation** (`npm run memory:validate`) — ensures all inline code paths exist
3. **Linting** (`npm run phase:check`) — code quality checks
4. **Spec validation** (if specs were modified) — schema compliance

### Manual Checklist

- [ ] Task spec has all four phases complete
- [ ] EARS user stories + acceptance criteria are specific and testable
- [ ] Design includes at least one Mermaid sequence diagram
- [ ] Implementation Planning maps tests/evidence to each acceptance criterion
- [ ] All code changes tested and evidence cited in Execution log
- [ ] Decision & Work Log includes all approvals
- [ ] Memory Bank canonicals updated if needed
- [ ] `npm run memory:validate` passes
- [ ] `npm run agent:finalize` passes
- [ ] Commit message follows conventional commits format
- [ ] Reflection captured in task spec

---

## Common Patterns

### Starting a One-off Task

```bash
# 1. Create task spec
node agents/scripts/reset-active-context.mjs --slug "my-feature" --title "Add feature X"

# 2. Load context
node agents/scripts/load-context.mjs --task agents/specs/task-specs/2025-01-01-my-feature.md

# 3. Follow oneoff-spec workflow
# - Fill Requirements (EARS + acceptance criteria)
# - Add Design (diagrams, flows, edge cases)
# - Create Implementation Planning (task breakdown, test mapping)
# - Request approval

# 4. Execute against spec
# - Implement code
# - Map tests to acceptance criteria
# - Update Memory Bank if needed
# - Run quality gates

# 5. Finalize
npm run agent:finalize

# 6. Propose commit message
git commit -m "feat: implement X

- Added feature X with tests
- Satisfies acceptance criteria AC1, AC2, AC3
- See: agents/specs/task-specs/2025-01-01-my-feature.md"
```

---

### Orchestrator Starting a Large Feature

```bash
# 1. Clarify request into ProblemBrief
node agents/scripts/reset-active-context.mjs --slug "multi-ws-feature"

# 2. Decompose into workstreams
# - Which teams/components own each part?
# - What contracts are shared?

# 3. Assign spec authors
# - Each gets: scope, dependencies, contract expectations
# - Reference: agents/workflows/spec-author.workflow.md

# 4. Collect workstream specs
# - Authors deliver validated specs

# 5. Merge and gate
node agents/scripts/spec-merge.mjs --specs "ws1.md,ws2.md,ws3.md" --output MasterSpec.md

# 6. Approve MasterSpec
# - Review gate report
# - Record approval in Decision & Work Log

# 7. Hand off to implementers
# - Each implementer uses: agents/workflows/implementer.workflow.md
# - Reference MasterSpec + their workstream spec
```

---

### Switching from Vibe to Spec

If scope grows during a one-off-vibe task:

```bash
# 1. Stop execution immediately

# 2. Create a proper task spec
node agents/scripts/reset-active-context.mjs --slug "original-task"

# 3. Backfill Requirements and Design from work done so far

# 4. Complete Implementation Planning

# 5. Get approval

# 6. Resume execution in spec-based mode
```

---

## Troubleshooting

### Common Issues

#### "Spec validation failed"
```bash
# Check which validation failed
npm run spec:validate

# Common causes:
# - Missing front matter (title, date, phase)
# - Missing required sections (Requirements, Design, etc.)
# - Invalid registry references
```

**Fix**: Review spec template and ensure all required sections are present.

---

#### "Memory Bank validation failed"
```bash
# See which paths are invalid
npm run memory:validate

# Common causes:
# - Inline code paths in backticks don't exist in repo
# - File was moved/renamed but markdown not updated
```

**Fix**: Update markdown references or restore missing files.

---

#### "Context overload — agent losing track"

**Symptoms**: Agent repeatedly re-reading same files, losing context of earlier decisions.

**Fix**:
1. Use single-pass discipline: `node agents/scripts/load-context.mjs --task <path>`
2. Take numbered notes: scripts emit line numbers, cite `path:line`
3. Delegate to sub-agents for isolated exploration
4. Use `--include-optional` only when truly needed

---

#### "Tests don't map to acceptance criteria"

**Symptoms**: Execution log shows tests but no clear traceability to ACs.

**Fix**:
1. In Implementation Planning, create explicit test-to-AC mapping:
   ```markdown
   | AC | Test Name | Evidence Location |
   |----|-----------|-------------------|
   | AC1: Returns 201 within 200ms | test_save_returns_201_under_200ms | tests/api.test.ts:45 |
   ```
2. In Execution log, cite this mapping when reporting test results

---

#### "Approval gate unclear — can I proceed?"

**Question**: "I've finished Implementation Planning. Can I start coding?"

**Answer**:
- **Spec-based workflows** (one-off-spec, spec-author, orchestrator): NO. You need recorded approval in Decision & Work Log first.
- **Vibe workflow**: YES. No formal approval gate.

**How to get approval**:
1. Present completed Implementation Planning to operator
2. Operator reviews and approves
3. Record approval in Decision & Work Log:
   ```markdown
   - **Approval**: [Operator name] approved spec on [date]
   ```

---

## Nuances & Gotchas

### 1. Mode is chosen by the USER, not inferred by agent
Even small tasks can be orchestrator if multiple workstreams are needed. Do not guess; ask the operator.

### 2. Spec approval is a gate
You cannot move from Implementation Planning → Execution without recorded approval in the Decision & Work Log (for spec-based work).

### 3. Specs are living documents
If reality changes during Execution, **update the spec**. The spec is the source of truth, not a static plan. Capture deviations and rationale in Execution log.

### 4. One-pass context discipline
Context is scarce. Load once, take numbered notes, cite line numbers. Repeated pulls waste cycles and violate workflow discipline.

### 5. Workstreams own contracts, not teams
Decompose by interface boundaries, not org structure. Each workstream should own or depend on a clear contract.

### 6. Memory Bank is PR-reviewed
Changes to canonicals under `agents/memory-bank/` should go through PR/commit review, not be auto-merged. These are durable knowledge.

### 7. Vibe mode is for small changes only
If scope grows during a one-off-vibe task, **immediately switch to one-off-spec** and create a proper spec. Do not try to retrofit.

### 8. Tests must trace back to ACs
"Acceptance criterion AC1: System returns 200 within 100ms" → "Test: test_save_returns_200_under_100ms" → Evidence in Execution log.

### 9. Decision & Work Log is human-facing
This is where approvals and key decisions live. It's separate from phase reflections. Make it readable and explicit.

### 10. npm run agent:finalize is a gate
Should not error before shipping. Run it locally before PR, run it in CI as a merge gate.

---

## Conventional Commits

Every spec/workflow completion should propose a conventional commit:

```bash
# Features
git commit -m "feat(agents): implement orchestrator workflow"

# Fixes
git commit -m "fix(agents): correct task-spec.guide examples"

# Documentation
git commit -m "docs(agents): clarify retrieval policy"

# Refactoring
git commit -m "refactor(agents): simplify spec-merge logic"
```

**Multi-line commits** (preferred for spec-based work):
```bash
git commit -m "feat: implement auth middleware

- Added JWT validation middleware
- Satisfies acceptance criteria AC1, AC2, AC3
- Updated Memory Bank: best-practices/auth.md
- See: agents/specs/task-specs/2025-01-01-auth-middleware.md"
```

---

## Contract Registry (Orchestrator Mode)

**File**: `agents/contracts/registry.yaml`

Tracks shared interfaces and contracts across workstreams:

```yaml
- id: contract-api-v1
  type: api-interface
  path: agents/contracts/api-v1.contract.md
  owner: ws-api          # Which workstream owns this contract
  version: 1
```

Each contract has a markdown file documenting the interface:

```markdown
# API Contract v1

## Request Format
...

## Response Format
...

## Error Cases
...
```

Use `npm run spec:finalize` to validate registry references.

---

## Summary

This system prioritizes:
- **Durable context**: Memory Bank keeps knowledge close to code
- **Visible gates**: Specs enforce clarity before implementation
- **Spec-first discipline**: Agents follow the four-phase loop with explicit approval gates

### Key Takeaways for Operators

1. **Choose the right workflow upfront** — ask the agent when in doubt
2. **Approve specs before execution** — this is your control point
3. **Trust the quality gates** — `npm run agent:finalize` must pass before shipping
4. **Treat Memory Bank as canonical** — changes should be reviewed like code
5. **Test traceability is non-negotiable** — every AC needs evidence

For questions or issues, consult:
- Workflow files: `agents/workflows/*.md`
- Memory Bank: `agents/memory-bank/*.md`
- Task spec guide: `agents/memory-bank/task-spec.guide.md`

---

**End of Operator's Guide**

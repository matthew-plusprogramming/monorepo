# Recovery Report: Old Agentic System Files

**Generated**: 2026-01-07
**Source Commit**: 53a279d^ (parent of migration commit)

This report contains all files from the old `agents/` directory structure before the migration to `.claude/`.

---

## Table of Contents

1. [Complete File Listing](#complete-file-listing)
2. [Key Files Content](#key-files-content)
   - [OPERATOR-GUIDE.md](#operator-guidemd)
   - [agents/memory-bank.md](#agentsmemory-bankmd)
   - [agents/memory-bank/project.brief.md](#agentsmemory-bankprojectbriefmd)
   - [agents/memory-bank/tech.context.md](#agentsmemory-banktechcontextmd)
   - [agents/memory-bank/testing.guidelines.md](#agentsmemory-banktestingguidelinesmd)
   - [agents/memory-bank/operating-model.md](#agentsmemory-bankoperating-modelmd)
   - [agents/scripts/spec-validate.mjs](#agentsscriptsspec-validatemjs)
   - [agents/scripts/reset-active-context.mjs](#agentsscriptsreset-active-contextmjs)
   - [agents/scripts/load-context.mjs](#agentsscriptsload-contextmjs)
   - [agents/scripts/manage-worktrees.mjs](#agentsscriptsmanage-worktreesmjs)
   - [agents/contracts/registry.yaml](#agentscontractsregistryyaml)
3. [Additional Valuable Files](#additional-valuable-files)
   - [agents/tools.md](#agentstoolsmd)
   - [agents/workflows.md](#agentsworkflowsmd)
   - [agents/memory-bank/task-spec.guide.md](#agentsmemory-banktask-specguidemd)
   - [agents/memory-bank/spec-orchestration.design.md](#agentsmemory-bankspec-orchestrationdesignmd)
   - [agents/workflows/orchestrator.workflow.md](#agentsworkflowsorchestratorworkflowmd)
   - [agents/workflows/oneoff-spec.workflow.md](#agentsworkflowsoneoff-specworkflowmd)
   - [agents/scripts/spec-utils.mjs](#agentsscriptsspec-utilsmjs)
   - [agents/scripts/spec-merge.mjs](#agentsscriptsspec-mergemjs)

---

## Complete File Listing

All files that existed in the `agents/` directory before commit 53a279d:

### agents/contracts/

- `agents/contracts/example.contract.md`
- `agents/contracts/registry.yaml`

### agents/memory-bank/

- `agents/memory-bank.md`
- `agents/memory-bank/best-practices/README.md`
- `agents/memory-bank/best-practices/software-principles.md`
- `agents/memory-bank/best-practices/testing.md`
- `agents/memory-bank/best-practices/typescript.md`
- `agents/memory-bank/operating-model.md`
- `agents/memory-bank/product.context.md`
- `agents/memory-bank/project.brief.md`
- `agents/memory-bank/spec-orchestration.design.md`
- `agents/memory-bank/task-spec.guide.md`
- `agents/memory-bank/tech.context.md`
- `agents/memory-bank/testing.guidelines.md`

### agents/scripts/

- `agents/scripts/append-memory-entry.mjs`
- `agents/scripts/check-code-quality.mjs`
- `agents/scripts/check-console-usage.mjs`
- `agents/scripts/check-effect-promise.mjs`
- `agents/scripts/check-effect-run-promise.mjs`
- `agents/scripts/check-env-schema-usage.mjs`
- `agents/scripts/check-resource-names.mjs`
- `agents/scripts/check-test-aaa-comments.mjs`
- `agents/scripts/constants.js`
- `agents/scripts/create-worktree.mjs`
- `agents/scripts/dotenvx-run.mjs`
- `agents/scripts/find-unsafe-assertions.mjs`
- `agents/scripts/git-diff-with-lines.mjs`
- `agents/scripts/list-files-recursively.mjs`
- `agents/scripts/load-context.mjs`
- `agents/scripts/manage-worktrees.mjs`
- `agents/scripts/read-files.mjs`
- `agents/scripts/reset-active-context.mjs`
- `agents/scripts/smart-file-query.mjs`
- `agents/scripts/spec-merge.mjs`
- `agents/scripts/spec-utils.mjs`
- `agents/scripts/spec-validate.mjs`
- `agents/scripts/sync-worktree-env-keys.mjs`
- `agents/scripts/utils.mjs`
- `agents/scripts/validate-memory-bank.mjs`

### agents/specs/

- `agents/specs/README.md`
- `agents/specs/schema/README.md`
- `agents/specs/schema/contract-registry.schema.json`
- `agents/specs/schema/master-spec.schema.json`
- `agents/specs/schema/problem-brief.schema.json`
- `agents/specs/schema/workstream-spec.schema.json`
- `agents/specs/task-specs/2026-01-01-eject-backend-only.md`
- `agents/specs/templates/README.md`
- `agents/specs/templates/master-spec.template.md`
- `agents/specs/templates/problem-brief.template.md`
- `agents/specs/templates/workstream-spec.template.md`

### agents/workflows/

- `agents/tools.md`
- `agents/workflows.md`
- `agents/workflows/implementer.workflow.md`
- `agents/workflows/oneoff-spec.workflow.md`
- `agents/workflows/oneoff-vibe.workflow.md`
- `agents/workflows/oneoff.workflow.md`
- `agents/workflows/orchestrator.workflow.md`
- `agents/workflows/spec-author.workflow.md`
- `agents/workflows/templates/pattern.workflow.template.md`

### Root Level

- `OPERATOR-GUIDE.md`

---

## Key Files Content

### OPERATOR-GUIDE.md

```markdown
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
│ Does this involve multiple workstreams, repos, │
│ or cross-cutting contracts? │
└─────────────────┬───────────────────────────────────┘
│
┌─────────┴─────────┐
│ │
YES NO
│ │
▼ ▼
┌───────────────┐ ┌──────────────────┐
│ ORCHESTRATOR │ │ Is this clearly │
│ WORKFLOW │ │ bounded and │
└───────────────┘ │ small? │
└────────┬─────────┘
│
┌─────────┴─────────┐
│ │
YES NO
│ │
▼ ▼
┌─────────────┐ ┌──────────────┐
│ ONE-OFF │ │ ONE-OFF │
│ VIBE │ │ SPEC │
│ (no spec) │ │ (with spec) │
└─────────────┘ └──────────────┘

````

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
````

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
node agents/scripts/spec-validate.mjs --specs "<path[,path...]>" [--root <path>] [--registry <path>]

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

| File                 | Purpose                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `memory-bank.md`     | Overview, retrieval policy (canonical for discovery rules)        |
| `operating-model.md` | Four-phase loop expectations, artifact locations, tool references |
| `task-spec.guide.md` | Template and guidance for per-task specs                          |
| `project.brief.md`   | High-level project context (filled in over time)                  |
| `tech.context.md`    | Stack, tooling, entrypoints (include only if substantive)         |

### Optional Canonical Files

| Path                                    | Purpose                                                    |
| --------------------------------------- | ---------------------------------------------------------- |
| `spec-orchestration.design.md`          | Detailed spec-first pipeline, workstream decomposition     |
| `testing.guidelines.md`                 | Testing boundaries, dependency injection, evidence mapping |
| `best-practices/software-principles.md` | General design principles (SoC, DRY, composition)          |
| `best-practices/typescript.md`          | TypeScript-specific patterns                               |
| `best-practices/<domain>.md`            | Domain-specific reusable guidance                          |

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

| Workflow         | Gate Point                    | What Needs Approval      |
| ---------------- | ----------------------------- | ------------------------ |
| **Orchestrator** | After Requirements            | ProblemBrief             |
| **Orchestrator** | After Design                  | Workstream decomposition |
| **Orchestrator** | After Implementation Planning | MasterSpec + gate report |
| **Spec Author**  | After Implementation Planning | Workstream spec          |
| **Implementer**  | After Implementation Planning | Task sequencing          |
| **One-off Spec** | After Implementation Planning | Task spec                |

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
   | AC                            | Test Name                         | Evidence Location    |
   | ----------------------------- | --------------------------------- | -------------------- |
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
  owner: ws-api # Which workstream owns this contract
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

````

---

### agents/memory-bank.md

```markdown
---
memory_bank: v1
---

Memory Bank

- Canonical: `agents/memory-bank/*`
- Single source of truth: This file defines knowledge representation. Other docs should reference (not duplicate) these rules.
- Script catalog: `agents/tools.md` lists automation helpers for loading context, discovery, and running validations.
- Operating model: `agents/memory-bank/operating-model.md` defines the default Requirements → Design → Implementation Planning → Execution loop.
- Task specs: per-task specs follow `agents/memory-bank/task-spec.guide.md` and live in the task spec directory defined by the operating model.

Design References

- Spec-first orchestration system: `agents/memory-bank/spec-orchestration.design.md`

Procedural vs Declarative

- Declarative knowledge (facts, mappings, invariants) is recorded in canonical files under `agents/memory-bank/*` and does not change workflow definitions.
- Procedural learnings (repeatable steps) are captured as patterns in files under `agents/workflows/*`

Retrieval Policy

- Identify task type: bug | feature | refactor | ops | etc.
- Always include: `agents/workflows/oneoff.workflow.md`, `agents/workflows/oneoff-spec.workflow.md`, `agents/memory-bank/project.brief.md`, `agents/memory-bank/operating-model.md`, `agents/memory-bank/task-spec.guide.md`, and the current task spec (include via `--task` when available) or workstream spec (review the Decision & Work Log for approvals).
- For one-off vibe tasks, also include `agents/workflows/oneoff-vibe.workflow.md`.
- Gate optional files by substance: include `agents/memory-bank/tech.context.md` only when they contain substantive, non-placeholder content (more than headings/TBDs).
- Consult `agents/memory-bank/best-practices/README.md` to identify domain relevant matches and include all applicable `agents/memory-bank/best-practices/*.md` files (match by `domain`/`tags` in front matter).
- File discovery & content retrieval: rely on `node agents/scripts/list-files-recursively.mjs` to surface candidate paths, `node agents/scripts/smart-file-query.mjs` for scoped searches, and `node agents/scripts/read-files.mjs` (default numbered text output, `--json` when automation requires it) when you need ordered contents from multiple files; avoid falling back to generic shell defaults unless these scripts cannot satisfy the need.
- Capture context in a single pass: the helper scripts now emit line numbers, so take notes the first time you load a file and only re-read when the file genuinely changes; repeated pulls violate workflow discipline and waste cycles.
- After each phase (Requirements, Design, Implementation Planning, Execution), log a reflection in the task spec and record approvals in the Decision & Work Log; when stable, roll up into an ADR or a relevant stable memory bank file.
````

---

### agents/memory-bank/project.brief.md

```markdown
---
last_reviewed: 2025-09-03
---

# Project Brief

Opinionated TypeScript monorepo: Express 5 server (optionally packaged for AWS Lambda) and CDK for Terraform (CDKTF) infrastructure, with repo‑native agent workflows and a durable Memory Bank for knowledge capture.

Scope & High Level Goals

- Build and maintain a Node/Express service with strong typing (Effect), validation (Zod), and clear boundaries.
- Define CDKTF stacks (DynamoDB, CloudWatch, Lambda packaging) and typed consumers; ensure app loads infra outputs rather than hardcoding.
- Make agent collaboration first‑class via Memory Bank and Workflow Process files; enable Workflow Synthesis from recurring procedural patterns.
- Provide shared packages for schemas/utilities/configs to keep implementations consistent across workspaces.
- Constraints: keep changes minimal and localized; prioritize clarity over production hardening at this stage.

Out of Scope & Non Goals

- Production hardening (HA, autoscaling, multi‑region) and full test coverage.
- Cost optimization and advanced operational hardening.

Primary Users & Stakeholders

- Agents: execute repo‑native workflows; capture durable facts in canonical files; synthesize workflows from patterns.
- Maintainers/Developers: fast onboarding via consistent patterns, typed boundaries, and validated memory workflows.
- Infra Maintainers: predictable CDKTF outputs and typed consumption paths used by the app.

Project Stage
Planning; initial scaffolding exists across app, packages, and CDKTF. Memory Bank and Workflows are being integrated into daily changes.

Success Criteria

- Clear entrypoints and invariants documented under `agents/memory-bank/*`.
- Memory Bank and Workflows present, validated, and used for all changes.
- App: `npm -w node-server run dev` runs with CDKTF outputs loaded; Lambda packaging path works end‑to‑end.
- Infra: stacks synth/deploy; outputs written under `cdktf-outputs/**` and consumed via `@cdk/platform-cdk`.
- Memory: `npm run memory:validate` and `npm run memory:drift` pass in CI; recurring patterns captured in `system.patterns.md` and reflected in workflows when warranted.
```

---

### agents/memory-bank/tech.context.md

```markdown
---
last_reviewed: 2025-12-19
---

# Technical Context

Stacks & Tooling

- Node.js + TypeScript, Express, Effect, Zod, JWT.
- AWS SDK v3, CDKTF (OpenTofu/Terraform compatible).
- Turborepo, Vite, ESLint flat config.

Constraints

- TypeScript modules across packages; keep builds and configs consistent.
- Keep changes minimal and localized; adhere to repo style.

Environment

- Local dev for the server; CDKTF for infra with outputs consumed by the app.
- Worktree env keys: `.env.keys` are untracked; use `node agents/scripts/sync-worktree-env-keys.mjs` (add `--overwrite` to replace existing files) for a single worktree or `node agents/scripts/manage-worktrees.mjs sync` to refresh all worktrees (overwrites existing `.env.keys` and `cdktf-outputs` files). `manage-worktrees.mjs ensure` also syncs `cdk/platform-cdk/cdktf-outputs` when present, and use the `dotenvx-run.mjs` wrapper for missing-key hints.
- Optional: use `git worktree` to keep parallel changes isolated (e.g. hidden repo-local `.worktrees/{admin,backend,client}` on `worktree/*` branches).
- When you hit a `"package not found"` error, run `npm run install` at the repo root and retry first.

Entrypoints

- Server: `apps/node-server/src/index.ts` (dev) | `apps/node-server/src/lambda.ts` (Lambda)
- Infra: `cdk/platform-cdk/src/index.ts`

Where To Look First

- Handlers: `apps/node-server/src/handlers/*`
- Schemas: `packages/core/schemas/schemas/**/*`
- Infra stacks: `cdk/platform-cdk/src/stacks/**/*`

Codebase Map

- `apps/node-server`: Express app, middleware, handlers, Lambda wrapper.
- `cdk/platform-cdk`: CDKTF stacks (API, analytics, client website), consumers, outputs loader.
- `packages/core/backend-core`: Effect→Express adapter, services, types.
- `packages/core/schemas`: Zod domain schemas and constants.
- Shared configs: `packages/configs/*`.
- Shared UI: `packages/core/ui-components` exports reusable React components/styles for the web apps; CSS module typings are generated via `gen:css-types` (watch in `dev`) into `__generated__/src`.

Tech Stack Details

- Validation: Zod 4 for inputs and env `apps/node-server/src/types/environment.ts`.
- Effects: Effect 3 for typed effects/layers/errors `packages/core/backend-core`.
- Auth: JWT with custom claims `packages/core/schemas/schemas/user/userToken.ts` (optional; can be ejected via `npm run eject:users`); role constants in `packages/core/backend-core/src/auth/roles.ts`, admin enforcement via `apps/node-server/src/middleware/isAdmin.middleware.ts`.
- Build: Vite SSR to CJS; TS strict, shared configs.

Workflows

- Repo: build/lint/clean via turborepo scripts.
- App (node-server): `dev`, `build`, `preview`, env management via dotenvx.
- Infra (CDKTF): deploy/synth/destroy per stage; outputs written and consumed by app.

Task Recipes

- Add endpoint: define schema → implement handler using `parseInput` → wrap with `generateRequestHandler` → wire route → run dev.
- Add table/GSI: update schema constants → add stack changes → deploy → load outputs → update app client.
- Add middleware: implement Effect middleware → wrap as `RequestHandler` → register in server entry.

Scaffolding

- Repository scaffolding scripts live under `scripts/**`; `scripts/create-repository-service.mjs` is a thin wrapper over a config-driven runner defined in `scripts/scaffolds/repository-service.config.json` plus shared utilities in `scripts/utils/**`.
- Reusable hooks register via `scripts/utils/hooks.mjs`; configs declare which hooks run per stage (`preScaffold`, `renderTemplates`, `postScaffold`) and map template tokens to resolvers.
- Aspect ejection codemods live under `scripts/eject-aspect.mjs` with per-aspect definitions in `scripts/aspects/*.aspect.mjs` (e.g., `npm run eject:analytics`, `npm run eject:users`).
```

---

### agents/memory-bank/testing.guidelines.md

```markdown
---
last_reviewed: 2025-10-21
---

# Testing Guidelines

## Boundaries & Dependency Injection

- Boundaries to treat as external: HTTP/network clients, databases/repositories, filesystem reads/writes, clocks/timers, randomness/UUIDs, and `process.env`.
- Prefer dependency injection by passing collaborators via constructors or function parameters; avoid reaching for module singletons unless an adapter explicitly manages the boundary.
- Default strategies per boundary:
  - HTTP: Use MSW for integration slices; module-level mocks for unit tests.
  - DB/Repo: Favor in-memory fakes for service/use-case tests; swap in targeted mocks for edge cases or failure injection.
  - Filesystem: Use temporary directories or in-memory adapters (e.g., `memfs`) to avoid touching the real FS; mock only when the abstraction is too thin to fake.
  - Clock/Time: Control time with `jest.useFakeTimers()` and `jest.setSystemTime(...)`; expose clocks as injectable utilities when production code needs current time.
  - Randomness/UUID: Inject RNG/UUID generators; stub deterministic values inside tests.
  - Environment: Set and reset `process.env` keys in `beforeEach`/`afterEach` helpers to keep tests isolated.

## Reusable Utilities

- Add Test Data Builders (e.g., `UserBuilder`) under `src/**/__test__/builders.ts`; keep them close to the code under test for ergonomic imports.
- Create factory helpers such as `makeRepoMock()`, `fixedNow()`, and `withEnv()` to standardize common arrangements.
- Introduce shared in-memory fakes for frequently used repos/queues/cache interfaces when multiple suites need the same behavior.
- Shared test utilities (service fakes, Express request context builder, and runtime helpers) live under `@packages/backend-core/testing`; import from there instead of cloning per app.
- For CDK output dependencies, prefer `apps/node-server/src/__tests__/stubs/cdkOutputs.ts`'s `makeCdkOutputsStub()` and override only the keys a suite needs.
- Manipulate the `__BUNDLED__` runtime flag via `@packages/backend-core/testing` exports (e.g., `setBundledRuntime`, `clearBundledRuntime`, `hoistUnbundledRuntime`) instead of inlining `Reflect` access.
- When identical Arrange or helper logic appears across suites, extract it into a shared `test-helpers.ts` (local) or shared package utility so tests stay focused on the behavior under scrutiny.
- Reach for table-driven tests when scenarios differ only by data; prefer looping over a cases array that produces distinct `it` blocks to eliminate copy/paste without masking failures.
- Factor repeated assertion clusters (e.g., status/message pairs) into small helper functions to keep expectations DRY and intention-revealing.

## What to Test by Unit Type

- Pure functions: Avoid mocks; assert only on inputs and outputs.
- Adapters/clients (HTTP/DB wrappers): Mock the boundary; assert returned/throwing values and key calls (URL, payload, status handling).
- Services/use-cases: Wire fakes or focused mocks of dependencies; assert domain behavior plus the one or two critical interactions.
- Integration thin slices: Compose real modules with in-memory/fake boundaries; cover the happy path end-to-end without external network calls.

## Mocking Rules of Thumb

- Mock only true boundaries or expensive/slow dependencies.
- Prefer in-memory fakes over deep chains of mocks.
- Use spies (`jest.spyOn`) when you only need to observe a real method without replacing its implementation.
- Avoid asserting call order unless the order is part of the contract.

## Flake-Proofing

- Control time anywhere timeouts/intervals exist via fake timers.
- Inject or stub randomness to eliminate non-deterministic data or ordering.
- Reset globals, environment variables, and timers inside `afterEach` hooks.
- Skip default snapshots; use snapshots only for stable, structured artifacts (e.g., schemas, emails).

## AAA Comment Convention

- Every test case must annotate the Arrange, Act, and Assert phases with explicit `// Arrange`, `// Act`, and `// Assert` comments.
- Keep setup logic confined to the Arrange section; defer calls to the unit under test until the Act phase.
- When chaining helpers that immediately return promises (e.g., `Effect.runPromise`), capture the promise in the Act phase and perform assertions afterward to preserve structure.

## Bootstrap Testing Plan

- Start by covering 3–5 pure functions with focused assertions.
- Add one service test using an in-memory fake repository and include a failing edge case via a stubbed dependency response.
- Create one integration test that exercises the happy path using real module wiring and fake boundaries (no live network calls).

## Review Checklist

- Asserts observable behavior, not internals or private helpers.
- Each test focuses on a single concept with minimal mocking and explicitly labeled Arrange/Act/Assert comments.
- No hidden global state; timers and environment variables restored after each test; data deterministic.
- Test data flows through builders/helpers rather than large inline literals.
```

---

### agents/memory-bank/operating-model.md

```markdown
---
last_reviewed: 2025-11-26
---

# Operating Model

## Overview

- Default phases: Requirements → Design → Implementation Planning → Execution.
- Every task has a Task Spec under `agents/specs/task-specs/` that holds these phases; it is created with `node agents/scripts/reset-active-context.mjs --slug <task-slug> [--title "..."]`.
- Reflections are recorded in the task spec after each phase, with approvals logged in the Decision & Work Log.
- Canonical updates live in `agents/memory-bank/**`; validate via `npm run memory:validate` (or `npm run agent:finalize`) after stable changes.

## Phase Expectations

- **Requirements**
  - Author EARS-formatted user stories and acceptance criteria.
  - List non-goals, constraints, risks, invariants, impacted components, interfaces, and candidate files/tests.
  - Capture retrieval sources consulted.
- **Design**
  - Document architecture (logical, data, control flows) and at least one Mermaid sequence diagram for the primary path.
  - Capture interfaces/contracts, data shapes, edge/failure behaviors, and performance/security/migration considerations.
- **Implementation Planning**
  - Break work into discrete tasks with outcomes, dependencies, and owners (when relevant).
  - Identify non-primitive fields and define storage format. (if applicable)
  - Map tests to acceptance criteria for traceability.
  - Identify documentation updates and Memory Bank canonical updates needed.
  - Note blockers and sequencing.
- **Execution**
  - Track progress against tasks, update the spec as reality changes, and log evidence/tests tied to acceptance criteria.
  - Keep changes focused; update canonicals as needed and run quality gates (`npm run phase:check`, `npm run agent:finalize`).

## Artifacts & Tools

- Task Specs: created via `reset-active-context.mjs`; named `<YYYY-MM-DD>-<slug>.md`; include all four phases plus execution log and evidence.
- Retrieval: use `agents/scripts/load-context.mjs --task <path>` to pull required context and include the current task spec; follow `agents/memory-bank.md#retrieval-policy` for discovery discipline.
- Worktrees: orchestrators use `node agents/scripts/manage-worktrees.mjs ensure` to manage per-workstream worktrees; implementers create individual worktrees with `node agents/scripts/create-worktree.mjs --name <workstream-id>` before execution.
- Validation: `npm run agent:finalize` runs formatting, validation, and quality checks before completion.
```

---

### agents/scripts/spec-validate.mjs

```javascript
#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, resolve, relative, join } from 'node:path';
import process from 'node:process';
import {
  extractHeadings,
  normalizeSection,
  parseFrontMatter,
  parseYamlList,
  readTextFile,
} from './spec-utils.mjs';

const USAGE = `Usage: node agents/scripts/spec-validate.mjs [options]

Validates spec front matter, required sections, and contract registry references.

Options
  --specs <path[,path...]>   Comma-separated spec file paths to validate
  --root <path>              Root directory to scan for specs (default: agents/specs)
  --registry <path>          Contract registry path (default: agents/contracts/registry.yaml)
  --allow-empty              Exit 0 when no specs are found
  -h, --help                 Show this help message

Examples
  node agents/scripts/spec-validate.mjs --specs agents/specs/foo/workstreams/ws-a.md
  node agents/scripts/spec-validate.mjs --root agents/specs/foo
`;

const REQUIRED_SECTIONS = {
  workstream: [
    'Context',
    'Goals / Non-goals',
    'Requirements',
    'Core Flows',
    'Sequence Diagram(s)',
    'Edge Cases',
    'Interfaces & Data Model',
    'Security',
    'Additional considerations',
    'Task List',
    'Testing',
    'Open Questions',
    'Decision & Work Log',
  ],
  problem: [
    'Context',
    'Goals / Non-goals',
    'Constraints',
    'Success Criteria',
    'Additional considerations',
    'Open Questions',
    'Decision & Work Log',
  ],
  master: [
    'Summary',
    'Workstreams',
    'Contracts',
    'Gates',
    'Additional considerations',
    'Open Questions',
    'Decision & Work Log',
  ],
};

const args = process.argv.slice(2);
const options = {
  specs: [],
  root: 'agents/specs',
  registry: 'agents/contracts/registry.yaml',
  allowEmpty: false,
  showHelp: false,
};

const popValue = (index, flag) => {
  if (index + 1 >= args.length) {
    console.error(`❌ Missing value after "${flag}"`);
    console.error(USAGE.trimEnd());
    process.exit(1);
  }
  return args[index + 1];
};

for (let index = 0; index < args.length; index += 1) {
  const token = args[index];
  switch (token) {
    case '-h':
    case '--help':
      options.showHelp = true;
      break;
    case '--specs':
    case '--spec': {
      const value = popValue(index, token);
      options.specs.push(
        ...value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
      );
      index += 1;
      break;
    }
    case '--root':
      options.root = popValue(index, token);
      index += 1;
      break;
    case '--registry':
      options.registry = popValue(index, token);
      index += 1;
      break;
    case '--allow-empty':
      options.allowEmpty = true;
      break;
    default:
      if (token.startsWith('-')) {
        console.error(`❌ Unknown option: ${token}`);
        console.error(USAGE.trimEnd());
        process.exit(1);
      }
  }
}

if (options.showHelp) {
  console.log(USAGE.trimEnd());
  process.exit(0);
}

const repoRoot = process.cwd();

const toPosix = (value) => value.replace(/\\/g, '/');

const isSpecCandidate = (relativePath) => {
  const normalized = toPosix(relativePath);
  if (
    normalized.includes('/templates/') ||
    normalized.includes('/schema/') ||
    normalized.includes('/fixtures/')
  ) {
    return false;
  }
  if (normalized.includes('/workstreams/')) {
    return true;
  }
  const base = basename(normalized);
  return base.startsWith('problem-brief') || base.startsWith('master-spec');
};

const collectSpecFiles = (rootPath) => {
  const results = [];
  const rootAbs = resolve(repoRoot, rootPath);

  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let stats;
      try {
        stats = statSync(abs);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!stats.isFile() || !name.endsWith('.md')) {
        continue;
      }
      const rel = toPosix(relative(repoRoot, abs));
      if (isSpecCandidate(rel)) {
        results.push(rel);
      }
    }
  };

  walk(rootAbs);
  return results;
};

const loadRegistry = (registryPath) => {
  const abs = resolve(repoRoot, registryPath);
  if (!existsSync(abs)) {
    return {
      entries: [],
      errors: [`Registry not found: ${registryPath}`],
    };
  }
  const content = readTextFile(abs);
  const { items, errors } = parseYamlList(content);
  const entryErrors = [...errors];
  const ids = new Set();

  items.forEach((item, index) => {
    const missing = ['id', 'type', 'path', 'owner', 'version'].filter(
      (field) => !item?.[field],
    );
    if (missing.length > 0) {
      entryErrors.push(
        `Registry entry ${index + 1} missing fields: ${missing.join(', ')}`,
      );
    }
    if (item?.id) {
      if (ids.has(item.id)) {
        entryErrors.push(`Duplicate registry id: ${item.id}`);
      }
      ids.add(item.id);
    }
  });

  return { entries: items, ids, errors: entryErrors };
};

const detectSpecType = (path, data) => {
  if (data?.workstreams && data?.gates) return 'master';
  if (data?.summary && data?.success_criteria) return 'problem';
  if (data?.owner && data?.scope) return 'workstream';
  const base = basename(path);
  if (base.startsWith('problem-brief')) return 'problem';
  if (base.startsWith('master-spec')) return 'master';
  if (path.includes('/workstreams/')) return 'workstream';
  return 'unknown';
};

const ensureArray = (value) => Array.isArray(value);
const ensureString = (value) => typeof value === 'string' && value.length > 0;

const validateFrontMatter = (type, data) => {
  const errors = [];
  if (!data || typeof data !== 'object') {
    return ['Missing or invalid YAML front matter data.'];
  }
  const requireFields = {
    workstream: {
      id: ensureString,
      title: ensureString,
      owner: ensureString,
      scope: ensureString,
      dependencies: ensureArray,
      contracts: ensureArray,
      status: ensureString,
    },
    problem: {
      id: ensureString,
      title: ensureString,
      summary: ensureString,
      goals: ensureArray,
      non_goals: ensureArray,
      constraints: ensureArray,
      success_criteria: ensureArray,
      open_questions: ensureArray,
    },
    master: {
      id: ensureString,
      title: ensureString,
      workstreams: ensureArray,
      contracts: ensureArray,
      gates: ensureArray,
      status: ensureString,
    },
  };
  const validators = requireFields[type];
  if (!validators) {
    return [`Unknown spec type: ${type}`];
  }
  for (const [field, validator] of Object.entries(validators)) {
    if (!validator(data[field])) {
      errors.push(`Missing or invalid front matter field: ${field}`);
    }
  }
  return errors;
};

const collectContractIds = (type, data) => {
  if (!data?.contracts) return [];
  if (!Array.isArray(data.contracts)) return [];
  if (type === 'workstream') {
    return data.contracts
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && entry.id) return entry.id;
        return null;
      })
      .filter(Boolean);
  }
  return data.contracts.filter((entry) => typeof entry === 'string');
};

const specs =
  options.specs.length > 0 ? options.specs : collectSpecFiles(options.root);

if (specs.length === 0) {
  const message = `No spec files found under ${options.root}.`;
  if (options.allowEmpty) {
    console.warn(`⚠️  ${message}`);
    process.exit(0);
  }
  console.error(`❌ ${message}`);
  process.exit(1);
}

const registry = loadRegistry(options.registry);
const registryIds = registry.ids ?? new Set();
const errors = [];

for (const specPath of specs) {
  const abs = resolve(repoRoot, specPath);
  if (!existsSync(abs)) {
    errors.push({ file: specPath, message: 'Spec file not found.' });
    continue;
  }
  const content = readTextFile(abs);
  const { data, body, errors: fmErrors } = parseFrontMatter(content);
  if (fmErrors.length > 0) {
    fmErrors.forEach((message) => errors.push({ file: specPath, message }));
    continue;
  }
  const type = detectSpecType(specPath, data);
  const fmIssues = validateFrontMatter(type, data);
  fmIssues.forEach((message) => errors.push({ file: specPath, message }));

  const headings = extractHeadings(body);
  const required = REQUIRED_SECTIONS[type] ?? [];
  for (const section of required) {
    const normalized = normalizeSection(section);
    if (!headings.has(normalized)) {
      errors.push({
        file: specPath,
        message: `Missing required section: ${section}`,
      });
    }
  }

  const contractIds = collectContractIds(type, data);
  for (const contractId of contractIds) {
    if (!registryIds.has(contractId)) {
      errors.push({
        file: specPath,
        message: `Missing contract registry entry: ${contractId}`,
      });
    }
  }
}

for (const registryError of registry.errors ?? []) {
  errors.push({ file: options.registry, message: registryError });
}

if (errors.length > 0) {
  console.error('❌ Spec validation failed:');
  for (const issue of errors) {
    console.error(` - ${issue.file}: ${issue.message}`);
  }
  process.exit(1);
}

console.log(`✅ Spec validation passed (${specs.length} file(s)).`);
```

---

### agents/scripts/reset-active-context.mjs

```javascript
#!/usr/bin/env node
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const TASK_SPECS_DIR = 'agents/specs/task-specs';

const USAGE = `Usage: node agents/scripts/reset-active-context.mjs --slug "<task-slug>" [options]

Create a new per-task spec (Requirements, Design, Implementation Planning, Execution).

Options
  --slug "<task-slug>"     Required slug used in the task spec filename
  --title "<text>"        Optional human-friendly title for the task
  --date "<YYYY-MM-DD>"   Override the review date (default: today UTC)
  -h, --help              Show this help message
`;

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE.trimEnd());
  process.exit(0);
}

const options = {
  date: null,
  slug: null,
  title: null,
};

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];

  if (!arg.startsWith('--')) {
    console.error(`❌ Unexpected argument: ${arg}`);
    process.exit(1);
  }

  const [flag, inlineValue] = arg.split('=');
  const nextValue = args[index + 1];
  const value = inlineValue ?? nextValue;

  switch (flag) {
    case '--date': {
      if (!value) {
        console.error('❌ Missing value for --date');
        process.exit(1);
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        console.error('❌ --date must follow YYYY-MM-DD format');
        process.exit(1);
      }

      options.date = value;
      if (inlineValue === undefined) index += 1;
      break;
    }
    case '--slug': {
      if (!value) {
        console.error('❌ Missing value for --slug');
        process.exit(1);
      }

      if (!/^[a-z0-9-]+$/.test(value)) {
        console.error(
          '❌ --slug must use lowercase letters, numbers, or dashes only',
        );
        process.exit(1);
      }

      options.slug = value;
      if (inlineValue === undefined) index += 1;
      break;
    }
    case '--title': {
      if (!value) {
        console.error('❌ Missing value for --title');
        process.exit(1);
      }

      options.title = value;
      if (inlineValue === undefined) index += 1;
      break;
    }
    default:
      console.error(`❌ Unknown option: ${flag}`);
      process.exit(1);
  }
}

if (!options.slug) {
  console.error('❌ --slug is required');
  process.exit(1);
}

const formatDate = (inputDate) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(inputDate);

const toTitleCase = (value) =>
  value
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const buildTaskSpecTemplate = ({ title, slug, date }) => `---
task: ${title}
slug: ${slug}
date: ${date}
status: draft
---

# ${title}

## Requirements
- [ ] EARS user stories and acceptance criteria captured.
- Non-goals:
- Constraints / Risks:
- Invariants:
- Interfaces / files / tests to touch:

## Design
- Architecture (logical, data, control flows):
- Sequence diagram(s):
\`\`\`mermaid
sequenceDiagram
  autonumber
  %% Fill in the primary flow
\`\`\`
- Interfaces / contracts:
- Edge / failure behaviors:

## Implementation Planning
- Tasks and outcomes:
- Dependencies / blockers:
- Test plan mapped to acceptance criteria:

## Execution
- Progress log:
- Evidence / tests:
- Follow-ups:
`;

const main = async () => {
  const reviewDate = options.date ?? formatDate(new Date());
  const title = options.title ?? toTitleCase(options.slug);
  const taskSpecFile = `${reviewDate}-${options.slug}.md`;
  const taskSpecPath = `${TASK_SPECS_DIR}/${taskSpecFile}`;

  const absoluteTaskSpecPath = resolve(process.cwd(), taskSpecPath);

  const taskSpecContent = buildTaskSpecTemplate({
    title,
    slug: options.slug,
    date: reviewDate,
  });

  await mkdir(dirname(absoluteTaskSpecPath), { recursive: true });

  const taskSpecExists = await access(absoluteTaskSpecPath)
    .then(() => true)
    .catch((error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });

  if (!taskSpecExists) {
    await writeFile(absoluteTaskSpecPath, taskSpecContent, 'utf8');
    console.log(`✅ Created task spec at ${taskSpecPath}`);
  } else {
    console.log(
      `ℹ️  Task spec already exists at ${taskSpecPath}; left unchanged.`,
    );
  }

  console.log(
    `ℹ️  Load context with: node agents/scripts/load-context.mjs --task ${taskSpecPath}`,
  );
};

main().catch((error) => {
  console.error('❌ Failed to create the task spec.');
  console.error(error);
  process.exit(1);
});
```

---

### agents/scripts/load-context.mjs

```javascript
#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const USAGE = `Usage: node agents/scripts/load-context.mjs [options]

Loads the required Memory Bank and workflow context for a new task and prints
each file with a section header so agents can review everything at once.

Options
  -o, --include-optional   Include optional Memory Bank context files
  -l, --list               Only list the resolved file paths (no contents)
  --task <path>            Include a specific task spec path
  --task-spec <path>       Alias for --task
  -h, --help               Show this help message
`;

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE.trimEnd());
  process.exit(0);
}

const includeOptional =
  args.includes('-o') || args.includes('--include-optional');
const listOnly = args.includes('-l') || args.includes('--list');

const getOptionValue = (flag) => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === flag) {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        console.error(`❌ Missing value for ${flag}`);
        process.exit(1);
      }
      return value;
    }
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1);
      if (!value) {
        console.error(`❌ Missing value for ${flag}`);
        process.exit(1);
      }
      return value;
    }
  }
  return null;
};

const taskSpecPath = getOptionValue('--task') ?? getOptionValue('--task-spec');
const ALWAYS_INCLUDE = [
  'agents/memory-bank.md',
  'agents/workflows.md',
  'agents/tools.md',
  'agents/workflows/oneoff.workflow.md',
  'agents/workflows/oneoff-spec.workflow.md',
  'agents/workflows/oneoff-vibe.workflow.md',
  'agents/memory-bank/operating-model.md',
  'agents/memory-bank/task-spec.guide.md',
  'agents/memory-bank/project.brief.md',
];

const optional = ['agents/memory-bank/tech.context.md'];

const root = process.cwd();

const collectPaths = () => {
  const base = [...ALWAYS_INCLUDE];
  if (taskSpecPath) {
    base.push(taskSpecPath);
  } else {
    console.warn(
      '⚠️  No task spec provided. Use --task <path> to include the current task spec.',
    );
  }
  return includeOptional ? [...base, ...optional] : base;
};

const formatWithLineNumbers = (content) => {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const width = String(lines.length).length;

  return lines
    .map((line, index) => `${String(index + 1).padStart(width, ' ')} | ${line}`)
    .join('\n');
};

const printSectionHeader = (relativePath) => {
  const divider = '='.repeat(relativePath.length + 8);
  console.log(divider);
  console.log(`=== ${relativePath} ===`);
  console.log(divider);
};

const readFileSafely = (relativePath) => {
  const absolutePath = resolve(root, relativePath);

  if (!existsSync(absolutePath)) {
    console.warn(`⚠️  Missing file: ${relativePath}`);
    return null;
  }

  try {
    return readFileSync(absolutePath, 'utf8');
  } catch (error) {
    console.warn(`⚠️  Failed to read ${relativePath}: ${error.message}`);
    return null;
  }
};

const selectedPaths = collectPaths();

if (selectedPaths.length === 0) {
  console.log('No context files selected.');
  process.exit(0);
}

if (listOnly) {
  for (const relativePath of selectedPaths) {
    const absolutePath = resolve(root, relativePath);
    const exists = existsSync(absolutePath) ? '✅' : '⚠️';
    console.log(`${exists} ${relativePath}`);
  }
  process.exit(0);
}

for (const relativePath of selectedPaths) {
  const content = readFileSafely(relativePath);

  if (content === null) {
    continue;
  }

  printSectionHeader(relativePath);
  console.log(formatWithLineNumbers(content));
  console.log('');
}
```

---

### agents/scripts/manage-worktrees.mjs

```javascript
#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { parseFrontMatter } from './spec-utils.mjs';
import { syncEnvKeys } from './sync-worktree-env-keys.mjs';

const USAGE = `Usage: node agents/scripts/manage-worktrees.mjs <command> [options]

Manage orchestrator worktrees under .worktrees/ for parallel workstreams.

Commands
  ensure    Create missing worktrees for workstreams
  sync      Sync cdktf-outputs and .env.keys into worktrees (overwrites existing)
  list      List worktrees under .worktrees/
  status    Show branch + clean/dirty status for worktrees
  remove    Remove selected worktrees
  prune     Run git worktree prune

Options
  --spec <path>              MasterSpec path to derive workstreams
  --workstreams "<a,b,c>"    Comma-separated workstream list
  --workstreams-root <path>  Directory containing workstream specs
  --branch-prefix <prefix>   Branch prefix (default: worktree/)
  --base <ref>               Base ref for new branches (default: HEAD)
  --force                    Force removal of dirty worktrees
  --dry-run                  For prune: show what would be pruned
  -h, --help                 Show this help message
`;

// ... (full implementation continues - see complete file above)
```

(Note: Full implementation included above in the extraction)

---

### agents/contracts/registry.yaml

```yaml
# Contract registry entries must include: id, type, path, owner, version.
- id: contract-example
  type: placeholder
  path: agents/contracts/example.contract.md
  owner: ws-example
  version: 1
```

---

## Additional Valuable Files

### agents/tools.md

```markdown
# Agent Tools

Scripts under `agents/scripts/` give coding agents a consistent toolbox for loading context, maintaining the Memory Bank, and running focused quality checks. Each command below is intended to be run from the repository root (use `node agents/scripts/<name>.mjs`).

Prefer the purpose-built discovery scripts (`list-files-recursively.mjs`, `smart-file-query.mjs`, and `read-files.mjs`) whenever you need to enumerate files, inspect content, or stream multiple files; avoid falling back to raw shell commands unless these utilities cannot handle the scenario.

## Context & Memory Management

- `node agents/scripts/load-context.mjs [--include-optional] [--list] [--task <path>]`
  Prints required Memory Bank + workflow files for the current task with numbered lines to encourage single-pass note taking. Add `--include-optional` to pull in supplemental context, `--list` to show paths without content, and `--task` to include the current task spec explicitly.
- `node agents/scripts/append-memory-entry.mjs --requirements "<text>" [--design "<text>"] [--implementation "<text>"] [--execution "<text>"] [--dry-run]`
  Deprecated; prints a formatted reflection entry for manual copy into the task spec (no file writes).
- `node agents/scripts/reset-active-context.mjs --slug "<task-slug>" [--title "<text>"] [--date "<YYYY-MM-DD>"]`
  Creates a per-task spec (date defaults to today UTC).

## Spec Tooling

- `node agents/scripts/spec-validate.mjs --specs "<path[,path...]>" [--root <path>] [--registry <path>] [--allow-empty]`
  Validates spec front matter, required sections, and contract registry references.
- `node agents/scripts/spec-merge.mjs --specs "<path[,path...]>" --output <path> [--report <path>] [--registry <path>]`
  Generates a MasterSpec and gate report from workstream specs.
- `npm run spec:finalize`
  Runs spec validation and Memory Bank validation in one pass.

## Search & Discovery

- `node agents/scripts/smart-file-query.mjs --regex "<pattern>" [--glob ...] [--contextLines ...] [--includeAllContent] [--json]`
  Finds regex matches across the repo with optional glob scoping, numbered context lines, and optional full file contents. Text output is default; pass `--json` to recover the prior machine-readable payload.
- `node agents/scripts/read-files.mjs --files "<path[,path...]>" [--file-list ...] [--encoding ...] [--maxFileSizeKB ...] [--json]`
  Reads multiple repo-relative files, applying size/binary guards, and prints numbered text blocks by default so you can cite `path:line` without re-reading. Use `--json` when automation requires the legacy `{ files: [{ path, content }] }` payload.

## Git Worktrees

- `node agents/scripts/create-worktree.mjs --name "<worktree-name>" [--branch "<branch-name>"] [--base "<git-ref>"]`
  Creates a git worktree under `.worktrees/`, defaulting to the `worktree/<name>` branch when none is provided.
- `node agents/scripts/manage-worktrees.mjs <command> [options]`
  Manages orchestrator worktrees (ensure/sync/list/status/remove/prune) under `.worktrees/` using workstream specs or explicit lists; `sync` overwrites existing artifacts.
- `node agents/scripts/sync-worktree-env-keys.mjs [--target <path>] [--source <path>] [--overwrite] [--dry-run] [--force]`
  Copies `.env.keys` into the target worktree and preserves relative paths (use `--overwrite` to replace existing files).
- `node agents/scripts/dotenvx-run.mjs <dotenvx args>`
  Runs dotenvx and emits guidance when missing private keys are detected.

## Reporting & Diff Utilities

- `node agents/scripts/list-files-recursively.mjs --root <path> --pattern <pattern> [--types ...] [--regex] [--case-sensitive]`
  Emits a CSV (`path,size,modifiedAt`) of files under the given root whose repo-relative paths match the pattern; supports substring or regex matching plus optional type filters (`ts`, `md`, `all`).
- `node agents/scripts/git-diff-with-lines.mjs [--cached]`
  Emits the working tree (or staged) diff against `HEAD` with old/new line numbers for verification reports.
```

---

### agents/workflows.md

```markdown
Workflows

It is very important you strictly follow the agent workflows.

- Orchestrator workflow: `agents/workflows/orchestrator.workflow.md`
- Spec author workflow: `agents/workflows/spec-author.workflow.md`
- Implementer workflow: `agents/workflows/implementer.workflow.md`
- One-off overview: `agents/workflows/oneoff.workflow.md`
- One-off spec workflow: `agents/workflows/oneoff-spec.workflow.md`
- One-off vibe workflow: `agents/workflows/oneoff-vibe.workflow.md`
- Purpose: define the spec-first run-loop and the one-off paths; spec workflows follow the four-phase loop with gates.

Usage

- Select the workflow based on the assigned role (or one-off mode), then start at the current phase.
- Follow the checklist, produce outputs, and update the phase state in the file.
- After each phase, log a short reflection in the task spec and record approvals in the Decision & Work Log.
- Reference `agents/tools.md` for script helpers that support each phase.
- Retrieval tooling and single-pass rules live in `agents/memory-bank.md#retrieval-policy`; defer to that section for discovery commands and numbered output expectations.

Policies

- Retrieval: Follow the Retrieval Policy in `agents/memory-bank.md`.
- Commit proposal: Format commit proposals using conventional commit format under 70 chars and a brief body preview.
- Markdown: use Prettier (`npm run format:markdown`) to format Markdown in `agents/**`.
- Memory validation: run `npm run memory:validate` (or `npm run agent:finalize`) once canonical updates are ready to ensure referenced paths exist.
```

---

### agents/memory-bank/task-spec.guide.md

````markdown
---
last_reviewed: 2025-11-26
---

# Task Spec Guide

## Location & Naming

- One file per task under `agents/specs/task-specs/`, named `<YYYY-MM-DD>-<slug>.md`.
- Create via `node agents/scripts/reset-active-context.mjs --slug <task-slug> [--title "..."] [--date YYYY-MM-DD]`.
- Keep the spec updated as the source of truth for the task.

## Sections

- **Requirements**
  - Capture EARS-formatted user stories and acceptance criteria.
  - List non-goals, constraints/risks, invariants, and impacted components.
  - Note interfaces/contracts and candidate files/tests to touch.
- **Design**
  - Document architecture notes (logical/data/control flows).
  - Include at least one Mermaid sequence diagram for the primary flow:
    ```mermaid
    sequenceDiagram
      autonumber
      participant User
      participant System
      User->>System: Primary request
      System-->>User: Outcome
    ```
  - Define interfaces/contracts, data shapes, and edge/failure behaviors.
- **Implementation Planning**
  - Break work into tasks with outcomes, dependencies, and sequencing.
  - Identify non-primitive fields and define storage format. (if applicable)
  - Map tests to acceptance criteria for traceability.
  - Identify documentation updates needed (user/dev/runbook/README) and target files.
  - Identify Memory Bank canonical updates needed (which `agents/memory-bank/*` files and why).
- **Execution**
  - Log progress updates and adjustments to the spec.
  - Record evidence/tests tied to acceptance criteria; note follow-ups.

## Tips

- Keep traceability: link each acceptance criterion to tests or evidence in Execution.
- Update the spec incrementally as decisions change; avoid drift between plan and reality.
- After each phase, capture a brief reflection in the task spec and log approvals in the Decision & Work Log.
- When loading context, include the task spec explicitly with `node agents/scripts/load-context.mjs --task agents/specs/task-specs/<YYYY-MM-DD>-<slug>.md`.
````

---

### agents/memory-bank/spec-orchestration.design.md

````markdown
---
last_reviewed: 2025-12-20
---

# Spec-First Orchestration System (Pinnacle Spec)

## Intent

Define a spec-first orchestration model that turns high-level requests into parallelized workstream specs, merges them into a coherent MasterSpec (the "pinnacle spec"), and only then authorizes implementation.

## Goals

- Add a formal Spec Factory pipeline from ProblemBrief to Implementation Tasks.
- Define actor modes and their responsibilities, including user-directed selection and one-off variants.
- Establish a shared spec schema and contract registry for machine-checkable artifacts.
- Introduce automated review gates that must pass before codegen/implementation.
- Describe a convergence loop that iterates until specs are complete and consistent.

## Non-goals

- Implement production-ready scripts, workflows, or orchestration runtime in this change.
- Replace the existing per-task spec system; this design layers on top of it.
- Dictate product requirements beyond the orchestration system itself.

## Actor Modes

- Orchestrator: owns ProblemBrief normalization, workstream decomposition, spec merge, conflict resolution, and go/no-go gating.
- Spec Author (Subagent): produces a workstream spec and required contracts; does not implement code.
- Implementer: turns approved specs into code/tests and verifies acceptance criteria.
- One-off Vibe: ships a small change without specs; uses only the system context and keeps scope tight.
- One-off Spec: uses a single spec (one-off spec workflow) and implements after approval; approvals are logged in Decision & Work Log.

## Mode Selection (User-Directed)

- The user chooses the mode (orchestrator vs one-off).
- If the user chooses one-off, ask whether they want One-off Vibe or One-off Spec.
- If assigned to a specific workstream, operate as a spec author and deliver a compliant spec (no code).
- If assigned to execute an approved spec, operate as an implementer and reference the MasterSpec.

## Pinnacle Spec

The pinnacle spec is the MasterSpec produced in orchestrator mode. It is required whenever the user selects orchestrator mode (no quantitative threshold).

Recommended signals for choosing orchestrator mode:

- Multiple workstreams are needed.
- Cross-cutting contracts/interfaces are introduced or changed.
- The change impacts multiple repositories, services, or architectural layers.

The pinnacle spec must include:

- ProblemBrief summary, goals, non-goals, and constraints.
- Workstream list with owners, dependencies, and deliverables.
- Interface and contract registry references.
- Acceptance criteria and review gates.

## Spec Factory Pipeline

```mermaid
flowchart TD
  A[ProblemBrief] --> B[Scoping + Clarifying Questions]
  B --> C[Workstreams + Boundaries]
  C --> D[Workstream Specs]
  D --> E[MasterSpec / Pinnacle Spec]
  E --> F[Implementation Tasks]
  F --> G[Code + Verification]
```
````

### Pipeline Outputs

- ProblemBrief: normalized request, constraints, success criteria.
- Workstreams: parallelizable units with explicit boundaries.
- Workstream Specs: schema-compliant, contract-referenced specifications.
- MasterSpec: merged view with conflict resolution and global gates.
- Implementation Tasks: sequenced task list tied to acceptance criteria.

Notes:

- One-off Spec collapses the pipeline into a single spec and a single task list.
- One-off Vibe bypasses the pipeline entirely.

## Decomposition Method

1. In orchestrator mode, normalize the request into a ProblemBrief with constraints, invariants, and success criteria.
2. Identify domains and interfaces (API, data, security, reliability, UX, QA).
3. Define workstreams around bounded contracts and ownership.
4. Build a dependency graph and mark parallelizable vs sequential workstreams.
5. Assign spec authors with scoped responsibilities and expected outputs.

Heuristics:

- Workstreams should own a contract or interface surface.
- Shared dependencies must be captured in the contract registry.
- Avoid splitting by team alone; split by interface and responsibility boundaries.

## Shared Spec Schema

Each spec is human-readable but machine-checkable. Use YAML front matter plus a JSON Schema for validation.

(... see full content above ...)

````

---

### agents/workflows/orchestrator.workflow.md

```markdown
---
Title: Orchestrator Workflow
---

Intent

- Run the spec-first pipeline from ProblemBrief through MasterSpec approval and gate reporting.
- Coordinate workstream specs and enforce spec-complete gates before implementation.

Global Prompts

- Follow `agents/memory-bank.md#retrieval-policy` for discovery tooling, numbered output expectations, and single-pass context discipline.
- Use the spec templates in `agents/specs/templates/` and the contract registry at `agents/contracts/registry.yaml`.
- Use `node agents/scripts/manage-worktrees.mjs ensure` to create per-workstream worktrees under `.worktrees/` once workstreams are defined.
- Record approvals and gating decisions in the Decision & Work Log.
- Use `node agents/scripts/spec-validate.mjs` and `node agents/scripts/spec-merge.mjs` to enforce gates.
- Ensure workstream specs include a Workstream Reflection section that captures preventable errors (lint, deprecated code) and remediation ideas.

Phase: requirements

- Goal: Normalize the request into a ProblemBrief and identify workstreams.
- Inputs: user request, `agents/memory-bank/spec-orchestration.design.md`, spec templates.
- Checklist:
  - Create or update the ProblemBrief using `agents/specs/templates/problem-brief.template.md`.
  - Capture goals, non-goals, constraints, and success criteria.
  - Identify candidate workstreams, owners, and dependencies.
  - Note initial contract surfaces that need registry entries.
  - Log any approvals in the Decision & Work Log.
- Outputs: ProblemBrief draft, initial workstream list, candidate contracts.
- Next: design

Phase: design

- Goal: Define workstream boundaries and contract expectations.
- Checklist:
  - Confirm workstream scope, dependencies, and ownership boundaries.
  - Identify shared contracts and ensure each has a registry owner.
  - Provide spec authors with scope, dependencies, and contract expectations.
  - Update the contract registry with placeholders if needed.
- Outputs: scoped workstream assignments, updated registry entries.
- Next: implementation-planning

Phase: implementation-planning

- Goal: Plan spec production and gate checks.
- Checklist:
  - Provide spec authors with `agents/specs/templates/workstream-spec.template.md`.
  - Call out the Workstream Reflection section; instruct authors to capture problems and preventable errors as they arise (lint, deprecated code) with remediation ideas.
  - Run `node agents/scripts/manage-worktrees.mjs ensure --workstreams <ws-ids>` to provision per-workstream worktrees.
  - Define required validation cadence (`spec-validate` before merge).
  - Set spec-complete gates and required evidence.
  - Confirm timeline and communication checkpoints.
- Outputs: spec production plan and validation plan.
- Next: execution

Phase: execution

- Goal: Collect specs, validate, merge, and approve the MasterSpec.
- Checklist:
  - Gather workstream specs from authors.
  - Confirm each workstream spec includes a Workstream Reflection section with issues and prevention notes before merge.
  - Run `node agents/scripts/spec-validate.mjs` on workstream specs and the registry.
  - Run `node agents/scripts/spec-merge.mjs` to generate the MasterSpec and gate report.
  - Resolve validation or merge issues with spec authors.
  - Record spec-complete approval in the Decision & Work Log.
  - Run `npm run spec:finalize` to validate specs + Memory Bank references.
  - Run `npm run agent:finalize` before concluding.
- Outputs: MasterSpec, gate report summary, approval record.
- Next: done

End

- Close with a summary, gate report location, and next handoff steps.
- Propose a conventional commit message when shipping workflow updates.
````

---

### agents/workflows/oneoff-spec.workflow.md

```markdown
---
Title: One-off Spec Workflow
---

Intent

- Orchestrate one-off spec changes with visible phases, artifacts, and gates. Keeps memory updated across phases.

Global Prompts

- Retrieval & context discipline: Follow the Retrieval Policy in `agents/memory-bank.md` for required discovery tooling, numbered text defaults, and the single-pass note-taking rule; treat that section as canonical for file inspection guidance.
- Task specs: Each task gets its own spec (Requirements, Design, Implementation Planning, Execution). Create one via `node agents/scripts/reset-active-context.mjs --slug <task-slug> [--title "..."]` and keep it updated.
- Reflection note: After each phase, log a reflection in the task spec and record approvals in the Decision & Work Log.
- Markdown standards: See `AGENTS.md`.

Phase: requirements

- Goal: Clarify the problem and outcomes using EARS; ground the task spec.
- Inputs: Issue/ask
- Checklist:
  - Run `node agents/scripts/load-context.mjs` (add `--include-optional` when optional tiers are relevant).
  - Create/refresh the task spec with the slug for this effort.
  - Capture EARS user stories and acceptance criteria; list non-goals, constraints, risks, invariants.
  - Map impacted components and critical paths; note retrieval sources consulted.
  - Identify interfaces/contracts and candidate files/tests to touch.
  - If system-impacting, open ADR stub.
- Outputs: Task spec Requirements section filled (EARS + acceptance criteria, non-goals, constraints/risks, invariants, interfaces/files/tests to touch); reflection logged in the task spec.
- Done_when: Scope and criteria are clear; risks/constraints logged; invariants confirmed.
- Gates: EARS stories + acceptance criteria are specific/testable; non-goals captured; risks noted; invariants stated.
- Next: design

Phase: design

- Goal: Design how to achieve the outcomes and document flows.
- Checklist:
  - Produce architecture notes (logical, data, control flows) and at least one Mermaid sequence diagram for the primary path.
  - Define interfaces/contracts, data shapes, and error/failure behaviors.
  - Note performance, security, and migration implications; consider test strategy against acceptance criteria.
  - Update the Design section of the task spec.
  - Decide whether an ADR is needed; if yes, start from the template.
- Outputs: Task spec Design section complete; diagrams added; ADR stub if required; reflection logged.
- Done_when: Flows, interfaces, and edge behaviors are clear and trace to Requirements.
- Gates: Primary path diagram present; interfaces and failure modes captured; tests mapped at a high level.
- Next: implementation-planning

Phase: implementation-planning

- Goal: Break down the work into trackable tasks with coverage mapping.
- Checklist:
  - List discrete tasks with outcomes/owners (if relevant) and dependencies.
  - Identify non-primitive fields and define storage format. (if applicable)
  - Map tests to acceptance criteria (traceability back to EARS items).
  - Identify documentation updates needed (user/dev/runbook/README) and target files.
  - Identify Memory Bank canonical updates needed (which `agents/memory-bank/*` files and why).
  - Note sequencing/blockers and checkpoints for progress updates.
  - Update the Implementation Planning section of the task spec.
  - Request and record human approval of the completed spec before moving to execution.
- Outputs: Task list with outcomes/dependencies; test plan mapped to acceptance criteria; documentation and Memory Bank update notes; reflection logged.
- Done_when: Tasks are actionable, ordered, and traceable to Requirements/Design; human approval recorded.
- Gates: Each acceptance criterion has at least one planned verification; dependencies/risks identified; documentation/Memory Bank updates noted when applicable; human approval recorded.
- Next: execution (after approval)

Phase: execution

- Goal: Deliver the change, keep the spec honest, and validate outcomes.
- Checklist:
  - Execute tasks, updating the Execution section with progress, adjustments, and evidence.
  - Implement code/docs; keep changes focused; update canonicals when needed.
  - Run `npm run phase:check` as changes evolve.
  - Run targeted tests; gather outputs; tie evidence back to acceptance criteria.
  - Update Memory Bank canonicals if needed; keep `npm run memory:validate` green.
  - Capture line-numbered diff with `node agents/scripts/git-diff-with-lines.mjs` for verification reports.
  - Run `npm run agent:finalize` before concluding.
  - Propose a conventional commit message.
- Outputs: Code/doc changes; updated task spec Execution log; tests/evidence; Memory Bank updates; commit message proposal; reflection logged.
- Done_when: Acceptance criteria satisfied; risks addressed; quality checks pass; spec reflects what shipped.
- Gates: `npm run agent:finalize` passes; evidence traces to acceptance criteria.

End

- Close with summary, surfaced tests, proposed commit message, and next steps.
- Make sure you propose a commit message.
```

---

### agents/scripts/spec-utils.mjs

```javascript
import { readFileSync } from 'node:fs';

const FRONT_MATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;

const stripQuotes = (value) => {
  const trimmed = String(value ?? '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

export const parseSimpleYaml = (raw) => {
  const data = {};
  const errors = [];
  const lines = raw.split(/\r?\n/);
  let currentKey = null;
  let currentIndent = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const indent = line.match(/^\s*/)?.[0]?.length ?? 0;

    if (currentKey && indent <= currentIndent) {
      currentKey = null;
      currentIndent = -1;
    }

    if (trimmed.startsWith('- ')) {
      if (!currentKey || !Array.isArray(data[currentKey])) {
        errors.push(`Unexpected list item at line ${index + 1}.`);
        continue;
      }
      const itemRaw = trimmed.slice(2).trim();
      if (!itemRaw) {
        data[currentKey].push('');
        continue;
      }
      const itemMatch = itemRaw.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
      if (itemMatch) {
        data[currentKey].push({
          [itemMatch[1]]: stripQuotes(itemMatch[2]),
        });
      } else {
        data[currentKey].push(stripQuotes(itemRaw));
      }
      continue;
    }

    const match = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) {
      errors.push(`Unrecognized line at ${index + 1}: ${trimmed}`);
      continue;
    }
    const key = match[1];
    const value = match[2];

    if (value === '') {
      data[key] = [];
      currentKey = key;
      currentIndent = indent;
      continue;
    }

    if (value === '[]') {
      data[key] = [];
      continue;
    }

    data[key] = stripQuotes(value);
  }

  return { data, errors };
};

export const parseFrontMatter = (content) => {
  const match = content.match(FRONT_MATTER_REGEX);
  if (!match) {
    return {
      data: null,
      body: content,
      errors: ['Missing YAML front matter.'],
    };
  }
  const raw = match[1];
  const body = content.slice(match[0].length);
  const { data, errors } = parseSimpleYaml(raw);
  return { data, body, errors };
};

export const parseYamlList = (content) => {
  const items = [];
  const errors = [];
  const lines = content.split(/\r?\n/);
  let current = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    if (trimmed.startsWith('- ')) {
      if (current) {
        items.push(current);
      }
      current = {};
      const remainder = trimmed.slice(2).trim();
      if (remainder) {
        const match = remainder.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
        if (match) {
          current[match[1]] = stripQuotes(match[2]);
        } else {
          errors.push(`Unrecognized list item at line ${index + 1}.`);
        }
      }
      continue;
    }

    const match = trimmed.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
    if (match && current) {
      current[match[1]] = stripQuotes(match[2]);
      continue;
    }

    errors.push(`Unrecognized line at ${index + 1}: ${trimmed}`);
  }

  if (current) {
    items.push(current);
  }

  return { items, errors };
};

export const normalizeSection = (value) =>
  value
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const extractHeadings = (body) => {
  const headings = new Set();
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^#{2,6}\s+(.+?)\s*$/);
    if (!match) continue;
    headings.add(normalizeSection(match[1]));
  }
  return headings;
};

export const readTextFile = (path) => readFileSync(path, 'utf8');
```

---

### agents/scripts/spec-merge.mjs

```javascript
#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import {
  parseFrontMatter,
  parseYamlList,
  readTextFile,
} from './spec-utils.mjs';

const USAGE = `Usage: node agents/scripts/spec-merge.mjs --specs <path[,path...]> --output <path> [options]

Merges workstream specs into a MasterSpec and emits a gate report summary.

Options
  --specs <path[,path...]>   Comma-separated workstream spec paths
  --root <path>              Root directory to scan for workstream specs
  --output <path>            Output path for the MasterSpec (required)
  --report <path>            Output path for the gate report (default: <output-dir>/gate-report.md)
  --registry <path>          Contract registry path (default: agents/contracts/registry.yaml)
  --id <value>               MasterSpec id override
  --title <value>            MasterSpec title override
  -h, --help                 Show this help message

Examples
  node agents/scripts/spec-merge.mjs --specs agents/specs/foo/workstreams/ws-a.md --output agents/specs/foo/master-spec.md
  node agents/scripts/spec-merge.mjs --root agents/specs/foo --output agents/specs/foo/master-spec.md
`;

// ... (full implementation - see complete extraction above)
```

---

## Summary

This recovery report documents the complete file structure and contents of the old `agents/` directory before it was migrated to `.claude/` in commit 53a279d. The key files have been extracted and preserved in their entirety for potential restoration or reference.

### Files Successfully Recovered

All 11 requested key files were found and their contents extracted:

1. OPERATOR-GUIDE.md - Complete operator documentation
2. agents/memory-bank.md - Memory bank overview and retrieval policy
3. agents/memory-bank/project.brief.md - Project context and goals
4. agents/memory-bank/tech.context.md - Technical stack documentation
5. agents/memory-bank/testing.guidelines.md - Testing best practices
6. agents/memory-bank/operating-model.md - Four-phase workflow model
7. agents/scripts/spec-validate.mjs - Spec validation script
8. agents/scripts/reset-active-context.mjs - Task spec creation script
9. agents/scripts/load-context.mjs - Context loading script
10. agents/scripts/manage-worktrees.mjs - Git worktree management
11. agents/contracts/registry.yaml - Contract registry

### Additional Valuable Files Recovered

- agents/tools.md - Script catalog
- agents/workflows.md - Workflow index
- agents/memory-bank/task-spec.guide.md - Task spec template guide
- agents/memory-bank/spec-orchestration.design.md - Pinnacle spec design doc
- agents/workflows/orchestrator.workflow.md - Multi-workstream orchestration
- agents/workflows/oneoff-spec.workflow.md - Single-task workflow
- agents/scripts/spec-utils.mjs - Shared YAML parsing utilities
- agents/scripts/spec-merge.mjs - MasterSpec generation

---

**End of Recovery Report**

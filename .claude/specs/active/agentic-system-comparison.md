# Agentic System Comparison Report

**Date**: 2026-01-07
**Author**: Claude Code Analysis
**Migration Commit**: `53a279d` - "migrate agentic system to .claude/ directory structure"

---

## Executive Summary

The monorepo underwent a significant architectural migration from a custom `agents/` directory structure to a Claude Code-native `.claude/` directory structure. This analysis compares the old "memory-bank" approach with the new "engineering-assistant" approach, identifying what was lost, what was gained, and recommendations for improvements.

**Key Finding**: The migration traded custom tooling and explicit workflow documentation for tighter Claude Code integration and a cleaner skills/subagents model. Some valuable documentation and automation was lost in the process.

---

## System Architecture Comparison

### Old System: `agents/` Directory

```
agents/
├── contracts/              # Interface contract registry
│   ├── example.contract.md
│   └── registry.yaml
├── memory-bank/            # Durable knowledge base
│   ├── best-practices/     # Domain-specific guidance
│   ├── operating-model.md  # Four-phase workflow
│   ├── product.context.md  # Product context
│   ├── project.brief.md    # Project overview
│   ├── spec-orchestration.design.md  # System design doc
│   ├── task-spec.guide.md  # Spec writing guide
│   ├── tech.context.md     # Technical context
│   └── testing.guidelines.md
├── scripts/                # 24 automation scripts
│   ├── load-context.mjs
│   ├── smart-file-query.mjs
│   ├── spec-validate.mjs
│   ├── spec-merge.mjs
│   ├── manage-worktrees.mjs
│   └── ... (19 more scripts)
├── specs/                  # Task specifications
│   └── task-specs/
├── workflows/              # Explicit workflow definitions
│   ├── implementer.workflow.md
│   ├── oneoff-spec.workflow.md
│   ├── oneoff-vibe.workflow.md
│   ├── oneoff.workflow.md
│   ├── orchestrator.workflow.md
│   ├── spec-author.workflow.md
│   └── templates/
├── memory-bank.md          # Memory bank overview
├── tools.md                # Tool catalog
└── workflows.md            # Workflow index
```

**Supporting Files**:

- `AGENTS.md` - Main entry point for AI agents
- `OPERATOR-GUIDE.md` - Comprehensive human operator documentation (285 lines)

### New System: `.claude/` Directory

```
.claude/
├── agents/                 # Subagent specifications (8 files)
│   ├── browser-tester.md
│   ├── facilitator.md
│   ├── implementer.md
│   ├── product-manager.md
│   ├── security-reviewer.md
│   ├── spec-author.md
│   ├── test-writer.md
│   └── unifier.md
├── context/
│   └── session.json        # Session state
├── scripts/                # Quality check scripts only (7 files)
│   ├── check-code-quality.mjs
│   └── ... (domain-specific checks)
├── skills/                 # Skill definitions (9 skills)
│   ├── browser-test/SKILL.md
│   ├── implement/SKILL.md
│   ├── orchestrate/SKILL.md
│   ├── pm/SKILL.md
│   ├── route/SKILL.md
│   ├── security/SKILL.md
│   ├── spec/SKILL.md
│   ├── test/SKILL.md
│   └── unify/SKILL.md
├── specs/
│   ├── active/             # Current specs
│   ├── archive/            # Completed specs
│   └── schema/             # JSON schemas for spec validation
├── templates/              # Spec templates
│   ├── task-spec.template.md
│   └── workstream-spec.template.md
└── settings.json           # Hooks configuration
```

**Supporting Files**:

- `CLAUDE.md` - Unified agent instructions (includes project info)

---

## What Was Lost

### 1. Memory Bank System

**Lost Components**:

- `agents/memory-bank/` directory (7+ files)
- `agents/memory-bank.md` retrieval policy
- Structured context tiers (always-include vs conditional)
- Best practices library (`agents/memory-bank/best-practices/`)

**Impact**:

- **No persistent project knowledge**: The memory bank provided durable, structured context that survived across sessions. Topics like `tech.context.md`, `testing.guidelines.md`, and `project.brief.md` captured institutional knowledge.
- **No best practices repository**: The old system had a `best-practices/` directory with domain-specific guidance (TypeScript patterns, software principles, etc.) that could be conditionally loaded.
- **Lost retrieval policy**: The explicit "Retrieval Policy" in `agents/memory-bank.md` defined exactly which files to load and when, reducing context waste.

**Severity**: HIGH - Context management was a core strength of the old system.

### 2. Custom Automation Scripts (17 scripts removed)

**Lost Scripts**:
| Script | Purpose |
|--------|---------|
| `load-context.mjs` | Load required context files with numbered lines |
| `smart-file-query.mjs` | Regex search with context lines |
| `read-files.mjs` | Multi-file reading with line numbers |
| `list-files-recursively.mjs` | File discovery with metadata |
| `spec-validate.mjs` | Validate spec compliance |
| `spec-merge.mjs` | Merge workstream specs into MasterSpec |
| `manage-worktrees.mjs` | Multi-worktree orchestration |
| `create-worktree.mjs` | Create per-workstream worktrees |
| `sync-worktree-env-keys.mjs` | Sync environment keys across worktrees |
| `reset-active-context.mjs` | Create new task specs |
| `append-memory-entry.mjs` | Add reflection entries |
| `validate-memory-bank.mjs` | Validate file references |
| `git-diff-with-lines.mjs` | Diff with line numbers |
| `dotenvx-run.mjs` | Environment handling |
| `find-unsafe-assertions.mjs` | Code quality check |
| `spec-utils.mjs` | Shared spec utilities |
| `constants.js` | Shared constants |

**Impact**:

- **Lost spec automation**: The `spec-validate.mjs` and `spec-merge.mjs` scripts automated spec compliance checking and multi-workstream merging. Now these are manual.
- **Lost worktree management**: The old system had sophisticated git worktree automation for parallel development. The new system documents worktrees in skills but has no automation.
- **Lost context loading**: `load-context.mjs` provided a consistent way to load required context with `--task` flag. Now it's manual file reading.

**Severity**: MEDIUM-HIGH - These scripts encoded valuable automation patterns.

### 3. Operator Guide Documentation

**Lost**: `OPERATOR-GUIDE.md` (285+ lines)

**Content Lost**:

- Detailed workflow selection guide with decision tree
- Step-by-step instructions for each workflow type
- Common patterns and examples
- Troubleshooting section with solutions
- "Nuances & Gotchas" section (10 key insights)
- Command reference with examples
- Quality gate checklists

**Impact**:

- **No human operator documentation**: The guide was essential for onboarding and reference. It explained when/how to use each workflow.
- **Lost troubleshooting guide**: Common issues and their solutions were documented.
- **Lost nuances**: Important operational insights (e.g., "Mode is chosen by the USER, not inferred by agent") are no longer documented.

**Severity**: HIGH - This was valuable institutional knowledge.

### 4. AGENTS.md Entry Point

**Lost**: `AGENTS.md` (62 lines)

**Content Lost**:

- Clear "Start Here" instructions for AI agents
- Mode selection guidance (orchestrator vs one-off)
- Memory Bank update requirements
- Workflow process overview

**Impact**:

- **Less clear entry point**: CLAUDE.md now serves both project info and agent instructions, making it less focused.
- **Lost explicit mode selection**: The old system required explicit user selection of mode. This is now implied in the routing skill.

**Severity**: MEDIUM

### 5. Explicit Workflow Documentation

**Lost**: `agents/workflows/` directory (6 workflow files + templates)

**Lost Workflows**:

- `orchestrator.workflow.md` - Multi-workstream coordination
- `spec-author.workflow.md` - Spec writing process
- `implementer.workflow.md` - Implementation process
- `oneoff.workflow.md` - Overview and routing
- `oneoff-spec.workflow.md` - Medium task workflow
- `oneoff-vibe.workflow.md` - Small task workflow

**Impact**:

- **Workflows are now embedded in skills**: The content is split across skill definitions and subagent specs, making it harder to see the full workflow.
- **Lost workflow index**: `agents/workflows.md` provided a quick reference to all workflows.

**Severity**: MEDIUM - Content preserved but distributed differently.

### 6. Contract Registry

**Lost**: `agents/contracts/` directory

**Content Lost**:

- `registry.yaml` - Machine-readable contract index
- `example.contract.md` - Contract template

**Impact**:

- **Contract management is schema-only**: The new system has JSON schemas for contracts but no actual registry file.
- **Lost contract ownership tracking**: The registry tracked which workstream owned each contract.

**Severity**: LOW-MEDIUM - Schemas remain, but registry implementation is gone.

---

## What Was Gained

### 1. Native Skills System

**New Structure**: `.claude/skills/` with 9 specialized skills

| Skill           | Purpose                                               | Lines          |
| --------------- | ----------------------------------------------------- | -------------- |
| `/route`        | Task complexity analysis and workflow routing         | 174            |
| `/pm`           | Product manager interviews                            | 403            |
| `/spec`         | Spec authoring (TaskSpec, WorkstreamSpec, MasterSpec) | 525            |
| `/implement`    | Implementation execution                              | 388            |
| `/test`         | Test writing for acceptance criteria                  | (not examined) |
| `/unify`        | Convergence validation                                | 490            |
| `/security`     | Security review                                       | (not examined) |
| `/orchestrate`  | Multi-workstream coordination                         | 514            |
| `/browser-test` | UI testing                                            | (not examined) |

**Benefits**:

- **Native Claude Code integration**: Skills are invoked via `/skillname` syntax, which is cleaner than loading workflow files.
- **Clear scope boundaries**: Each skill has explicit `allowed-tools` and documentation.
- **Better maintainability**: Skills are self-contained with all context in one file.

### 2. Specialized Subagents

**New Structure**: `.claude/agents/` with 8 subagent definitions

| Subagent            | Model  | Purpose                                 |
| ------------------- | ------ | --------------------------------------- |
| `product-manager`   | opus   | User interviews, requirements gathering |
| `spec-author`       | opus   | Spec authoring (no code)                |
| `implementer`       | opus   | Code implementation                     |
| `test-writer`       | sonnet | Test writing                            |
| `unifier`           | opus   | Convergence validation                  |
| `security-reviewer` | sonnet | Security review                         |
| `facilitator`       | opus   | Multi-workstream orchestration          |
| `browser-tester`    | sonnet | UI testing                              |

**Benefits**:

- **Model selection**: Each subagent specifies the optimal model (opus for complex reasoning, sonnet for execution).
- **Role specialization**: Clear separation between specs, implementation, and validation.
- **Parallel execution**: Subagents can run in parallel in different contexts.

### 3. Worktree-Aware Orchestration

**New Capability**: The `/orchestrate` skill and `facilitator` subagent include sophisticated worktree management documentation.

**Features**:

- Worktree allocation strategies based on dependency analysis
- Merge queue processing with dependency ordering
- Cross-worktree contract validation
- Conflict detection and escalation

**Benefits**:

- **Better parallelism**: Clear guidance for allocating workstreams to worktrees.
- **Dependency-aware merging**: Merge order respects workstream dependencies.
- **Contract validation across worktrees**: Ensures interface consistency.

### 4. Convergence Validation System

**New Capability**: The `/unify` skill and `unifier` subagent provide structured convergence checking.

**Validation Gates**:

- Spec completeness
- Implementation alignment
- Test coverage
- Contract consistency
- Security review

**Benefits**:

- **Explicit convergence criteria**: Clear definition of what "done" means.
- **Iteration cap**: Maximum 3 iterations before escalating.
- **Evidence-based reports**: Convergence reports include file locations and test output.

### 5. JSON Schemas for Specs

**New Structure**: `.claude/specs/schema/` with 4 schemas

- `problem-brief.schema.json`
- `workstream-spec.schema.json`
- `master-spec.schema.json`
- `contract-registry.schema.json`

**Benefits**:

- **Machine-readable validation**: Specs can be validated against schemas.
- **Consistent structure**: Schemas enforce required fields and formats.

### 6. Simplified Directory Structure

**Old**: 50+ files across `agents/`, `AGENTS.md`, `OPERATOR-GUIDE.md`
**New**: 35 files in `.claude/` plus `CLAUDE.md`

**Benefits**:

- **Less file sprawl**: Everything is under `.claude/`.
- **Clearer organization**: Skills, agents, specs, and templates are clearly separated.
- **Standard Claude Code layout**: Follows patterns that other Claude Code users expect.

### 7. Session State Management

**New**: `.claude/context/session.json`

**Purpose**:

- Track worktree allocation
- Track workstream execution status
- Persist routing decisions

**Benefits**:

- **Resumability**: Session state can be loaded to resume work.
- **Visibility**: Current state is machine-readable.

---

## Trade-offs Analysis

### Better in New System

| Aspect                      | Why Better                                             |
| --------------------------- | ------------------------------------------------------ |
| **Skill invocation**        | `/skill` syntax is cleaner than loading workflow files |
| **Subagent specialization** | Clear role separation with model selection             |
| **Convergence validation**  | Structured, consistent validation with iteration caps  |
| **Worktree documentation**  | Comprehensive worktree management guidance             |
| **Schema validation**       | JSON schemas enable automated spec validation          |
| **Directory organization**  | Everything under `.claude/` is cleaner                 |

### Worse in New System

| Aspect                     | Why Worse                                      |
| -------------------------- | ---------------------------------------------- |
| **Context management**     | No retrieval policy or context tiers           |
| **Automation scripts**     | Lost 17 purpose-built scripts                  |
| **Operator documentation** | No equivalent to OPERATOR-GUIDE.md             |
| **Best practices library** | No domain-specific guidance repository         |
| **Workflow visibility**    | Workflows are distributed across skills/agents |
| **Task spec creation**     | No `reset-active-context.mjs` automation       |
| **Spec validation**        | No `spec-validate.mjs` automation              |

### Neutral Changes

| Aspect                | Assessment                           |
| --------------------- | ------------------------------------ |
| **Contract registry** | Schemas exist but no actual registry |
| **Quality checks**    | Same scripts, just relocated         |
| **Templates**         | Similar templates, slightly updated  |

---

## Recommendations

### High Priority Restorations

1. **Restore OPERATOR-GUIDE.md**
   - The human operator documentation was invaluable.
   - Adapt it to reference skills instead of workflow files.
   - Include troubleshooting and "Nuances & Gotchas" sections.

2. **Restore Memory Bank System**
   - Create `.claude/memory-bank/` with:
     - `project.brief.md` - Project context
     - `tech.context.md` - Technical stack
     - `testing.guidelines.md` - Testing patterns
     - `best-practices/` - Domain-specific guidance
   - Add retrieval policy to CLAUDE.md.

3. **Restore Key Automation Scripts**
   - `spec-validate.mjs` - Validate specs against schemas
   - `reset-active-context.mjs` - Create new task specs
   - `load-context.mjs` - Load required context files

### Medium Priority Restorations

4. **Restore Contract Registry**
   - Create `.claude/contracts/registry.yaml`
   - Track contract ownership and versions

5. **Add Workflow Index**
   - Create `.claude/WORKFLOWS.md` that maps tasks to skills
   - Include quick reference for common operations

6. **Restore Worktree Automation**
   - Port `manage-worktrees.mjs` or document manual commands
   - The orchestrate skill documents worktrees but lacks automation

### Low Priority / Nice-to-Have

7. **Restore File Discovery Scripts**
   - `smart-file-query.mjs` - Regex search with context
   - `list-files-recursively.mjs` - File discovery

8. **Add Reflection/Learning System**
   - The old `append-memory-entry.mjs` captured learnings
   - Consider `.claude/decisions/` for decision records

---

## Conclusion

The migration to the `.claude/` directory structure brought significant benefits in terms of Claude Code integration, skill organization, and subagent specialization. However, valuable automation and documentation was lost in the process.

**The biggest losses are**:

1. The OPERATOR-GUIDE.md documentation
2. The memory bank persistent knowledge system
3. The spec and worktree automation scripts

**The biggest gains are**:

1. Native skills system with clear invocation
2. Specialized subagents with model selection
3. Structured convergence validation
4. Cleaner directory organization

**Net assessment**: The new system has a better architecture but lost important content. A hybrid approach that restores key documentation and automation within the new structure would be optimal.

---

## Appendix: File Count Comparison

### Old System

- `agents/` directory: ~50 files
- `AGENTS.md`: 1 file
- `OPERATOR-GUIDE.md`: 1 file
- **Total**: ~52 files

### New System

- `.claude/` directory: ~35 files
- `CLAUDE.md`: 1 file
- **Total**: ~36 files

### Lines of Documentation

- **Old system**: ~3,000+ lines across workflow and memory bank files
- **New system**: ~4,000+ lines across skill and agent files
- **Lost**: OPERATOR-GUIDE.md (~500 lines), memory bank (~800 lines)
- **Net**: Similar overall, but different distribution

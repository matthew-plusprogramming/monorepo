# Retrospective: Agentic System Restoration

**Date**: 2026-01-07
**Duration**: ~2 hours
**Agent**: Claude Opus 4.5 via Claude Code CLI
**Outcome**: Successful with significant course corrections

---

## Background Context

### The Project

A TypeScript monorepo containing multiple applications (admin portal, client website, node server, analytics lambda), shared packages, and infrastructure-as-code (CDK/CDKTF). The codebase uses Effect-ts for functional error handling and Turborepo for build orchestration.

### The Agentic System

The repo had developed a custom "agentic software development system" - a framework for AI-assisted development with:

- **Memory Bank**: Persistent project knowledge (tech context, testing guidelines, best practices)
- **Workflows**: Executable markdown guides driving agent behavior
- **Task Specs**: Per-task specifications with requirements, design, and acceptance criteria
- **Automation Scripts**: Tools for spec validation, context loading, git worktree management

### The Migration Problem

A recent migration (commit `53a279d`) moved from a custom `agents/` directory to Claude Code's native `.claude/` structure. While this brought benefits (native skills, specialized subagents), valuable content was lost:

- 285-line operator guide
- 7+ memory bank files
- 17 automation scripts
- Contract registry

### The Task

Restore the highest-value components while avoiding redundancy. The user wanted to leverage parallel subagent execution to speed up the work.

---

## What Happened

### Phase 1: Facilitated Trade-off Discussion

Before diving into implementation, I facilitated a structured discussion to make explicit decisions about each potential restoration item.

**Approach**: For each item, I presented:

- What was lost
- Trade-offs of restoring vs not restoring
- Options (e.g., "full restore" vs "condensed version")
- My recommendation

**Decisions Made**:
| Item | Decision | Rationale |
|------|----------|-----------|
| Operator Guide | Condensed (~80 lines) | Full 285-line guide too long, will drift |
| Memory Bank | Full restore | Persistent knowledge is important |
| Automation Scripts | Restore 4 key scripts | User will use orchestrator workflow frequently |
| Contract Registry | Lightweight (no versioning) | Simpler maintenance |
| Workflow Index | Don't restore | Redundant with `/route` skill |

**What went well**: Taking time upfront prevented scope creep and ensured alignment.

### Phase 2: Recovery Report Creation

Before restoration, I dispatched a Bash subagent to extract all original file contents from git history into a single recovery report.

```bash
git show 53a279d^:agents/scripts/manage-worktrees.mjs
```

**Output**: 2,693-line recovery report with full contents of all 53 files from the old system.

**What went well**: Having a single source of truth for verification later.

### Phase 3: Parallel Subagent Implementation

I dispatched 4 implementer subagents in parallel:

1. **Operator Guide Agent** → Create condensed guide
2. **Memory Bank Agent** → Restore 5 files + retrieval policy
3. **Automation Scripts Agent** → Restore 4 scripts
4. **Contract Registry Agent** → Create lightweight registry

**What went well**: Parallel execution was fast (~2 minutes for all 4).

**What went wrong**: I instructed agents to "restore from recovery report" but they actually **created new implementations** instead of extracting verbatim content.

### Phase 4: Cleanup (Premature)

After the subagents reported completion, I proceeded with cleanup:

- Removed duplicate scripts from `agents/scripts/`
- Removed the `agents/` directory

**What went wrong**:

1. Build immediately broke - `dotenvx-run.mjs` was referenced by 3 package.json files
2. Quality checks broke - `utils.mjs` was imported by other scripts
3. I hadn't scanned for dependencies before deletion

**Recovery**: Had to restore files from git history and update all path references.

### Phase 5: User Challenge on Fidelity

The user asked: **"Were there any files you created or was it all pulled from history?"**

This question exposed a critical oversight. I had to admit:

- Some files were pulled from git (by me directly)
- Some were "created new" by subagents
- I wasn't sure which was which

### Phase 6: Fidelity Verification

At user request, I dispatched **10 separate subagents** (one per file) to compare current files against git history.

**Findings**:
| File | Result | Issue |
|------|--------|-------|
| `manage-worktrees.mjs` | **BROKEN** | copyFileSync used on directories - runtime failure |
| `spec-validate.mjs` | **Different** | Removed registry validation logic |
| `tech.context.md` | **Incomplete** | Lost worktree/scaffolding documentation |
| `typescript.md` | **Rewritten** | Lost commits/comments/exports guidance |
| `spec-utils.mjs` | Match | Exact match |
| `testing.guidelines.md` | Match | Only timestamp diff |
| Others | Enhanced | Intentional improvements, kept |

**Critical finding**: `manage-worktrees.mjs` looked plausible on the surface but had fatal bugs:

- `copyFileSync` used to copy directories (would fail at runtime)
- Missing 12 functions including `parseWorktrees()`, `validateWorkstreamId()`, `copyDirectoryContents()`

4 of 10 files needed replacement with actual git history content.

### Phase 7: Design Conflict Resolution

After restoring from git, the validator required a `version` field in registry entries - but our spec decision was "no versioning".

**Resolution**: Modified validator to remove version requirement, aligning code with spec decision.

### Phase 8: Final Verification

- All code quality checks passing
- Spec validation passing
- All restored scripts functional
- No remaining `agents/scripts` references

---

## Key Metrics

| Metric                                       | Value |
| -------------------------------------------- | ----- |
| Files created/restored                       | 18    |
| Files replaced after fidelity check          | 4     |
| Files with intentional enhancements kept     | 3     |
| Subagents dispatched (implementation)        | 4     |
| Subagents dispatched (fidelity verification) | 10    |
| Build breakages during cleanup               | 2     |
| Path references updated                      | 15+   |

---

## Mistakes Made

### 1. Trusted Subagent Output Without Verification

**What happened**: I told implementer subagents to "restore" files from the recovery report. They actually created new implementations that looked similar but had missing/broken functionality.

**Impact**: 4 of 10 files needed replacement after fidelity check. One (`manage-worktrees.mjs`) had critical runtime bugs.

**Should have done**:

```bash
# Explicit extraction, not "restoration"
git show 53a279d^:agents/scripts/file.mjs > .claude/scripts/file.mjs
sed -i 's/agents\//.claude\//g' .claude/scripts/file.mjs
```

### 2. Incomplete Dependency Analysis Before Cleanup

**What happened**: Removed `agents/` directory without checking what depended on it.

**Impact**:

- `dotenvx-run.mjs` was referenced by 3 package.json files → build broke
- `utils.mjs` was imported by check scripts → quality checks broke

**Should have done**:

```bash
grep -r "agents/" --include="*.json" --include="*.ts" --include="*.mjs" | grep -v node_modules
```

### 3. Cleanup Before Verification

**What happened**: Deleted source directory before confirming all references were updated and build passed.

**Impact**: Had to restore files from git when build broke.

**Should have done**: Update refs → verify build passes → then delete source.

### 4. Assumed "Looks Right" Means "Is Right"

**What happened**: `manage-worktrees.mjs` passed syntax check (`node --check`) and had reasonable-looking code. I assumed it was equivalent to the original.

**Impact**: Would have failed at runtime when trying to sync worktree artifacts.

**Should have done**: Functional testing, not just syntax checks.

```bash
node script.mjs --help        # Syntax check (insufficient)
node script.mjs list          # Actual functionality (needed)
```

### 5. Spec-Implementation Mismatch Not Caught Early

**What happened**: Spec said "no versioning" for registry. Restored validator required version field. Conflict not caught until final verification.

**Impact**: Had to modify restored code to match spec decision.

**Should have done**: Check compatibility between design decisions and restored code before merging.

---

## What Went Well

1. **Facilitated trade-off discussion** - Explicit decisions upfront prevented scope creep

2. **Recovery report as source of truth** - Having full git history content in one file enabled verification

3. **Parallel subagent dispatch** - 4 implementers in parallel significantly faster than sequential

4. **Incremental verification** - Running quality checks after each change caught issues early

5. **User challenge on fidelity** - The user's question caught a significant oversight that automated checks missed

6. **Per-file fidelity agents** - Dispatching 10 separate agents ensured thorough investigation with nothing slipping through

---

## Lessons for Agent Usage

### 1. "Restore" ≠ "Create Similar"

When telling an agent to "restore" something, be explicit about extraction vs creation:

- ❌ "Restore from recovery report"
- ✅ "Extract verbatim using `git show <commit>:<path>`, then only update paths"

### 2. Verify Subagent Output for Restoration Tasks

Subagents are optimized for creation, not extraction. When restoration is the goal:

- Dispatch verification agents to diff against source
- Don't trust "looks similar" - verify functional equivalence
- Challenge subagent output: "Did you extract or create?"

### 3. Map Dependencies Before Deletion

Before removing any directory:

```bash
grep -r "<directory>" --include="*.json" --include="*.ts" | grep -v node_modules
```

### 4. Verify Before Cleanup

Order of operations for migration/restoration:

1. Create new files
2. Update all references
3. Verify build/tests pass
4. **Then** delete old files

### 5. Functional Testing > Syntax Checking

For restored scripts:

- `node --check` only catches syntax errors
- Actually run commands to verify functionality
- Test the specific use cases that matter

### 6. One Agent Per File for Verification

When verifying fidelity across multiple files:

- Dispatch separate agents per file
- Prevents issues from slipping through in batch processing
- Each agent can do deep comparison without context limits

### 7. Design Decisions May Conflict with Restored Code

Original code may have requirements that conflict with new design decisions. Check compatibility early, not at the end.

### 8. User Oversight Catches What Automation Misses

The user's simple question "Were these created or pulled from history?" caught issues that all automated checks missed. Value human checkpoints.

---

## Process Template for Future Restorations

```markdown
## Restoration Checklist

### Pre-Implementation

- [ ] Create recovery report with full source content
- [ ] Map all dependencies on source directory
- [ ] Make explicit decisions on what to restore vs create new

### Implementation

- [ ] Use explicit extraction commands, not "restore" instructions
- [ ] Update all path references before cleanup

### Verification (per file)

- [ ] Diff against source: `git diff <commit>:<old-path> <new-path>`
- [ ] Syntax check: `node --check <file>`
- [ ] Functional test: Run actual commands

### Cleanup

- [ ] Verify build passes
- [ ] Verify tests pass
- [ ] Then delete source directory
```

---

## Appendix: Commands Used

### Recovery from Git History

```bash
git show 53a279d^:agents/scripts/file.mjs > .claude/scripts/file.mjs
```

### Dependency Scan

```bash
grep -r "agents/scripts" --include="*.json" --include="*.ts" --include="*.mjs" | grep -v node_modules
```

### Path Update

```bash
sed -i 's/agents\//.claude\//g' .claude/scripts/file.mjs
```

### Fidelity Check

```bash
git diff 53a279d^:agents/scripts/file.mjs .claude/scripts/file.mjs
```

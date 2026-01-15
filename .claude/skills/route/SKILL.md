---
name: route
description: Analyze task complexity and route to appropriate workflow. Defaults to oneoff-spec (specs are cheap, bugs are expensive). Use oneoff-vibe only for truly trivial changes or explicit user override. Use orchestrator for large multi-workstream efforts.
allowed-tools: Read, Glob, Grep
---

# Route Skill

## Purpose
Analyze the user request and determine the appropriate workflow path based on task complexity, scope, and estimated effort.

## Complexity Heuristics

> **Default to specs.** Use oneoff-spec unless the task is truly trivial OR the user explicitly requests to skip specs.

### Trivial (oneoff-vibe)
Route to quick execution **only when**:

**Truly trivial changes** (all must apply):
- Single-line or few-character fix (typo, off-by-one, missing semicolon)
- Zero ambiguity about what to change
- No behavioral impact beyond the obvious fix
- No tests needed or test change is equally trivial

**Examples of truly trivial**:
- Fix typo in README: "teh" → "the"
- Fix obvious syntax error
- Update version number in config
- Add missing import that's causing a build error
- Comment clarification

**User explicitly requests vibe**:
- User says: "just do it", "vibe", "skip the spec", "don't need a spec", "quick fix"
- Honor the request but note in rationale

**NOT trivial (use oneoff-spec instead)**:
- Bug fix requiring investigation
- "Simple" feature additions (even small ones have edge cases)
- Documentation updates with new content (not just typo fixes)
- Configuration changes affecting behavior
- Any change where you'd want to verify acceptance criteria

### Standard (oneoff-spec / Spec Group) — THE DEFAULT
Route to spec group workflow for **most tasks**:
- Any feature addition, enhancement, or new functionality
- Bug fixes (even "simple" ones benefit from AC definition)
- Refactoring with defined goals
- Documentation with new content
- API changes
- UI changes
- **Needs spec group**: requirements.md, spec.md, atomic specs
- **Spec location**: `.claude/specs/groups/<spec-group-id>/`
- **Why default**: Specs create accountability, testability, and prevent scope creep

### Large (orchestrator / MasterSpec)
Route to multi-workstream orchestration with git worktrees:
- 5+ files impacted across multiple layers
- Multiple workstreams with interdependencies
- Cross-cutting concerns (contracts, interfaces, shared state)
- Impacts multiple services, layers, or subsystems
- Requires parallel execution by multiple subagents
- Complex coordination and integration needs
- **Estimated effort**: 4+ hours
- **Needs MasterSpec with workstream spec groups**: Each workstream gets its own spec group with atomic specs
- **Spec structure**: `.claude/specs/groups/<master-spec-group-id>/` with workstream subdirectories
- **Parallel execution**: Workstreams execute in isolated git worktrees
- **Dependency orchestration**: Facilitator manages merge order based on dependencies

## Routing Process

### Step 1: Load Context
If the user references an existing spec group:
```bash
# Check for active spec group
ls .claude/specs/groups/<spec-group-id>/manifest.json 2>/dev/null
```
Load the spec group and continue from its current state based on `review_state` and `work_state`.

### Step 2: Analyze Scope
Use Glob and Grep to understand impact:
```bash
# Find relevant files
glob "**/*.ts" | grep -i "<keyword>"

# Understand current architecture
grep -r "class <Name>" --include="*.ts"
```

### Step 3: Apply Heuristics
Count impacted files and assess complexity:
- **File count**: How many files need changes?
- **Coupling**: Are changes isolated or cross-cutting?
- **Unknowns**: How many open questions exist?
- **Testing**: What test coverage is needed?

### Step 4: Analyze Delegation Opportunities

**Delegation is the default.** Before making a routing decision, analyze whether the task can be decomposed into independent subtasks for parallel subagent execution:

**Always delegate when**:
- Task has 2+ independent components that can run in parallel
- Exploration/research is needed before implementation
- Multiple files need changes that don't depend on each other
- Code review, security review, or testing can run in parallel

**Delegation analysis checklist**:
1. Can parts of this work run independently? → Dispatch parallel subagents
2. Is exploration needed first? → Dispatch Explore subagent before deciding scope
3. Are there isolated concerns? → Dispatch specialized subagents (impl, test, review)
4. Would main-context benefit from delegation? → Always yes for non-trivial tasks

**Do NOT delegate only when**:
- Single-file typo/config fix (oneoff-vibe)
- Task requires tight coordination that subagents can't provide
- User explicitly requests direct execution

### Step 5: Make Routing Decision

Produce a routing decision with delegation plan:

```yaml
workflow: oneoff-vibe | oneoff-spec | orchestrator
rationale: <Brief explanation of why this workflow was chosen>
estimated_scope: small | medium | large
estimated_files: <N>
delegation:
  parallel_subtasks:
    - <subtask 1>: <subagent type>
    - <subtask 2>: <subagent type>
  sequential_dependencies:
    - <subtask that must complete first>
  exploration_needed: true | false
workstreams:
  - <workstream 1> (for orchestrator only)
  - <workstream 2>
next_action: <Suggested next step>
```

### Step 6: Persist Decision
Save routing decision to session state:
```bash
# Append to session context
echo "{\"timestamp\": \"$(date -Iseconds)\", \"workflow\": \"oneoff-spec\", \"rationale\": \"...\"}" >> .claude/context/session.json
```

## Edge Cases

### Ambiguous Complexity
When uncertain about task size:
- **Default to oneoff-spec** — specs are cheap, debugging without specs is expensive
- If task seems trivial but has any ambiguity → oneoff-spec
- Can escalate to orchestrator if spec reveals hidden complexity
- Better to "over-spec" a simple task than "under-spec" a complex one

### User Override
If user explicitly requests a workflow:
- "Just do it", "vibe", "quick fix", "skip spec" → oneoff-vibe (honor request, note in rationale)
- "Write a full spec first" → oneoff-spec or orchestrator
- User preference always wins, but default assumption is: user wants quality (specs)

### Existing Spec Group
If `.claude/specs/groups/<spec-group-id>/manifest.json` exists:
- Check `review_state` and `work_state` fields in manifest
- **review_state**:
  - `DRAFT` → Continue spec authoring or atomization
  - `REVIEWED` → Awaiting user approval
  - `APPROVED` → Route to implementation
- **work_state**:
  - `PLAN_READY` → Ready for implementation
  - `IMPLEMENTING` → Continue implementation
  - `VERIFYING` → Run unify validation
  - `READY_TO_MERGE` → Proceed to code review, security review

## Output Format

Always output a clear routing decision:

```markdown
## Routing Decision

**Workflow**: oneoff-spec

**Rationale**: This task involves adding a new API endpoint with authentication, requiring changes to 3-4 files (route handler, service layer, tests). The scope is well-defined but needs formal requirements and test planning.

**Estimated Scope**: medium

**Estimated Files**: 4 (controller, service, tests, types)

**Next Action**: Use `/pm` skill to interview user about endpoint requirements, then create TaskSpec.
```

## Integration with Other Skills

After routing:
- **oneoff-vibe**: Proceed directly to implementation
- **oneoff-spec**: Use `/pm` to gather requirements → `/spec` to create spec group → `/atomize` to create atomic specs → `/enforce` to validate atomicity → User approval → `/implement` + `/test` → `/unify` → `/code-review` → `/security`
- **orchestrator**: Use `/pm` to create ProblemBrief → `/spec` to create MasterSpec with workstream spec groups → For each workstream: `/atomize` + `/enforce` → User approval → Facilitator orchestrates parallel execution

## Examples

### Example 1: Truly Trivial (oneoff-vibe)
**Request**: "Fix the typo in README.md line 42: 'teh' should be 'the'"

**Routing**:
- workflow: oneoff-vibe
- rationale: Single character fix, zero ambiguity, no behavioral impact
- estimated_scope: trivial
- delegation: none
- next_action: Make the edit directly

### Example 2: Seems Simple But Gets Spec (oneoff-spec)
**Request**: "Add a loading spinner to the submit button"

**Routing**:
- workflow: oneoff-spec
- rationale: Seems simple but has decisions: spinner placement, when to show/hide, error states, accessibility. Spec ensures we don't miss edge cases.
- estimated_scope: small-medium
- estimated_files: 2-3 (component, styles, tests)
- delegation:
  - parallel_subtasks:
    - implementation: implementer
    - tests: test-writer
- next_action: Use `/pm` to clarify loading states and error handling

### Example 3: Standard Feature (oneoff-spec)
**Request**: "Add a logout button to the user dashboard"

**Routing**:
- workflow: oneoff-spec
- rationale: Requires UI component, event handler, API call, state management. Need to clarify placement, behavior on logout, error handling.
- estimated_scope: medium
- estimated_files: 4 (component, handler, API client, tests)
- delegation:
  - parallel_subtasks:
    - implementation: implementer
    - tests: test-writer
  - sequential_dependencies:
    - spec approval must complete before implementation
- next_action: Use `/pm` to gather UI/UX requirements

### Example 4: Large Task (Full Orchestration)
**Request**: "Implement real-time notifications across the application"

**Routing**:
- workflow: orchestrator
- rationale: Cross-cutting feature affecting multiple layers: WebSocket server, frontend client, database schema, auth middleware, notification service (8+ files, 3+ workstreams)
- estimated_scope: large
- workstreams:
  - ws-1: WebSocket server infrastructure
  - ws-2: Frontend notification client
  - ws-3: Notification persistence and delivery
- delegation:
  - parallel_subtasks:
    - ws-1 implementation: implementer (worktree)
    - ws-2 implementation: implementer (worktree)
    - ws-3 implementation: implementer (worktree)
    - per-workstream tests: test-writer (parallel)
  - sequential_dependencies:
    - ws-1 must complete before ws-2 (client depends on server)
  - exploration_needed: true (investigate WebSocket library options)
- next_action: Use `/pm` to create ProblemBrief, dispatch Explore subagent for WebSocket research

### Example 5: Exploration-First (Delegation for Research)
**Request**: "Improve performance of the search feature"

**Routing**:
- workflow: oneoff-spec (may escalate to orchestrator)
- rationale: Requires investigation to understand bottlenecks before planning
- estimated_scope: unknown (pending exploration)
- delegation:
  - exploration_needed: true
  - parallel_subtasks:
    - codebase analysis: Explore subagent
    - performance profiling: Explore subagent (separate)
  - sequential_dependencies:
    - exploration must complete before spec authoring
- next_action: Dispatch Explore subagent to profile current search implementation

### Example 6: User Requests Vibe (Override)
**Request**: "Just add a console.log to debug this, don't need a spec"

**Routing**:
- workflow: oneoff-vibe
- rationale: User explicitly requested to skip spec ("don't need a spec"). Honoring user preference.
- estimated_scope: trivial
- delegation: none
- next_action: Make the change directly

**Note**: Without the explicit override, even a "simple" debug statement might warrant a spec if it's part of a larger investigation.

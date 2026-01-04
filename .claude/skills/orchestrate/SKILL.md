---
name: orchestrate
description: Orchestrate large multi-workstream projects using git worktrees for parallel development. Load MasterSpec, allocate worktrees, dispatch implementers, monitor convergence, process merge queue.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Task
---

# Orchestrate Skill

## Purpose

Orchestrate large multi-workstream projects (orchestrator workflow) using git worktrees for true parallel development. This skill coordinates the facilitator agent to manage worktree allocation, dependency ordering, subagent execution, and auto-merge after convergence gates pass.

## When to Use

Use this skill when:
- MasterSpec has been approved (3+ workstreams)
- Multiple workstreams need to execute in parallel
- Workstreams have dependencies that require ordered execution
- Git worktrees will enable isolated, parallel development

**Trigger**: After MasterSpec approval in orchestrator workflow

## Orchestration Flow

### 1. Load MasterSpec

```bash
# Load approved MasterSpec
cat .claude/specs/active/<slug>/master.md
```

**Extract**:
- Workstream Overview (IDs, titles, dependencies)
- Contract Registry
- Dependency Graph
- Worktree Allocation Strategy (if present)

### 2. Invoke Facilitator for Worktree Allocation

If MasterSpec doesn't have worktree allocation strategy, dispatch facilitator to analyze and allocate:

```javascript
Task({
  description: "Allocate worktrees for MasterSpec",
  prompt: `
Analyze the MasterSpec at .claude/specs/active/<slug>/master.md and determine worktree allocation.

**Workstreams**:
- ws-1: <title> (dependencies: <deps>)
- ws-2: <title> (dependencies: <deps>)
- ws-3: <title> (dependencies: <deps>)

**Your task**:
1. Analyze dependency graph
2. Identify independent workstreams (separate worktrees)
3. Identify tightly coupled workstreams (shared worktrees)
4. Apply allocation heuristics (see facilitator agent guidelines)
5. Document allocation strategy in MasterSpec
6. Initialize session.json with worktree_allocation
  `,
  subagent_type: "facilitator"
})
```

### 3. Create Worktrees

For each worktree in allocation strategy:

```bash
# Get repository name
REPO_NAME=$(basename $(pwd))

# Create worktree-1
git worktree add ../${REPO_NAME}-ws-1 -b feature/ws-1-<slug>

# Create worktree-2
git worktree add ../${REPO_NAME}-ws-2 -b feature/ws-2-<slug>

# Verify creation
git worktree list
```

**Update session.json**:
```json
{
  "worktree_allocation": {
    "strategy": "ws-1 and ws-4 share worktree (tight coupling), ws-2 and ws-3 isolated",
    "worktrees": [
      {
        "id": "worktree-1",
        "path": "/Users/matthewlin/Desktop/Personal Projects/engineering-assistant-ws-1",
        "branch": "feature/ws-1-backend-api",
        "workstreams": ["ws-1", "ws-4"],
        "status": "active",
        "created_at": "2026-01-02T15:35:00Z"
      }
    ]
  }
}
```

### 4. Evaluate Initial Workstream Readiness

For each workstream, determine if ready to start:

**Ready** (no dependencies):
- ws-1: No dependencies → Ready to start
- ws-3: No dependencies → Ready to start

**Blocked** (has dependencies):
- ws-2: Depends on ws-1 → Blocked
- ws-4: Depends on ws-1 → Blocked (but shares worktree with ws-1)

**Update session.json**:
```json
{
  "workstream_execution": {
    "workstreams": [
      {
        "id": "ws-1",
        "title": "Backend API",
        "worktree_id": "worktree-1",
        "dependencies": [],
        "status": "ready"
      },
      {
        "id": "ws-2",
        "title": "Frontend UI",
        "worktree_id": "worktree-2",
        "dependencies": ["ws-1"],
        "status": "blocked",
        "blocking_reason": "Waiting for ws-1 to merge (dependency)"
      }
    ]
  }
}
```

### 5. Dispatch Implementers and Test-Writers

For each **ready** workstream, dispatch implementer and test-writer in parallel:

```javascript
// ws-1 is ready
const ws1Impl = Task({
  description: "Implement ws-1 in worktree-1",
  prompt: `
You are implementing workstream ws-1.

## EXECUTION CONTEXT

**Worktree**: worktree-1
**Path**: /Users/matthewlin/Desktop/Personal Projects/engineering-assistant-ws-1
**Branch**: feature/ws-1-backend-api
**Workstream**: ws-1 (Backend API)

## CRITICAL INSTRUCTIONS

1. **Working Directory**: All operations MUST occur in the worktree path above
2. **Isolation**: Do NOT modify files in the main worktree
3. **Spec Location**: .claude/specs/active/<slug>/ws-1.md

${ws1.sharedWorktree ? `
## SHARED WORKTREE NOTICE
This worktree is shared with: ws-4 (Integration Tests)
Coordinate with test-writer: you implement, they test (parallel execution)
` : ''}

## YOUR TASK
Implement WorkstreamSpec ws-1 following standard implementation process.
  `,
  subagent_type: "implementer",
  run_in_background: true
});

const ws1Tests = Task({
  description: "Write tests for ws-1 in worktree-1",
  prompt: `
You are writing tests for workstream ws-1.

## EXECUTION CONTEXT

**Worktree**: worktree-1
**Path**: /Users/matthewlin/Desktop/Personal Projects/engineering-assistant-ws-1
**Branch**: feature/ws-1-backend-api
**Workstream**: ws-1 (Backend API)

## YOUR TASK
Write tests for all acceptance criteria in ws-1 spec.
  `,
  subagent_type: "test-writer",
  run_in_background: true
});
```

**Update session state**:
```json
{
  "workstream_execution": {
    "workstreams": [
      {
        "id": "ws-1",
        "status": "in_progress"
      }
    ]
  }
}
```

### 6. Monitor Subagent Completion

Poll background tasks for completion:

```javascript
// Wait for both implementer and test-writer
const ws1ImplResult = TaskOutput({task_id: ws1Impl.task_id, block: true});
const ws1TestsResult = TaskOutput({task_id: ws1Tests.task_id, block: true});

// Both complete → Ready for convergence validation
```

### 7. Run Convergence Validation

Dispatch unifier to validate workstream:

```javascript
Task({
  description: "Validate ws-1 convergence in worktree-1",
  prompt: `
Validate convergence for workstream ws-1.

## EXECUTION CONTEXT

**Worktree**: worktree-1
**Path**: /Users/matthewlin/Desktop/Personal Projects/engineering-assistant-ws-1
**Spec**: .claude/specs/active/<slug>/ws-1.md

## VALIDATION REQUIREMENTS

- All tasks complete
- All ACs implemented
- All tests passing
- Contract registry validated (if ws-1 owns contracts)

Produce convergence report with CONVERGED or NOT_CONVERGED status.
  `,
  subagent_type: "unifier"
})
```

**If CONVERGED**:
- Update workstream status: "converged"
- Proceed to security review

**If NOT_CONVERGED**:
- Iteration count < 3 → Fix issues, re-run unifier
- Iteration count >= 3 → Escalate to user

### 8. Run Security Review

```javascript
Task({
  description: "Security review for ws-1 in worktree-1",
  prompt: `
Review workstream ws-1 for security vulnerabilities.

**Worktree**: worktree-1
**Path**: /Users/matthewlin/Desktop/Personal Projects/engineering-assistant-ws-1

Check: OWASP Top 10, input validation, auth/authz, secrets handling.
  `,
  subagent_type: "security-reviewer"
})
```

**If PASSED**:
- Update convergence_status.security_reviewed: true
- Add to merge queue

**If FAILED (Critical/High severity)**:
- Block merge
- Escalate to user with findings

### 9. Process Merge Queue

For each workstream in merge queue (FIFO, respecting dependencies):

**Pre-Merge Checks**:
```bash
# Switch to worktree
cd /Users/matthewlin/Desktop/Personal\ Projects/engineering-assistant-ws-1

# Re-run tests (ensure still passing)
npm test

# Check for conflicts with main
git fetch origin main
git merge --no-commit --no-ff origin/main
if [ $? -ne 0 ]; then
  git merge --abort
  # Handle conflict (see facilitator error handling)
else
  git merge --abort  # Dry run successful
fi
```

**Execute Merge**:
```bash
# Commit any uncommitted changes in worktree
git add .
git commit -m "feat(ws-1): implement Backend API

Implements WorkstreamSpec ws-1 from <slug>

Acceptance Criteria:
- AC1.1: <criterion> ✅
- AC1.2: <criterion> ✅

Tests: 15 passing
Coverage: 92%
Convergence: PASSED
Security: PASSED

🤖 Generated with Claude Code
Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

# Switch to main worktree
cd /Users/matthewlin/Desktop/Personal\ Projects/engineering-assistant

# Merge with --no-ff
git merge --no-ff feature/ws-1-backend-api -m "Merge ws-1: Backend API

Implements WorkstreamSpec ws-1

Contracts Provided:
- contract-backend-api: src/api/server.ts

Dependencies: none
Next: ws-2 can now proceed (dependency satisfied)"

# Push to remote
git push origin main
```

**Update session state**:
```json
{
  "workstream_execution": {
    "workstreams": [
      {
        "id": "ws-1",
        "status": "merged",
        "merge_timestamp": "2026-01-02T16:20:00Z"
      }
    ]
  }
}
```

### 10. Unblock Dependent Workstreams

After ws-1 merges, evaluate dependent workstreams:

```javascript
// Find workstreams that depend on ws-1
const dependents = workstreams.filter(ws => ws.dependencies.includes("ws-1"));

for (const ws of dependents) {
  // Check if all dependencies now satisfied
  const allDepsMerged = ws.dependencies.every(dep =>
    getWorkstream(dep).status === "merged"
  );

  if (allDepsMerged) {
    // Unblock and dispatch
    updateWorkstreamStatus(ws.id, "ready", null);
    dispatchImplementer(ws.id, ws.worktree_id);
  }
}
```

**Example**:
```
ws-1: merged ✅
ws-2: ready (dependency satisfied) → Dispatch implementer to worktree-2
ws-4: ready (dependency satisfied, shares worktree-1 with ws-1) → Dispatch test-writer to worktree-1
```

### 11. Repeat for All Workstreams

Continue cycle for each workstream:
1. Monitor completion
2. Run convergence validation
3. Run security review
4. Add to merge queue
5. Merge to main
6. Unblock dependents

Until all workstreams merged.

### 12. Cleanup Worktrees

After all workstreams merged:

```bash
# Remove all worktrees
git worktree remove ../engineering-assistant-ws-1
git worktree remove ../engineering-assistant-ws-2
git worktree remove ../engineering-assistant-ws-3

# Delete branches
git branch -d feature/ws-1-backend-api
git branch -d feature/ws-2-frontend-ui
git branch -d feature/ws-3-database-schema

# Verify cleanup
git worktree list  # Should only show main worktree
```

**Update session state**:
```json
{
  "worktree_allocation": {
    "worktrees": []
  }
}
```

### 13. Final Integration Validation

After all workstreams merged, run final validation:

```bash
# Full test suite on main
npm test

# Integration tests
npm run test:integration

# Build verification
npm run build
```

If all pass → Mark orchestrator task complete.

## Error Handling

### Merge Conflicts

If merge conflict detected:
1. Check if contract-based (favor contract owner)
2. Otherwise, escalate to user with conflict details
3. Preserve both worktrees for manual resolution

### Failed Convergence (3+ iterations)

If workstream fails convergence after 3 iterations:
1. Update workstream status: "blocked"
2. Preserve worktree for debugging
3. Escalate to user with validation results

### Security Failures (Critical/High)

If security review finds critical/high severity issues:
1. Block merge
2. Report findings to user
3. Wait for fixes, then re-validate

## State Management

Throughout orchestration, maintain session.json with:
- `worktree_allocation`: All active worktrees
- `workstream_execution`: Status of each workstream
- `merge_queue`: Workstreams ready to merge

Update after:
- Worktree creation
- Workstream status changes
- Convergence validation
- Merge completion
- Cleanup

## Success Criteria

Orchestrator task complete when:
- ✅ All workstreams merged to main
- ✅ All worktrees cleaned up
- ✅ Integration tests passing
- ✅ No merge conflicts remain
- ✅ MasterSpec Decision & Work Log updated

## Example Session

**User Request**: "Add real-time notifications"

**MasterSpec**: 3 workstreams
- ws-1: WebSocket Server (no deps)
- ws-2: Frontend Client (depends on ws-1)
- ws-3: Notification Service (depends on ws-1)

**Orchestration**:
1. Load MasterSpec ✅
2. Allocate worktrees (3 separate) ✅
3. Create worktrees ✅
4. Dispatch ws-1 (ready) ✅
5. ws-1 converges → Merge ✅
6. Unblock ws-2, ws-3 ✅
7. Dispatch ws-2, ws-3 (parallel) ✅
8. ws-2 converges → Merge ✅
9. ws-3 converges → Merge ✅
10. Cleanup worktrees ✅
11. Final validation ✅
12. Complete ✅

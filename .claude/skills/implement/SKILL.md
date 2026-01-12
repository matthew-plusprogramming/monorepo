---
name: implement
description: Implement code changes based on approved specifications. Executes task list from spec, gathers evidence, and escalates if implementation reveals spec gaps. Use after spec approval.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Task
---

# Implementation Skill

## Purpose
Execute implementation tasks from approved specs with full traceability to requirements.

## Prerequisites

Before using this skill, verify:

1. **Spec exists** in `.claude/specs/active/`
2. **Spec status** is `approved` (check frontmatter or Decision & Work Log)
3. **For MasterSpec**: All workstream specs merged and validated
4. **Open questions** are resolved or explicitly deferred

If prerequisites not met → STOP and resolve before implementing.

## Implementation Process

### Step 1: Load and Verify Spec

```bash
# Read the spec
cat .claude/specs/active/<slug>.md

# Check status
grep "^status:" .claude/specs/active/<slug>.md
```

Verify:
- Status is `approved`
- Task list is present
- Acceptance criteria are clear
- No blocking open questions

### Step 2: Understand the Codebase

Before making changes:

```bash
# Find relevant files
glob "**/*.ts" | grep <keyword>

# Understand existing patterns
grep -r "class <Pattern>" --include="*.ts"

# Check existing tests
glob "**/*.test.ts" | grep <related>
```

Study:
- Existing code structure
- Naming conventions
- Error handling patterns
- Testing approaches

### Step 3: Execute Task List in Order

For each task in the spec's task list:

#### 3a. Mark Task as In Progress
Update spec:
```markdown
- [→] Task 1: Add logout button to UserMenu component
```

(Use `[→]` to indicate in-progress)

#### 3b. Implement the Task
Follow spec requirements exactly:
- Use existing patterns from codebase
- Maintain naming conventions
- Include error handling as specified
- Add comments only where logic is non-obvious

#### 3c. Run Relevant Tests
```bash
# Run tests related to this change
npm test -- <test-file>

# Or run all tests if unsure
npm test
```

#### 3d. Mark Task Complete
Update spec:
```markdown
- [x] Task 1: Add logout button to UserMenu component
```

#### 3e. Log Evidence
Add to spec's Execution section (or Decision & Work Log):
```markdown
## Execution Log

- 2026-01-02 14:30: Task 1 complete - Added logout button to UserMenu.tsx:47
  - Tests passing: user-menu.test.ts (3 tests)
  - Evidence: Button renders with correct aria-label
```

### Step 4: Handle Spec Deviations

If you discover during implementation:

#### Scenario A: Missing Requirement
Spec doesn't cover a necessary case.

**Action**:
1. STOP implementation
2. Document in spec's Open Questions:
```markdown
## Open Questions

- Q3: How should logout behave if user has unsaved changes? (Status: blocking)
  - Discovered during implementation
  - Need user decision before proceeding
```
3. Ask user for guidance
4. Update spec with decision
5. Resume implementation

#### Scenario B: Invalid Assumption
Spec assumes something that's not true in the codebase.

**Action**:
1. STOP implementation
2. Document in spec's Decision & Work Log:
```markdown
- 2026-01-02: **Issue** - Spec assumes AuthService.logout() exists, but it doesn't
- **Proposed amendment**: Add AuthService.logout() method to task list
- **Status**: Awaiting approval
```
3. Propose spec amendment
4. Get user approval
5. Update spec
6. Resume implementation

#### Scenario C: Better Approach Discovered
Found a more efficient or clearer way to achieve the requirement.

**Action**:
1. Evaluate: Does this change the **behavior** or just the **implementation**?
2. If behavior unchanged → Proceed (implementation detail)
3. If behavior changes → Propose spec amendment with rationale
4. Get approval before deviating

**Never silently deviate from the spec.**

### Step 5: Validate Implementation

After all tasks complete:

```bash
# Run full test suite
npm test

# Check for lint errors
npm run lint

# Build if applicable
npm run build
```

Ensure:
- All tests passing
- No lint errors
- Build succeeds
- No console errors introduced

### Step 6: Update Spec Status

Mark implementation complete:

```yaml
---
status: approved
implementation_status: complete
---
```

Add final entry to Decision & Work Log:
```markdown
- 2026-01-02 15:45: Implementation complete
  - All 6 tasks executed
  - Tests passing (12 tests total)
  - Ready for unifier validation
```

## Parallel Execution with Test Writer

For larger tasks, implementation and test writing can run in parallel.

### When to Parallelize
- Multiple independent tasks in task list
- Clear acceptance criteria for each task
- Low coupling between tasks

### How to Parallelize
Use Task tool to dispatch subagents:

```javascript
// Dispatch implementer subagent
Task({
  description: "Implement logout functionality",
  prompt: `Implement tasks 1-3 from TaskSpec at .claude/specs/active/logout-button.md

  Focus on:
  - Adding logout button component
  - Implementing AuthService.logout() method
  - Adding error handling

  Do NOT implement tests - test-writer will handle that.

  Follow spec requirements exactly. Escalate if spec gaps discovered.`,
  subagent_type: "implementer"
})

// Dispatch test-writer subagent in parallel
Task({
  description: "Write tests for logout functionality",
  prompt: `Write tests for acceptance criteria AC1.1-AC2.3 from TaskSpec at .claude/specs/active/logout-button.md

  Map each AC to specific test cases.
  Follow AAA pattern.
  Tests will initially fail until implementation complete.`,
  subagent_type: "test-writer"
})
```

Main agent retains integration responsibility:
- Collect outputs from both subagents
- Ensure tests pass with implementation
- Run unifier to validate alignment

## Spec Conformance Rules

### DO:
- Follow spec requirements exactly
- Use existing codebase patterns
- Ask user when spec is unclear
- Update spec when discovering gaps
- Log evidence of completion
- Run tests after each task

### DON'T:
- Add features not in spec
- Deviate from specified behavior
- Assume unstated requirements
- Skip error handling specified in spec
- Make breaking changes not mentioned in spec
- Silently fix spec errors - propose amendments instead

## Integration with Other Skills

After implementation:
- Use `/unify` to validate spec-impl-test alignment

**After unify passes, the review chain is**:
1. `/code-review` - Code quality review (always)
2. `/security` - Security review (always)
3. `/browser-test` - UI validation (if UI changes)
4. `/docs` - Documentation generation (if public API)
5. Commit

## Error Handling

### Build Failures
```bash
npm run build
# Error: ...
```

**Action**:
1. Read error message carefully
2. Check if spec anticipated this (Security section, Edge Cases)
3. If spec covers it → Implement as specified
4. If spec doesn't cover it → Add to Open Questions, get guidance

### Test Failures
```bash
npm test
# FAIL: expected X, got Y
```

**Action**:
1. Determine if test or implementation is wrong
2. If test is wrong → Fix test to match spec
3. If implementation is wrong → Fix implementation to match spec
4. If spec is wrong → Propose spec amendment

### Merge Conflicts
If working in parallel with other workstreams:

```bash
git pull origin main
# CONFLICT: ...
```

**Action**:
1. Check MasterSpec contract registry
2. Verify your implementation matches contract interface
3. Resolve conflict favoring contract definition
4. If contract is ambiguous → Escalate to orchestrator

## Examples

### Example 1: Simple Task Execution

**Spec**: TaskSpec for logout button (AC1.1: Clear token)

**Implementation**:
```typescript
// src/services/auth.service.ts

async logout(): Promise<void> {
  try {
    // Call API to invalidate session
    await this.api.post('/auth/logout');

    // Clear local token (AC1.1)
    localStorage.removeItem('auth_token');

    // Update auth state
    this.authState.next({ isAuthenticated: false });
  } catch (error) {
    // AC2.1: Display error on failure
    throw new Error('Logout failed. Please try again.');
  }
}
```

**Evidence**:
- Task marked complete in spec
- Tests passing: `auth-service.test.ts` (2 tests)
- AC1.1 verified: Token cleared from localStorage

### Example 2: Discovering Spec Gap

**During implementation**, discovered:
- Spec says "redirect to login page"
- But doesn't specify: Should we preserve the return URL for after re-login?

**Action**:
```markdown
## Open Questions

- Q4: Should we preserve return URL for post-login redirect? (Status: blocking)
  - Discovered during implementation of redirect logic
  - Options:
    - A: Redirect to /login (simple, spec as written)
    - B: Redirect to /login?returnUrl=<current> (better UX)
  - **Recommendation**: Option B for better UX
  - Awaiting user decision
```

**Result**: User chooses Option B → Update spec → Implement with return URL preservation

### Example 3: Parallel Implementation

**Scenario**: MasterSpec with 3 workstreams

**Main agent**:
```javascript
// Dispatch implementers for each workstream
const ws1 = Task({
  description: "Implement WebSocket Server (ws-1)",
  prompt: "Implement workstream ws-1 from master spec...",
  subagent_type: "implementer"
});

const ws2 = Task({
  description: "Implement Frontend Client (ws-2)",
  prompt: "Implement workstream ws-2 from master spec...",
  subagent_type: "implementer"
});

const ws3 = Task({
  description: "Implement Notification Service (ws-3)",
  prompt: "Implement workstream ws-3 from master spec...",
  subagent_type: "implementer"
});

// Wait for all to complete
// Then run unifier for cross-workstream validation
```

**Result**: Parallel execution with main agent handling integration and contract validation

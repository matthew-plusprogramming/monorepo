# Atomic Spec Workflow Migration Guide

This document describes the changes made to the skills and agents system to support the new atomic spec workflow.

---

## Overview

The system has been migrated from a **task-list based workflow** to an **atomic spec workflow**. This change introduces:

1. **Spec Groups**: A directory structure containing all artifacts for a feature/change
2. **Atomic Specs**: Independently testable, deployable, reviewable, and reversible units
3. **Full Traceability**: Chain from requirements → atomic specs → implementation → tests
4. **Two-Dimensional State**: Review state (approval) + Work state (progress)

---

## Key Architectural Changes

### Before: Task-List Workflow

```
.claude/specs/active/<slug>.md    # Single spec file with task list
```

- Specs lived in `.claude/specs/active/`
- Tasks were embedded in the spec as a checklist
- Implementation and tests referenced the spec directly
- No formal requirements document
- No atomicity enforcement

### After: Atomic Spec Workflow

```
.claude/specs/groups/<spec-group-id>/
├── manifest.json                  # State tracking, metadata
├── requirements.md                # EARS-format requirements (REQ-XXX)
├── spec.md                        # High-level spec with acceptance criteria
└── atomic/                        # Atomic specs directory
    ├── as-001-<slug>.md           # First atomic spec
    ├── as-002-<slug>.md           # Second atomic spec
    └── ...
```

- Specs live in spec groups with structured directories
- Requirements are separate and use EARS format (WHEN/THEN/AND)
- Atomic specs decompose the work into independent units
- Each atomic spec has Implementation Evidence and Test Evidence
- Full traceability chain is enforced

---

## New Concepts

### Spec Group

A spec group is a directory containing all artifacts for a feature:

| File | Purpose |
|------|---------|
| `manifest.json` | Tracks state (review_state, work_state), convergence gates, decision log |
| `requirements.md` | Business requirements in EARS format (REQ-001, REQ-002, etc.) |
| `spec.md` | Technical specification with acceptance criteria |
| `atomic/*.md` | Atomic specs that decompose the work |

### Atomic Specs

Atomic specs are the unit of work. Each must be:

- **Independently Testable**: Can write tests without other atomic specs
- **Independently Deployable**: Can deploy without other atomic specs
- **Independently Reviewable**: Can review without other atomic specs
- **Independently Reversible**: Can revert without affecting others

Format:
```markdown
---
id: as-001
title: <Short descriptive title>
status: draft | implementing | implemented
requirements_refs: [REQ-001, REQ-002]
---

## Description
Single sentence describing the behavior.

## Acceptance Criteria
- AC1: When X, then Y
- AC2: When A, then B

## Test Strategy
How to test this atomic spec.

## Implementation Evidence
| File | Line | Description |
|------|------|-------------|
| src/file.ts | 42 | Implementation location |

## Test Evidence
| AC | Test File | Line | Test Name | Status |
|----|-----------|------|-----------|--------|
| AC1 | file.test.ts | 24 | "should..." | ✅ Pass |

## Decision Log
- `<timestamp>`: Created from spec decomposition
- `<timestamp>`: Implementation complete
```

### Traceability Chain

Full traceability is required:

```
REQ-XXX (requirement)
    → as-XXX (atomic spec)
        → file:line (implementation)
            → test:line (test)
```

The unifier validates this chain before allowing merge.

### Two-Dimensional State

| State Type | Values | Purpose |
|------------|--------|---------|
| `review_state` | DRAFT → REVIEWED → APPROVED | User approval tracking |
| `work_state` | PLAN_READY → IMPLEMENTING → VERIFYING → READY_TO_MERGE | Work progress |

---

## Skills Changes

### `/pm` (Product Manager)

**Before**: Gathered requirements, output went directly to spec
**After**: Gathers requirements, outputs to `requirements.md` in spec group

Key changes:
- Creates `requirements.md` with EARS-format requirements (REQ-XXX)
- Each requirement has: Description, Rationale, Priority, Acceptance Criteria
- Identifies edge cases, constraints, assumptions
- Links to PRD if external source exists

### `/spec` (Spec Author)

**Before**: Created single spec file at `.claude/specs/active/<slug>.md`
**After**: Creates spec group structure with `spec.md`

Key changes:
- Creates spec group directory at `.claude/specs/groups/<spec-group-id>/`
- Creates `manifest.json` with initial state
- Creates `spec.md` that references `requirements.md`
- Does NOT create atomic specs (that's `/atomize`)

### `/atomize` (NEW)

**Purpose**: Decompose `spec.md` into atomic specs

Key behaviors:
- Reads `spec.md` acceptance criteria
- Creates atomic specs in `atomic/` directory
- Each atomic spec references requirements (REQ-XXX)
- Ensures each atomic spec is independently testable/deployable/reviewable/reversible

### `/enforce` (NEW)

**Purpose**: Validate atomic specs meet atomicity criteria

Key behaviors:
- Runs atomicity validation on each atomic spec
- Checks: single responsibility, independence, testability
- Updates `manifest.json` with enforcement status
- Blocks approval if atomicity violations exist

### `/prd` (NEW)

**Purpose**: Sync PRDs from external sources (Google Docs)

Key behaviors:
- Reads PRD from Google Doc
- Extracts requirements and stores in `requirements.md`
- Maintains sync state with external source
- Handles PRD updates and version tracking

### `/implement`

**Before**: Executed task list from spec file
**After**: Executes atomic specs from spec group

Key changes:
- Input: `.claude/specs/groups/<spec-group-id>/atomic/` (was `.claude/specs/active/`)
- Executes atomic specs in order (as-001, as-002, etc.)
- Fills Implementation Evidence section in each atomic spec
- Updates `manifest.json` work_state
- References AC numbers in code comments

Usage:
```
/implement <spec-group-id>                    # Implement all atomic specs
/implement <spec-group-id> <atomic-spec-id>   # Implement specific atomic spec
```

### `/test`

**Before**: Wrote tests for spec acceptance criteria
**After**: Writes tests for atomic spec acceptance criteria

Key changes:
- Input: `.claude/specs/groups/<spec-group-id>/atomic/` (was `.claude/specs/active/`)
- Maps tests to atomic spec ACs (not just spec ACs)
- Test names reference atomic spec ID and AC (e.g., `"should clear token (as-002 AC1)"`)
- Fills Test Evidence section in each atomic spec
- Updates `manifest.json` with test completion

Usage:
```
/test <spec-group-id>                    # Write tests for all atomic specs
/test <spec-group-id> <atomic-spec-id>   # Write tests for specific atomic spec
/test <spec-group-id> --parallel         # Dispatch parallel test writers
```

### `/unify`

**Before**: Validated spec-implementation-test alignment
**After**: Validates full traceability chain including requirements and atomic specs

Key changes:
- Input: `.claude/specs/groups/<spec-group-id>/` (was `.claude/specs/active/`)
- Validates requirements completeness (EARS format)
- Validates spec completeness
- Validates atomic spec coverage
- Builds and validates traceability matrix (REQ → atomic spec → impl → test)
- Updates `manifest.json` with convergence status

Convergence criteria:
1. Requirements complete (all REQ-XXX in EARS format)
2. Spec complete (all required sections)
3. Atomic specs complete (all have impl + test evidence)
4. Traceability intact (100% chain coverage)
5. Tests pass (all passing, coverage adequate)

Usage:
```
/unify <spec-group-id>          # Full validation
/unify <spec-group-id> --quick  # Skip deep validation
```

---

## Agent Changes

### `product-manager`

**Before**: Output requirements to spec draft
**After**: Creates `requirements.md` with structured EARS requirements

Key behaviors:
- Interviews user for requirements
- Outputs REQ-XXX requirements in EARS format
- Identifies edge cases, constraints, open questions
- Creates requirements.md in spec group

### `spec-author`

**Before**: Created monolithic spec with task list
**After**: Creates spec.md that references requirements.md

Key behaviors:
- References requirements.md (doesn't duplicate)
- Maps acceptance criteria to requirements
- Does NOT create atomic specs
- Creates manifest.json with initial state

### `atomizer` (NEW)

**Purpose**: Decompose specs into atomic specs

Key behaviors:
- Reads spec.md acceptance criteria
- Creates one atomic spec per logical unit
- Ensures independence criteria
- Names atomic specs with order prefix (as-001, as-002)

### `atomicity-enforcer` (NEW)

**Purpose**: Validate atomic specs meet criteria

Checks:
- Single responsibility
- Independence (no tight coupling)
- Testability (can test in isolation)
- Deployability (can deploy independently)
- Reviewability (can review independently)
- Reversibility (can revert independently)

### `implementer`

**Before**: Executed task list items
**After**: Executes atomic specs

Key changes:
- Reads atomic specs from `atomic/` directory
- Executes in order (as-001, as-002, etc.)
- Fills Implementation Evidence section
- Updates atomic spec status to `implemented`
- References AC numbers in code comments
- Updates manifest.json work_state

### `test-writer`

**Before**: Wrote tests for spec ACs
**After**: Writes tests for atomic spec ACs

Key changes:
- Maps tests to atomic spec ACs
- Test names include atomic spec ID (e.g., `as-002 AC1`)
- Fills Test Evidence section in atomic spec
- Uses AAA pattern with comments
- Updates manifest.json with test completion

### `unifier`

**Before**: Validated spec-impl-test alignment
**After**: Validates full traceability including requirements

Key changes:
- Validates requirements completeness
- Validates spec completeness
- Validates atomic spec coverage
- Builds traceability matrix
- Produces Synthesis-Ready Summary
- Updates manifest.json convergence status

---

## Directory Structure Changes

### Before

```
.claude/
├── specs/
│   ├── active/           # Current specs
│   │   └── <slug>.md     # Single spec file
│   └── archive/          # Completed specs
```

### After

```
.claude/
├── specs/
│   ├── groups/           # Spec groups
│   │   └── <spec-group-id>/
│   │       ├── manifest.json
│   │       ├── requirements.md
│   │       ├── spec.md
│   │       └── atomic/
│   │           ├── as-001-<slug>.md
│   │           ├── as-002-<slug>.md
│   │           └── ...
│   └── archive/          # Completed spec groups
├── templates/            # Templates for specs
│   ├── atomic-spec.md    # Atomic spec template
│   ├── requirements.md   # Requirements template
│   └── prd.md            # PRD template
```

---

## Migration Steps

### For Existing Projects

1. **Create spec group structure**:
   ```bash
   mkdir -p .claude/specs/groups
   ```

2. **Migrate existing specs**:
   - Move spec to `<spec-group-id>/spec.md`
   - Extract requirements to `requirements.md`
   - Run `/atomize` to create atomic specs
   - Run `/enforce` to validate atomicity

3. **Update skill invocations**:
   - Change `/implement <slug>` to `/implement <spec-group-id>`
   - Change `/test` to `/test <spec-group-id>`
   - Change `/unify` to `/unify <spec-group-id>`

### For New Projects

1. Start with `/pm` to gather requirements → creates `requirements.md`
2. Use `/spec` to create spec → creates spec group with `spec.md`
3. Use `/atomize` to decompose → creates `atomic/*.md`
4. Use `/enforce` to validate atomicity
5. Get user approval
6. Use `/implement` and `/test` (can run in parallel)
7. Use `/unify` to validate convergence
8. Continue with `/code-review`, `/security`, etc.

---

## Workflow Comparison

### Before: Task-List Workflow

```
User Request
  → /route
  → /pm (gather requirements)
  → /spec (create spec with task list)
  → User Approval
  → /implement (execute task list)
  → /test (write tests)
  → /unify (validate)
  → Reviews → Commit
```

### After: Atomic Spec Workflow

```
User Request
  → /route
  → /pm (create requirements.md)
  → /spec (create spec.md in spec group)
  → /atomize (create atomic/*.md)
  → /enforce (validate atomicity)
  → User Approval
  → [Parallel: /implement + /test]
  → /unify (validate traceability chain)
  → Reviews → Commit
```

---

## Key Benefits

1. **Better Traceability**: Every line of code traces back to requirements
2. **Independent Testing**: Each atomic spec can be tested in isolation
3. **Parallel Execution**: Implement and test can run simultaneously
4. **Safer Rollbacks**: Atomic specs can be reverted independently
5. **Clearer Reviews**: Review scope is well-defined per atomic spec
6. **Evidence Trail**: Implementation and test evidence documented in atomic specs

---

## Review Skills Changes

### `/code-review`

**Before**: Reviewed files from `.claude/specs/active/<slug>.md`
**After**: Reviews files from atomic spec Implementation Evidence

Key changes:
- Input: `.claude/specs/groups/<spec-group-id>/` (was `.claude/specs/active/`)
- Reviews per atomic spec (not per spec)
- Checks spec conformance (impl matches atomic spec ACs)
- All findings reference atomic spec ID
- Updates `manifest.json` with `convergence.code_review_passed`

Usage:
```
/code-review <spec-group-id>                   # Review all changes
/code-review <spec-group-id> <atomic-spec-id>  # Review specific atomic spec
```

Report format includes per-atomic-spec review:
```markdown
### Per Atomic Spec Review

#### as-001: Logout Button UI
- Files: src/components/UserMenu.tsx
- Quality: ✅ Clean
- Spec Conformance: ✅ Matches ACs

#### as-002: Token Clearing
- Files: src/services/auth-service.ts
- Quality: ⚠️ 1 Medium finding (M1)
- Spec Conformance: ✅ Matches ACs
```

### `/security`

**Before**: Reviewed files from `.claude/specs/active/<slug>.md`
**After**: Reviews files from atomic spec Implementation Evidence

Key changes:
- Input: `.claude/specs/groups/<spec-group-id>/` (was `.claude/specs/active/`)
- Reviews per atomic spec (not per spec)
- All findings reference atomic spec ID
- Updates `manifest.json` with `convergence.security_review_passed`

Usage:
```
/security <spec-group-id>                   # Security review all changes
/security <spec-group-id> <atomic-spec-id>  # Review specific atomic spec
```

Report format includes per-atomic-spec security review:
```markdown
### Per Atomic Spec Review

### as-001: Logout Button UI
- Files: src/components/UserMenu.tsx
- Security: ✅ No security concerns (pure UI)

### as-002: Token Clearing
- Files: src/services/auth-service.ts
- Security: ✅ Pass
- Notes: Token properly cleared from localStorage
```

---

## Agent Changes (Review)

### `code-reviewer`

**Before**: Reviewed files from single spec
**After**: Reviews per atomic spec

Key changes:
- Reads Implementation Evidence from each atomic spec
- Verifies code matches atomic spec ACs (spec conformance)
- All findings reference atomic spec ID
- Updates manifest.json convergence.code_review_passed

### `security-reviewer`

**Before**: Reviewed files from single spec
**After**: Reviews per atomic spec

Key changes:
- Reads Implementation Evidence from each atomic spec
- Security checks per atomic spec
- All findings reference atomic spec ID
- Updates manifest.json convergence.security_review_passed

---

## Routing & Orchestration Changes

### `/route`

**Before**: Checked `.claude/specs/active/<slug>.md` for existing specs
**After**: Checks `.claude/specs/groups/<spec-group-id>/manifest.json` for existing spec groups

Key changes:
- Context loading checks for spec groups instead of single spec files
- Checks `review_state` and `work_state` from manifest.json to determine next action
- Medium tasks reference spec groups with requirements.md, spec.md, and atomic specs
- Large tasks create MasterSpec with workstream spec groups

State-based routing:
- `review_state: DRAFT` → Continue spec authoring or atomization
- `review_state: REVIEWED` → Awaiting user approval
- `review_state: APPROVED` → Route to implementation
- `work_state: PLAN_READY` → Ready for implementation
- `work_state: IMPLEMENTING` → Continue implementation
- `work_state: VERIFYING` → Run unify validation
- `work_state: READY_TO_MERGE` → Proceed to code review, security review

### `/orchestrate`

**Before**: Loaded MasterSpec from `.claude/specs/active/<slug>/master.md`
**After**: Loads MasterSpec spec group from `.claude/specs/groups/<master-spec-group-id>/`

Key changes:
- MasterSpec is now a spec group with workstream subdirectories
- Each workstream has its own spec group with atomic specs
- Implementer/test-writer prompts reference spec groups and atomic specs
- Convergence validation checks atomic spec evidence and traceability
- Merge commits reference atomic specs completed

MasterSpec structure:
```
.claude/specs/groups/<master-spec-group-id>/
├── manifest.json           # Master spec state tracking
├── requirements.md         # High-level requirements
├── spec.md                 # MasterSpec overview
└── workstreams/            # Per-workstream spec groups
    ├── ws-1/
    │   ├── manifest.json   # Workstream state
    │   ├── spec.md         # Workstream spec
    │   └── atomic/         # Atomic specs for ws-1
    └── ...
```

---

## Agent Changes (Orchestration)

### `facilitator`

**Before**: Orchestrated workstreams from WorkstreamSpecs
**After**: Orchestrates workstream spec groups with atomic specs

Key changes:
- Loads MasterSpec spec group at `.claude/specs/groups/<master-spec-group-id>/`
- Each workstream has its own spec group with atomic/ directory
- Implementer prompts include spec group location and atomic spec execution order
- Convergence evaluation reads from workstream manifest.json
- Merge prerequisites include atomic spec evidence validation
- Success criteria includes traceability chain validation

Convergence gate evaluation:
```javascript
const conv = manifest.convergence;
if (
  conv.all_acs_implemented &&
  conv.all_tests_written &&
  conv.all_tests_passing &&
  conv.traceability_complete &&
  conv.code_review_passed &&
  conv.security_review_passed
) {
  return { status: 'converged', next_action: 'add_to_merge_queue' };
}
```

---

## Convergence Gates (Complete)

Before merge, all gates must pass in manifest.json:

```json
{
  "convergence": {
    "spec_complete": true,
    "all_acs_implemented": true,
    "all_tests_written": true,
    "all_tests_passing": true,
    "test_coverage": "94%",
    "traceability_complete": true,
    "code_review_passed": true,
    "security_review_passed": true
  }
}
```

---

## Complete Workflow (Updated)

```
User Request
  → /route
  → /pm (create requirements.md)
  → /spec (create spec.md in spec group)
  → /atomize (create atomic/*.md)
  → /enforce (validate atomicity)
  → User Approval
  → [Parallel: /implement + /test]
  → /unify (validate traceability chain)
  → /code-review (quality review per atomic spec)
  → /security (security review per atomic spec)
  → [If UI: /browser-test]
  → [If public API: /docs]
  → Commit
```

---

## Additional Skills Changes

### `/docs` (Documentation)

**Before**: Read spec from `.claude/specs/active/<slug>.md`
**After**: Reads spec group from `.claude/specs/groups/<spec-group-id>/`

Key changes:
- Loads manifest.json and spec.md from spec group
- Reads atomic specs for Implementation Evidence (files documented)
- Documents features per atomic spec
- Updates `manifest.json` with `convergence.documentation_complete`

Output includes atomic specs documented:
```markdown
**Atomic Specs Documented**:
- as-001: Logout Button UI
- as-002: Token Clearing
- as-003: Post-Logout Redirect

**Manifest Updated**: convergence.documentation_complete: true
```

### `/browser-test` (Browser Testing)

**Before**: Extracted UI criteria from `.claude/specs/active/<slug>.md`
**After**: Extracts UI criteria from atomic specs in spec group

Key changes:
- Loads spec group and lists atomic specs
- Extracts UI-specific acceptance criteria from each atomic spec
- Test cases reference atomic spec ID and AC (e.g., "as-004 AC1")
- Test results organized by atomic spec
- Updates `manifest.json` with `convergence.browser_tested`
- Adds Browser Test Evidence section to atomic specs

Test results format:
```markdown
## Test Cases by Atomic Spec

### as-001: Logout Button UI
- TC1 (as-001 AC1, AC2): ✅ PASS

### as-004: Error Handling & Feedback
- TC3 (as-004 AC1): ✅ PASS
- TC4 (as-004 AC2): ❌ FAIL
```

### `/refactor`

**Before**: Standalone skill using test suite as contract
**After**: Same contract, but with optional spec group context

Key changes:
- Added "Relationship to Spec Groups" section
- Refactoring log includes related spec group ID when applicable
- Notes which atomic specs are affected (for traceability)
- Verifies atomic spec test evidence still passes
- Does NOT update atomic specs (refactoring doesn't change behavior)

Refactoring log format:
```markdown
**Related Spec Group** (if applicable): sg-order-processing

### Change 1: Extract validation logic
- **Atomic Specs Affected**: as-001, as-002 (test evidence still valid)
```

---

## Appendix: Example Atomic Spec

```markdown
---
id: as-002
title: Token Clearing on Logout
status: implemented
requirements_refs: [REQ-002]
---

## Description

When user initiates logout, clear the authentication token from local storage.

## Acceptance Criteria

- AC1: When logout() is called, authentication token is removed from localStorage
- AC2: When logout() is called, auth state observable emits { isAuthenticated: false }

## Test Strategy

- Unit test: Mock localStorage, verify removeItem called with correct key
- Unit test: Subscribe to auth state, verify emission after logout

## Implementation Evidence

| File | Line | Description |
|------|------|-------------|
| src/services/auth-service.ts | 67 | logout() clears token |
| src/services/auth-service.ts | 70 | Auth state emission |

## Test Evidence

| AC | Test File | Line | Test Name | Status |
|----|-----------|------|-----------|--------|
| AC1 | auth-service.test.ts | 24 | "should clear token (as-002 AC1)" | ✅ Pass |
| AC2 | auth-service.test.ts | 35 | "should emit auth state (as-002 AC2)" | ✅ Pass |

## Decision Log

- `2026-01-14T10:30:00Z`: Created from spec.md decomposition
- `2026-01-14T14:30:00Z`: Implementation complete - auth-service.ts:67
- `2026-01-14T15:00:00Z`: Tests written - 2 tests covering AC1, AC2
```

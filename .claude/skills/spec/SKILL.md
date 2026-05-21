---
name: spec
description: Author oneoff specifications. Use TaskSpec detail for small-medium tasks and fuller design/contract sections for complex or large tasks. Use after /prd requirements gathering or when refining existing specs.
allowed-tools: Read, Write, Edit, Glob, Grep, Task
user-invocable: true
---

# Spec Author Skill

## Required Context

Before beginning work, read these files for project-specific guidelines:

- `.claude/memory-bank/best-practices/subagent-design.md`

## Pre-Flight Challenge

Before beginning work, address these operational feasibility questions:

1. Are the requirements operationally feasible given the current environment?
2. Do requirements assume infrastructure (services, databases, APIs) that may not exist?
3. Are there implicit execution dependencies not captured in the requirements?

If any question cannot be answered from available context, surface it as a finding -- do not skip.

## Purpose

Create specifications that serve as the authoritative contract for implementation. Specs document requirements, design decisions, task breakdowns, and test plans.

**Key Output**: Creates `spec.md` in a spec group, reading from `requirements.md`.

## Usage

```
/spec <spec-group-id>           # Create spec.md from requirements.md in spec group
/spec refine <spec-group-id>    # Refine existing spec based on feedback
```

## Prerequisites

Before running `/spec`:

1. Spec group must exist at `.claude/specs/groups/<spec-group-id>/`
2. `requirements.md` must exist (from `/prd` or `/prd sync`)
3. `manifest.json` must exist with valid metadata

## Output Location

All specs are written to the spec group directory:

```
.claude/specs/groups/<spec-group-id>/
├── manifest.json      # Updated by /spec
├── requirements.md    # Input (from /prd or /prd sync)
└── spec.md           # Output (created by /spec)
```

## Spec Tiers

The complexity of the spec is determined by the requirements, but **all specs output to `spec.md`** in the spec group.

### Light Spec - For Small to Medium Tasks

Use for:

- Single feature or enhancement
- 2-5 files impacted
- Clear scope, single concern
- Estimated 30 min - 4 hours

**Sections**:

- Context & Goal
- Requirements Summary (references requirements.md)
- Acceptance Criteria
- Design Notes (optional)
- Task List
- Test Plan
- Decision & Work Log

### Full Spec - For Complex or Large Tasks

Use for:

- Complex feature requiring detailed design
- Multiple components or layers involved
- Needs sequence diagrams and interface definitions
- Estimated 4+ hours
- Large effort with clear spec slices, dependencies, or parallel subagent opportunities

**Sections**:

- Context
- Goals / Non-goals
- Requirements Summary (references requirements.md)
- Core Flows
- Sequence Diagrams (Mermaid)
- Edge Cases
- Interfaces & Data Model
- Security
- Additional Considerations
- Task List
- Testing
- Open Questions
- Implementation Reflection
- Decision & Work Log

## Process: Spec Creation in Spec Group

### Step 1: Validate Spec Group

```
Read: .claude/specs/groups/<spec-group-id>/manifest.json
Read: .claude/specs/groups/<spec-group-id>/requirements.md
```

Verify:

- Spec group exists
- `requirements.md` has REQ-XXX requirements
- `manifest.json` has valid metadata

### Step 2: Read Requirements

From `requirements.md`, extract:

- Problem statement
- Goals and non-goals
- REQ-XXX requirements in EARS format
- Constraints and assumptions
- Open questions

### Step 3: Fill Context & Goal

From `requirements.md`:

- Summarize the problem and motivation
- State the clear goal and success criteria

### Step 4: Reference Requirements

**Do NOT duplicate requirements** — reference `requirements.md`:

```markdown
## Requirements Summary

See `requirements.md` for full EARS-format requirements.

| ID      | Title                 | Priority  |
| ------- | --------------------- | --------- |
| REQ-001 | User-initiated logout | Must Have |
| REQ-002 | Token clearing        | Must Have |
| REQ-003 | Post-logout redirect  | Must Have |
| REQ-004 | Error handling        | Must Have |
```

### Step 5: Define Acceptance Criteria

Map requirements to testable acceptance criteria:

```markdown
## Acceptance Criteria

- AC1.1: Logout button clears authentication token
- AC1.2: User is redirected to login page after logout
- AC1.3: Confirmation message is displayed
- AC2.1: Network error shows error message
- AC2.2: User remains logged in on error
- AC2.3: Retry button appears on error
```

### Step 5: Add Design Notes

If non-trivial, document approach:

- Architecture decisions
- Key algorithms or data structures
- Sequence diagrams for primary flows

```markdown
## Design Notes

The logout flow will:

1. Call `/api/auth/logout` endpoint
2. Clear local storage token on success
3. Update auth context state
4. Router will redirect based on auth state change

Sequence diagram:

\`\`\`mermaid
sequenceDiagram
autonumber
participant User
participant UI
participant AuthService
participant API
User->>UI: Click logout
UI->>AuthService: logout()
AuthService->>API: POST /api/auth/logout
API-->>AuthService: 200 OK
AuthService->>AuthService: clearToken()
AuthService-->>UI: Success
UI->>UI: Redirect to /login
UI-->>User: Show confirmation
\`\`\`
```

### Step 6: Generate Task List

Break down requirements into concrete tasks:

```markdown
## Task List

- [ ] Add logout button to UserMenu component
- [ ] Implement AuthService.logout() method
- [ ] Create /api/auth/logout endpoint
- [ ] Add error handling for network failures
- [ ] Update router to redirect on auth state change
- [ ] Add confirmation message toast
```

### Step 7: Map Test Plan

Map each acceptance criterion to test cases:

```markdown
## Test Plan

- AC1.1 → `__tests__/auth-service.test.ts`: "should clear token on logout"
- AC1.2 → `__tests__/auth-router.test.ts`: "should redirect to /login after logout"
- AC1.3 → `__tests__/user-menu.test.ts`: "should show confirmation message"
- AC2.1 → `__tests__/auth-service.test.ts`: "should show error on network failure"
- AC2.2 → `__tests__/auth-service.test.ts`: "should keep user logged in on error"
- AC2.3 → `__tests__/user-menu.test.ts`: "should show retry button on error"
```

### Step 8: Record Initial Decision

Add to Decision & Work Log:

```markdown
## Decision & Work Log

- 2026-01-14: Spec created from requirements.md
- 2026-01-14: Decision - Use toast for confirmation (consistent with existing patterns)
```

### Step 8b: Set E2E Testing Opt-Out (if applicable)

If the spec covers work that does not benefit from end-to-end testing, add opt-out fields to the YAML frontmatter:

```yaml
e2e_skip: true
e2e_skip_rationale: pure-refactor
```

**Valid `e2e_skip_rationale` values** (strict enum):

| Value           | Use When                                    |
| --------------- | ------------------------------------------- |
| `pure-refactor` | No new behavior to test end-to-end          |
| `test-infra`    | Changes to test infrastructure itself       |
| `type-only`     | Type-level changes with no runtime behavior |
| `docs-only`     | Documentation-only changes                  |

**Rules**:

- `e2e_skip` must be a boolean (`true` or `false`), not a string
- When `e2e_skip: true`, `e2e_skip_rationale` is required
- When `e2e_skip` is absent or `false`, e2e-test-writer is dispatched by default
- If the reason for skipping does not fit one of the four categories, use a gate override instead

### Step 8c: Set Runtime Validation Marker (if applicable)

If the spec touches runtime-loaded invocation or boot surfaces that static gates cannot fully validate, add runtime validation fields to the YAML frontmatter:

```yaml
runtime_validation_required: true
runtime_validation_surface: plugin
runtime_validation_rationale: plugin loader behavior must be validated by live boot
```

**Set `runtime_validation_required: true` for**:

- Plugins or plugin-bearing specs
- MCP tools
- External connectors
- Browser extensions
- Plugin loaders or plugin discovery/registration
- Dynamic tool/body resolution
- Similar runtime-loaded surfaces where import/schema/convergence gates can pass while live boot fails

**Valid `runtime_validation_surface` values**:

`plugin`, `mcp`, `connector`, `browser-extension`, `dynamic-tool-body`, `plugin-loader`, `other`

**Rules**:

- When `runtime_validation_required: true`, both `runtime_validation_surface` and `runtime_validation_rationale` are required
- Leave the fields absent or set `runtime_validation_required: false` for ordinary code, docs, tests, pure refactors, or static-only work
- Do not use `risk_tier`, `runtime_env`, or `crosses_boundary` as a substitute; this marker specifically controls mandatory `/manual-test` promotion
- Runtime-marked specs must later dispatch `manual-tester` and record a passing `record-manual-test-result` before documenting/completion can pass

### Step 9: Write spec.md

Save to spec group:

```
.claude/specs/groups/<spec-group-id>/spec.md
```

### Step 10: Update manifest.json

Update the spec group manifest:

```json
{
  "convergence": {
    "spec_complete": true
  },
  "decision_log": [
    // ... existing entries ...
    {
      "timestamp": "<ISO timestamp>",
      "actor": "agent",
      "action": "spec_authored",
      "details": "spec.md created with X ACs, Y tasks"
    }
  ]
}
```

### Step 11: Report Completion

```markdown
## Spec Created ✅

**Spec Group**: <spec-group-id>
**Location**: .claude/specs/groups/<spec-group-id>/spec.md

**Summary**:

- X acceptance criteria mapped to requirements
- Y tasks identified
- Z open questions

**Next Steps**:

1. Review spec: `.claude/specs/groups/<spec-group-id>/spec.md`

**Next workflow steps:**

2. Run `/investigate <spec-group-id>` for oneoff-spec work
3. User approves → `review_state: APPROVED`
4. Run `/implement <spec-group-id>` + `/test <spec-group-id>` (parallel)
```

## Process: Complex Specs

For complex features requiring sequence diagrams and interface definitions:

### Additional Sections Required

Follow the template structure:

1. **Context**: Background and motivation
2. **Goals / Non-goals**: Explicit boundaries
3. **Requirements**: Atomic, testable requirements (EARS format)
4. **Core Flows**: Primary user flows and system behaviors
5. **Sequence Diagram(s)**: At least one Mermaid diagram
6. **Edge Cases**: Failure scenarios and unusual conditions
7. **Interfaces & Data Model**: Contracts, APIs, data structures
8. **Security**: Security considerations and requirements
9. **Additional Considerations**: Best practices, docs, memory bank updates
10. **Task List**: Discrete tasks with dependencies
11. **Testing**: Testing strategy and coverage
12. **Open Questions**: Unresolved questions with status
13. **Implementation Reflection**: (Fill during/after implementation)
14. **Decision & Work Log**: Decisions and approvals

### Step 3: Define Contracts

If this spec creates interfaces used by other slices, modules, or systems:

```yaml
contracts:
  - id: contract-auth-service
    type: API
    path: src/services/auth.service.ts
    version: 1.0
```

List owned and consumed contracts in `spec.md` so implementation, tests, and review share the same boundary definitions.

### Step 4: Identify Dependencies

List other spec slices, modules, or external systems this work depends on:

```yaml
dependencies:
  - database-schema
  - api-gateway
```

## Large Spec Slices

For large efforts, keep one `spec.md` and add a compact slice table instead of
creating separate spec groups. Use slices only when they clarify parallel work
or dependency order.

```markdown
## Spec Slices

| Slice | Scope | Depends On | Parallelizable | Notes |
| ----- | ----- | ---------- | -------------- | ----- |
| api   | REST contract and handler changes | schema | no | schema first |
| ui    | User-facing screen changes | api contract | yes after contract approval | can start with mock contract |
```

Each slice should still map back to acceptance criteria and tests in the same
spec. Do not create decomposed spec files for new work.

## Spec is Contract Principle

**Critical constraint**: Spec is the authoritative source of truth.

- Implementation must conform to spec
- Tests must verify spec requirements
- Any deviation requires spec amendment first
- Spec updates require user approval

If during implementation you discover:

- Missing requirements → Add to spec Open Questions, get approval
- Invalid assumptions → Update spec, note in Decision Log
- Better approaches → Propose spec amendment before implementing

**Never deviate silently from the spec.**

## Spec Approval Process

Before implementation begins:

1. **Present spec summary** to user
2. **Highlight key decisions** and assumptions
3. **Call out open questions** that need resolution
4. **Request approval** to proceed
5. **Record approval** in Decision & Work Log with date

Example approval request:

```markdown
## Spec Ready for Approval

I've created a TaskSpec for adding the logout button.

**Key decisions**:

- Using toast for confirmation (consistent with existing patterns)
- Network errors keep user logged in and allow retry

**Open questions**:

- Should we add keyboard shortcut (Cmd+L) for logout? (Low priority, can defer)

**Task list**: 6 tasks, estimated 2-3 hours

May I proceed with implementation?
```

## Integration with Spec Group Workflow

After spec creation:

```
/prd → requirements.md
  ↓
/spec → spec.md (YOU ARE HERE)
  ↓
 /investigate
  ↓
 User approves → review_state: APPROVED
  ↓
 /implement + /test + /e2e-test as needed (parallel)
  ↓
/unify → convergence validation
  ↓
/code-review + /security
  ↓
Merge
```

### State After /spec Completes

```json
{
  "review_state": "DRAFT", // Still needs user review
  "work_state": "PLAN_READY", // Ready for investigation and approval
  "convergence": {
    "spec_complete": true // Spec authored
  }
}
```

### Handoff After /spec

After `/spec` creates `spec.md`:

1. User reviews spec
2. Run `/investigate <spec-group-id>`
3. User approves → `review_state: APPROVED`
4. Implementation begins with `/implement` + `/test`

## Examples

### Example 1: TaskSpec for Logout Button

```markdown
---
id: task-logout-button
title: Add Logout Button to User Dashboard
date: 2026-01-02
status: draft
---

# Add Logout Button to User Dashboard

## Context

Users currently cannot log out from the dashboard. They must manually delete cookies or close the browser.

## Goal

Provide a visible, accessible logout button that clears authentication and redirects to login page.

## Requirements (EARS Format)

- **WHEN** user clicks logout button
- **THEN** system shall clear authentication token
- **AND** redirect to login page
- **AND** display confirmation message

- **WHEN** logout fails due to network error
- **THEN** system shall display error message
- **AND** keep user logged in
- **AND** show retry button

## Acceptance Criteria

- AC1.1: Logout button clears authentication token
- AC1.2: User redirected to /login after logout
- AC1.3: Confirmation toast displayed
- AC2.1: Network error shows error message
- AC2.2: User remains logged in on error
- AC2.3: Retry button appears on error

## Design Notes

Use AuthService.logout() method. Toast for confirmation (consistent with existing patterns).

## Task List

- [ ] Add logout button to UserMenu component
- [ ] Implement AuthService.logout() method
- [ ] Add error handling for network failures
- [ ] Add confirmation toast
- [ ] Write tests for all acceptance criteria

## Test Plan

- AC1.1 → `__tests__/auth-service.test.ts`: "should clear token"
- AC1.2 → `__tests__/auth-router.test.ts`: "should redirect to /login"
- AC1.3 → `__tests__/user-menu.test.ts`: "should show confirmation"
- AC2.1 → `__tests__/auth-service.test.ts`: "should show error on failure"
- AC2.2 → `__tests__/auth-service.test.ts`: "should keep user logged in on error"
- AC2.3 → `__tests__/user-menu.test.ts`: "should show retry button"

## Decision & Work Log

- 2026-01-02: Spec created
- 2026-01-02: Decision - Toast for confirmation
```

### Example 2: Full Spec for WebSocket Server

Use the full spec sections above for structure.

Key sections filled:

- Context: Real-time notifications require WebSocket infrastructure
- Requirements: Authentication, message routing, connection management (EARS format)
- Sequence Diagram: Client connection, authentication, message delivery flows
- Contracts: `contract-websocket-api` with connection interface
- Dependencies: Notification Service slice
- Task List: 8 tasks broken down by component

# Route Skill — Edge-Case Examples

These edge-case routing examples were moved out of `./SKILL.md` to reduce the skill's baseline per-session token load. The canonical examples (trivial `oneoff-vibe`, default `oneoff-spec`, and large oneoff-spec) remain inline in `SKILL.md`. This file covers the less-common routing paths.

## Numbering Map

| This file | Scenario                       |
| --------- | ------------------------------ |
| Example 1 | Large oneoff-spec with findings |
| Example 2 | Exploration-First              |
| Example 3 | User Vibe Override             |
| Example 4 | Refactor                       |
| Example 5 | Refactor with Feature          |
| Example 6 | Journal-Only                   |
| Example 7 | Not Journal-Only               |

## Examples

### Example 1: Large Oneoff-Spec with Investigation Findings

**Request**: "Build deployment pipeline with build, deploy, and monitoring slices"

**Routing**:

- workflow: oneoff-spec
- rationale: Large infrastructure project with 3 distinct concerns that will share env vars, secrets, and container conventions
- estimated_scope: large
- spec_slices:
  - build: CI build pipeline
  - deploy: Deployment automation
  - monitor: Monitoring and alerting
- delegation:
  - parallel_subtasks:
    - spec slice analysis: spec-author / explore as needed
  - sequential_dependencies:
    - After spec is drafted: `/investigate sg-deployment-pipeline` (MANDATORY)
    - Investigation must complete before approval
    - Any blocker decisions must be resolved before implementation
  - investigation_required: true
- next_action: Use `/prd` to gather requirements, then create one spec with clear slices, contracts, and dependency order

**Post-Investigation (example)**:

After `/investigate sg-deployment-pipeline`:

```
Issues Found:
  - CRITICAL: monitor slice missing HMAC_SECRET, LOG_LEVEL from build template
  - HIGH: GIT_SSH_KEY_PATH (build) vs GIT_SSH_KEY_BASE64 (deploy) conflict
  - HIGH: Container image format inconsistency

Decisions Required:
  - DEC-001: SSH key variable naming
  - DEC-002: Container image format
  - DEC-003: Required env vars set
```

User must resolve decisions before implementation proceeds.

### Example 2: Exploration-First (Delegation for Research)

**Request**: "Improve performance of the search feature"

**Routing**:

- workflow: oneoff-spec
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

### Example 3: User Requests Vibe (Override)

**Request**: "Just add a console.log to debug this, don't need a spec"

**Routing**:

- workflow: oneoff-vibe
- rationale: User explicitly requested to skip spec ("don't need a spec"). Honoring user preference.
- estimated_scope: trivial
- delegation: none
- next_action: Make the change directly

**Note**: Without the explicit override, even a "simple" debug statement might warrant a spec if it's part of a larger investigation.

### Example 4: Refactor Request (refactor workflow)

**Request**: "Refactor the authentication service to use the repository pattern"

**Routing**:

- workflow: refactor
- rationale: Explicit refactoring request with pattern migration goal. No behavior changes expected - restructuring code organization only.
- estimated_scope: medium
- estimated_files: 3-5 (service, new repository, tests)
- delegation:
  - exploration_needed: true (understand current auth service structure)
  - parallel_subtasks:
    - codebase analysis: Explore subagent
  - sequential_dependencies:
    - exploration must complete before refactoring
    - tests must pass before refactoring (baseline)
    - tests must pass after refactoring (verification)
- next_action: Use `/refactor` skill to define scope and execute

### Example 5: Refactor with Feature (routes to oneoff-spec, NOT refactor)

**Request**: "Refactor the payment service and add support for crypto payments"

**Routing**:

- workflow: oneoff-spec
- rationale: Although request includes "refactor", it also adds new behavior (crypto payments). Behavior changes require spec workflow for proper requirements and testing. The refactor portion can be part of implementation.
- estimated_scope: medium-large
- estimated_files: 5+
- delegation:
  - parallel_subtasks:
    - implementation: implementer
    - tests: test-writer
- next_action: Use `/prd` to gather crypto payment requirements, then create TaskSpec

**Note**: Mixed requests (refactor + feature) always route to oneoff-spec because behavior changes need formal specification.

### Example 6: Investigation Complete (journal-only)

**Request**: "I just spent an hour debugging why the cache was stale. Found that Redis TTL was being set incorrectly. Document this for the team."

**Routing**:

- workflow: journal-only
- rationale: Investigation is complete, work is done. Findings are valuable for future developers who might encounter similar issues.
- journal_type: investigation
- delegation: none
- next_action: Create investigation journal documenting the Redis TTL issue, root cause, and fix applied

### Example 7: NOT Journal-Only (needs spec)

**Request**: "Found a bug during investigation. Want to fix it and document the fix."

**Routing**:

- workflow: oneoff-spec
- rationale: "Fix it" indicates future work, not documentation of completed work. Bug fixes need acceptance criteria even when simple.
- estimated_scope: small
- next_action: Use `/prd` to clarify bug behavior and expected fix, then create TaskSpec

**Note**: Journal-only is for documenting **completed** work. If work remains to be done (fix, implement, change), use a spec workflow.

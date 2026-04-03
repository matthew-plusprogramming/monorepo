---
name: investigate
description: Investigate connection points between specs, atomic specs, and master specs. Surface inconsistencies in env vars, APIs, data shapes, and deployment assumptions before implementation.
allowed-tools: Read, Glob, Grep, Task
user-invocable: true
---

# /investigate Skill

## Purpose

Investigate and surface connection points between different specs, systems, and components. Identify inconsistencies, conflicting assumptions, and missing contracts before they become implementation bugs.

**Key insight**: This is NOT schema validation. This is intelligent investigation of where systems touch and whether their assumptions align.

## Usage

```
/investigate <spec-group-id>              # Investigate connections within a spec group
/investigate <spec-group-id> --cross      # Include connections to other spec groups
/investigate ms-<id>                      # Investigate all workstreams in a master spec
/investigate --all                        # Investigate all active specs
/investigate <sg1> <sg2> <sg3>            # Investigate specific spec groups together
```

## When to Use

### Mandatory Checkpoints

1. **Before MasterSpec implementation** - After workstream specs written, before any implementation (mode: `standard`)
2. **Before oneoff-spec implementation** - After spec approval, before implementation begins (mode: `single-spec`)
3. **Before spec group depends on another** - When sg-B references sg-A outputs
4. **After consistency issues found** - When manual review reveals conflicts

### Recommended Checkpoints

1. **After requirements gathering** - Early detection of assumption conflicts
2. **During code review** - Validate implementation matches cross-spec contracts

## Prerequisites

Before running `/investigate`:

1. At least one spec group must exist
2. Spec(s) should have defined interfaces, env vars, or API endpoints
3. For `--cross`, multiple spec groups must exist

## Process

### 1. Scope Determination

Determine what's being investigated:

| Command                          | Scope                                         |
| -------------------------------- | --------------------------------------------- |
| `/investigate sg-logout`         | Single spec group + its declared dependencies |
| `/investigate sg-logout --cross` | sg-logout + all spec groups it touches        |
| `/investigate ms-auth-system`    | All workstreams in the master spec            |
| `/investigate --all`             | All active specs in `.claude/specs/groups/`   |
| `/investigate sg-a sg-b sg-c`    | Exactly those three spec groups               |

### 2. Investigation Convergence Loop

The investigation runs as a convergence loop with auto-decision engine integration.

**Loop state** (owned by this skill, not the investigator agent):

```json
{
  "gate": "investigation",
  "iteration_count": 0,
  "clean_pass_count": 0,
  "max_iterations": 5,
  "required_clean_passes": 2,
  "findings_history": [],
  "cross_stage_resolution_count": 0,
  "cross_stage_resolution_cap": 3
}
```

**Loop mechanics:**

1. **Dispatch investigator** for one pass:

```
Task: interface-investigator
Prompt: |
  Investigate connection points in scope: <scope>

  Spec groups: <list>
  Mode: <single-spec | cross | master>
  Pass: <iteration_count + 1>

  Focus on:
  1. Environment variable naming consistency
  2. API endpoint consistency (paths, methods, discovery)
  3. Data shape consistency (field names, types, required/optional)
  4. Deployment assumption consistency (infra, secrets management)
  5. Cross-spec dependencies and their assumptions

  Include structured confidence enum (high/medium/low) and deterministic finding IDs
  in format inv-{category}-{hash} for each finding.
```

2. **Evaluate findings**: If no Medium+ findings, increment `clean_pass_count`. Otherwise reset to 0.

3. **Auto-decision engine**: For Medium+ findings, invoke auto-decision engine:
   - Findings with valid recommendations (action verb + field reference + high/medium confidence) are auto-accepted
   - Security-tagged, low-confidence, and ambiguous findings escalate to human
   - Oscillation detection: if a finding ID recurs after its fix was applied, escalate immediately
   - All-or-nothing batch processing: if engine crashes, present all findings to human (graceful degradation)

4. **Apply fixes**: Dispatch spec-author with accepted and resolved findings to amend the spec.

5. **Check convergence**:
   - If `clean_pass_count >= 2`: **Converged**. Record convergence (see Step 3 below).
   - If `iteration_count >= 5`: **Escalate** to human with iteration history.
   - Otherwise: Back to step 1.

6. **Cross-stage resolution**: If a finding resolution introduces a blocker at the challenger stage, increment `cross_stage_resolution_count`. If count reaches 3, escalate to human.

### 3. Record Convergence

After 2 consecutive clean passes:

```bash
# Set manifest flat boolean for PHASE_OBLIGATIONS
# (implementer reads manifest.convergence.investigation_converged)
node -e "
const fs = require('fs');
const path = '<spec-group-dir>/manifest.json';
const m = JSON.parse(fs.readFileSync(path));
m.convergence = m.convergence || {};
m.convergence.investigation_converged = true;
fs.writeFileSync(path, JSON.stringify(m, null, 2) + '\\n');
"

# Set session.json for coercive enforcement
node .claude/scripts/session-checkpoint.mjs update-convergence investigation
```

### 4. Report Results

Surface findings for human decision-making (escalated findings only):

```
Interface Investigation: sg-auth-system + sg-user-management

Convergence: Achieved in <N> iterations (2 consecutive clean passes)
Auto-accepted findings: <count>
Escalated findings: <count>

Escalated Decisions Required: <count>
  DEC-001: SSH key variable naming [escalated: no recommendation]
  DEC-002: Container image format [escalated: security-tagged]

Full report: .claude/specs/groups/sg-auth-system/investigation-report.md
Audit trail: .claude/specs/groups/sg-auth-system/auto-decision-audit.json

Next steps:
  1. Resolve escalated decisions
  2. Proceed to challenger convergence loop
```

## Output

### Clean (No Issues)

```
Interface Investigation: sg-logout-button ✓

Connection Map:
  Inputs: 2 (auth-service session, user context)
  Outputs: 1 (logout API call)
  Assumptions: 3 (all documented)

No inconsistencies found.

Spec group interfaces are consistent and ready for implementation.
```

### Issues Found

```
Interface Investigation: ms-deployment-pipeline ✗

Scope: 3 workstreams (ws-build, ws-deploy, ws-monitor)

Inconsistencies Found:

CRITICAL (1):
  INC-001: Missing .env fields in ws-monitor
    - ws-build defines: HMAC_SECRET, LOG_LEVEL, LOG_MAX_BYTES
    - ws-monitor template missing all three
    - Impact: ws-monitor will fail at runtime
    - Evidence: .claude/specs/groups/ws-build/.env.template:12-15
                .claude/specs/groups/ws-monitor/.env.template (missing)

HIGH (2):
  INC-002: SSH Key naming conflict
    - ws-build: GIT_SSH_KEY_PATH (file path approach)
    - ws-deploy: GIT_SSH_KEY_BASE64 (encoded approach)
    - Evidence: ws-build/spec.md:47, ws-deploy/atomic/as-003.md:23

  INC-003: Container image format conflict
    - ws-build: Split (CONTAINER_IMAGE + CONTAINER_IMAGE_TAG)
    - ws-deploy: Combined (CONTAINER_IMAGE=repo:tag)
    - Evidence: ws-build/spec.md:52-53, ws-deploy/spec.md:31

Decisions Required: 3

  DEC-001: SSH key variable naming
    Options: a) GIT_SSH_KEY_PATH  b) GIT_SSH_KEY_BASE64  c) GIT_SSH_KEY
    Recommendation: (c) - most portable
    Affected: ws-build, ws-deploy

  DEC-002: Container image format
    Options: a) Split  b) Combined
    Recommendation: (b) - simpler, standard
    Affected: ws-build, ws-deploy, CI/CD scripts

  DEC-003: Required env vars
    Options: a) ws-build set  b) ws-monitor set  c) Union
    Recommendation: (a) - more complete
    Affected: ws-monitor

Full report: .claude/specs/groups/ms-deployment-pipeline/investigation-report.md

BLOCKED: Cannot proceed to implementation until Critical issue resolved.

Next steps:
  1. Decide on DEC-001, DEC-002, DEC-003
  2. Update affected specs with canonical decisions
  3. Re-run /investigate to confirm resolution
```

## Integration with Workflow

### In oneoff-spec Workflow

```
/route → PM → Spec → /investigate (MANDATORY, convergence loop) → /challenge (convergence loop) → Auto-Approval → Implement
```

### In orchestrator Workflow

```
/route → PM → MasterSpec → [Parallel: WorkstreamSpecs]
                                    ↓
                              /investigate ms-<id>  ← MANDATORY (convergence loop)
                                    ↓
                              /challenge (convergence loop, pre-orchestration)
                                    ↓
                              Auto-Approval
                                    ↓
                        [Parallel: Implement per workstream]
```

### Triggered by /route

For complex tasks with multiple workstreams or dependencies, `/route` will recommend `/investigate` before implementation:

```
/route analysis: orchestrator workflow recommended

Before implementation:
  1. Run /investigate ms-<id> (convergence loop, auto-decision)
  2. Run /challenge (convergence loop, auto-decision)
  3. Auto-approval after both converge
  4. Proceed to parallel implementation
```

## State Transitions

After `/investigate`:

**If CLEAN:**

- `manifest.json`:
  - `investigation_status`: "clean"
  - `last_investigated`: <timestamp>
- Ready for implementation

**If ISSUES:**

- `manifest.json`:
  - `investigation_status`: "issues_found"
  - `investigation_blockers`: <count>
  - `investigation_decisions_pending`: <count>
- Creates `investigation-report.md` in spec group
- Implementation blocked until blockers resolved

## Creating Contracts

When investigation surfaces repeated patterns, suggest creating canonical contracts:

```
Recommendation: Create canonical contracts

Based on this investigation, consider creating:

1. .claude/contracts/env-vars.contract.md
   - Canonical names for: GIT_SSH_KEY, CONTAINER_IMAGE, LOG_*
   - Discovery patterns for each

2. .claude/contracts/api-auth.contract.md
   - Canonical endpoint paths
   - Request/response shapes

These would prevent future inconsistencies.

Create contracts now? (run /contract create)
```

## Edge Cases

### No Dependencies Declared

```
Note: Spec group has no declared dependencies
Investigation limited to internal consistency

To investigate cross-spec connections, either:
  1. Add dependencies to manifest.json
  2. Run /investigate sg-a sg-b explicitly
```

### Spec Group Not Found

```
Error: Spec group 'sg-unknown' not found
Available spec groups:
  - sg-logout-button
  - sg-auth-system
  - sg-user-management
```

### MasterSpec Without Workstreams

```
Error: MasterSpec ms-pipeline has no workstream references
Cannot investigate cross-workstream connections

Ensure MasterSpec has workstreams defined in frontmatter.
```

## Comparison with /unify

| Aspect     | /investigate                       | /unify                           |
| ---------- | ---------------------------------- | -------------------------------- |
| **When**   | Before implementation              | After implementation             |
| **What**   | Spec-to-spec consistency           | Spec-to-implementation alignment |
| **Focus**  | Assumptions, interfaces, contracts | Evidence, tests, traceability    |
| **Blocks** | Implementation                     | Merge                            |

Think of it as:

- `/investigate` = "Do our specs agree with each other?"
- `/unify` = "Does our code match our specs?"

---
name: challenge
description: Dispatch the challenger agent for operational feasibility scrutiny. Convergence loop for pre-implementation and pre-orchestration stages; single-pass for pre-test and pre-review. MANDATORY for both oneoff-spec and orchestrator workflows.
allowed-tools: Read, Glob, Grep, Task
user-invocable: true
---

# Challenge Skill

## Purpose

Dispatch the challenger agent as a dedicated subagent for operational feasibility scrutiny. This is a **mandatory** workflow step for both oneoff-spec and orchestrator workflows.

- **pre-implementation** and **pre-orchestration**: Run as a **convergence loop** (2 consecutive clean passes, auto-decision engine integration)
- **pre-test** and **pre-review**: Run as a **single-pass** check

The embedded pre-flight questions in each skill still run as part of normal skill execution -- this dedicated dispatch provides additional scrutiny as a separate workflow step.

## Usage

```
/challenge <spec-group-id> --stage <stage>
```

**Stage values**: `pre-implementation`, `pre-test`, `pre-review`, `pre-orchestration`

## When to Use

The dedicated `/challenge` dispatch is **MANDATORY** at all 4 stages for oneoff-spec and orchestrator workflows:

- **`pre-implementation`** (convergence loop): After investigation convergence, before implementation begins. Fix agent: `implementer`.
- **`pre-test`** (single-pass): After implementation completes, before test verification gates (Integration Verify). Validates test fixtures, test data availability, test infrastructure readiness.
- **`pre-review`** (single-pass): After Unify (loop), before Code Review (loop). Identifies riskiest change areas, integration surfaces crossed, review focus recommendations.
- **`pre-orchestration`** (convergence loop, orchestrator only): After investigation convergence, before /orchestrate begins. Fix agent: `spec-author`.

The dedicated `/challenge` dispatch is **NOT required** for:

- **oneoff-vibe workflows**: Too lightweight to warrant dedicated scrutiny
- **refactor workflows**: Behavior preservation is enforced by tests, not pre-flight checks
- **journal-only workflows**: No implementation to challenge

## Process

### Step 1: Determine Stage and Mode

| Workflow Phase        | Stage Parameter      | Mode             | Fix Agent     |
| --------------------- | -------------------- | ---------------- | ------------- |
| Before implementation | `pre-implementation` | Convergence loop | `implementer` |
| Before test writing   | `pre-test`           | Single-pass      | N/A           |
| Before code review    | `pre-review`         | Single-pass      | N/A           |
| Before orchestration  | `pre-orchestration`  | Convergence loop | `spec-author` |

### Step 2: Gather Stage-Specific Input Context

| Stage                | Required Input Context                                                               |
| -------------------- | ------------------------------------------------------------------------------------ |
| `pre-implementation` | Approved spec, environment configuration, dependency manifest, execution environment |
| `pre-test`           | Approved spec, implementation artifacts (file paths), test infrastructure inventory  |
| `pre-review`         | Spec, implementation diff/artifacts, integration boundary list                       |
| `pre-orchestration`  | MasterSpec/WorkstreamSpecs, workstream dependency graph, shared resource inventory   |

### Step 3: Execute (Convergence Loop or Single-Pass)

#### For convergence loop stages (pre-implementation, pre-orchestration):

**Loop state** (owned by this skill):

```json
{
  "gate": "challenger",
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

1. **Dispatch challenger** for one pass:

```
Task: challenger
Prompt: |
  Stage: <stage parameter>
  Spec group: <spec-group-id>
  Pass: <iteration_count + 1>

  Input context:
    <stage-specific context from Step 2>

  Perform deep operational feasibility scrutiny.
  Produce severity-rated findings (Critical/High/Medium/Low) with:
    - Structured confidence enum (high/medium/low)
    - Deterministic finding IDs in format chk-{category}-{hash}
  Reference env var names only -- never actual secret values.
  Return < 200 words.
```

2. **Evaluate findings**: If no Medium+ findings, increment `clean_pass_count`. Otherwise reset to 0.

3. **Auto-decision engine**: For Medium+ findings, invoke auto-decision engine:
   - Findings with valid recommendations (action verb + field reference + high/medium confidence) are auto-accepted
   - Security-tagged, low-confidence, and ambiguous findings escalate to human
   - Oscillation detection: if a finding ID recurs after its fix was applied, escalate immediately
   - All-or-nothing batch processing: if engine crashes, present all findings to human

4. **Apply fixes**: Dispatch fix agent (implementer or spec-author) with accepted and resolved findings.

5. **Check convergence**:
   - If `clean_pass_count >= 2`: **Converged**. Record convergence (see Step 4 below).
   - If `iteration_count >= 5`: **Escalate** to human with iteration history.
   - Otherwise: Back to step 1.

#### For single-pass stages (pre-test, pre-review):

Dispatch challenger once and process findings:

```
Task: challenger
Prompt: |
  Stage: <stage parameter>
  Spec group: <spec-group-id>

  Input context:
    <stage-specific context from Step 2>

  Perform deep operational feasibility scrutiny.
  Produce severity-rated findings (Critical/High/Medium/Low).
  Reference env var names only -- never actual secret values.
  Return < 200 words.
```

Process findings directly:

- **Critical/High findings**: Block -- resolve before proceeding to the target stage
- **Medium findings**: Log as warnings, proceed with awareness
- **Low findings**: Log only

### Step 4: Record Convergence (Convergence Loop Stages Only)

After 2 consecutive clean passes:

```bash
# Set manifest flat boolean for PHASE_OBLIGATIONS
node -e "
const fs = require('fs');
const path = '<spec-group-dir>/manifest.json';
const m = JSON.parse(fs.readFileSync(path));
m.convergence = m.convergence || {};
m.convergence.challenger_converged = true;
fs.writeFileSync(path, JSON.stringify(m, null, 2) + '\\n');
"

# Set session.json for coercive enforcement
node .claude/scripts/session-checkpoint.mjs update-convergence challenger
```

## Finding Deduplication

If both `/challenge` and `/investigate` produce findings about the same issue:

- Investigation findings take precedence (formal convergence gate vs. challenger)
- Deduplication occurs at the orchestrator level

## Integration with Workflow

```
Embedded pre-flight (always active in each skill):
  Subagent reads SKILL.md -> Encounters Pre-Flight Challenge section -> Addresses questions inline

Dedicated dispatch (MANDATORY at all 4 stages for oneoff-spec and orchestrator, this skill):
  pre-implementation: After investigation convergence -> /challenge (convergence loop) -> Auto-Approval -> Implementation begins
  pre-test:           After impl   -> /challenge --stage pre-test (single-pass) -> Proceed or block -> Integration Verify begins
  pre-review:         After unify  -> /challenge --stage pre-review (single-pass) -> Proceed or block -> Code Review begins
  pre-orchestration:  After investigation convergence -> /challenge (convergence loop) -> Auto-Approval -> /orchestrate begins
```

## Examples

### Example 1: Pre-Implementation Challenge (Convergence Loop)

```
/challenge sg-auth-system --stage pre-implementation

Iteration 1:
  Findings: 1 High (auto-accepted), 0 Critical
  Auto-accepted: chk-env-a1b2c3d4 (add DATABASE_URL to .env)
  Fix agent (implementer) applied recommendation.

Iteration 2: Clean pass (clean_pass_count = 1)
Iteration 3: Clean pass (clean_pass_count = 2)

Convergence achieved in 3 iterations.
challenger_converged = true recorded in manifest.
```

### Example 2: Pre-Orchestration Challenge (Convergence Loop)

```
/challenge ms-deployment-pipeline --stage pre-orchestration

Iteration 1:
  Findings: 0 Critical, 0 High, 2 Medium
  Auto-accepted: chk-resource-b2c3d4e5 (document shared CONTAINER_REGISTRY)
  Escalated: chk-health-c3d4e5f6 (no health check endpoint -- security-tagged)
  Human resolved: accepted health check recommendation

Iteration 2: Clean pass (clean_pass_count = 1)
Iteration 3: Clean pass (clean_pass_count = 2)

Convergence achieved in 3 iterations.
```

### Example 3: Pre-Test Challenge (Single-Pass)

```
/challenge sg-auth-system --stage pre-test

Challenger findings:
  Critical: 0
  High: 0
  Medium: 1
    CHK-001: Test database not seeded with required fixtures
  Low: 1

Action: Log warnings, proceed to Integration Verify.
```

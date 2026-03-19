---
name: challenge
description: Dispatch the challenger agent for dedicated operational feasibility scrutiny. MANDATORY for both oneoff-spec and orchestrator workflows, running after investigation and before implementation.
allowed-tools: Read, Glob, Grep, Task
user-invocable: true
---

# Challenge Skill

## Purpose

Dispatch the challenger agent as a dedicated subagent for deeper operational feasibility scrutiny than embedded pre-flight questions provide. This is a **mandatory** workflow step for both oneoff-spec and orchestrator workflows, running after investigation and before implementation. The embedded pre-flight questions in each skill still run as part of normal skill execution -- this dedicated dispatch provides additional scrutiny as a separate workflow step.

## Usage

```
/challenge <spec-group-id> --stage <stage>
```

**Stage values**: `pre-implementation`, `pre-test`, `pre-review`, `pre-orchestration`

## When to Use

The dedicated `/challenge` dispatch is **MANDATORY** at all 4 stages for oneoff-spec and orchestrator workflows:

- **`pre-implementation`**: After investigation/approve, before implementation begins. Validates env vars, dependencies, infrastructure prerequisites, execution feasibility.
- **`pre-test`**: After implementation completes, before test verification gates (Integration Verify). Validates test fixtures, test data availability, test infrastructure readiness.
- **`pre-review`**: After Unify (loop), before Code Review (loop). Identifies riskiest change areas, integration surfaces crossed, review focus recommendations.
- **`pre-orchestration`** (orchestrator only): After investigation/approve, before /orchestrate begins. Validates cross-workstream conflicts, shared resource contention, sequencing risks.

The dedicated `/challenge` dispatch is **NOT required** for:

- **oneoff-vibe workflows**: Too lightweight to warrant dedicated scrutiny
- **refactor workflows**: Behavior preservation is enforced by tests, not pre-flight checks
- **journal-only workflows**: No implementation to challenge

## Process

### Step 1: Determine Stage

Match the current workflow phase to the appropriate stage parameter:

| Workflow Phase        | Stage Parameter      |
| --------------------- | -------------------- |
| Before implementation | `pre-implementation` |
| Before test writing   | `pre-test`           |
| Before code review    | `pre-review`         |
| Before orchestration  | `pre-orchestration`  |

### Step 2: Gather Stage-Specific Input Context

| Stage                | Required Input Context                                                               |
| -------------------- | ------------------------------------------------------------------------------------ |
| `pre-implementation` | Approved spec, environment configuration, dependency manifest, execution environment |
| `pre-test`           | Approved spec, implementation artifacts (file paths), test infrastructure inventory  |
| `pre-review`         | Spec, implementation diff/artifacts, integration boundary list                       |
| `pre-orchestration`  | MasterSpec/WorkstreamSpecs, workstream dependency graph, shared resource inventory   |

### Step 3: Dispatch Challenger Agent

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

### Step 4: Process Findings

Review the challenger's return:

- **Critical/High findings**: Block -- resolve before proceeding to the target stage
- **Medium findings**: Log as warnings, proceed with awareness
- **Low findings**: Log only

If blockers are found:

1. Surface to the human for resolution
2. If spec amendment required: amend spec, then re-run `/challenge` against the amended spec
3. Verify original blocker resolved and no new blockers introduced

## Finding Deduplication

If both `/challenge` and `/investigate` produce findings about the same issue:

- Investigation findings take precedence (formal convergence gate vs. pre-flight check)
- Deduplication occurs at the orchestrator level

## Integration with Workflow

```
Embedded pre-flight (always active in each skill):
  Subagent reads SKILL.md -> Encounters Pre-Flight Challenge section -> Addresses questions inline

Dedicated dispatch (MANDATORY at all 4 stages for oneoff-spec and orchestrator, this skill):
  pre-implementation: After approve -> /challenge --stage pre-implementation -> Proceed or block -> Implementation begins
  pre-test:           After impl   -> /challenge --stage pre-test           -> Proceed or block -> Integration Verify begins
  pre-review:         After unify  -> /challenge --stage pre-review         -> Proceed or block -> Code Review begins
  pre-orchestration:  After approve -> /challenge --stage pre-orchestration -> Proceed or block -> /orchestrate begins
```

## Examples

### Example 1: Pre-Implementation Challenge

```
/challenge sg-auth-system --stage pre-implementation

Challenger findings:
  Critical: 0
  High: 1
    CHK-001: DATABASE_URL not configured in .env -- deployment will fail
  Medium: 0
  Low: 0

Action: Resolve CHK-001 before dispatching implementer.
```

### Example 2: Pre-Orchestration Challenge

```
/challenge ms-deployment-pipeline --stage pre-orchestration

Challenger findings:
  Critical: 0
  High: 0
  Medium: 2
    CHK-001: ws-build and ws-deploy share CONTAINER_REGISTRY -- verify no contention
    CHK-002: ws-monitor has no health check endpoint defined
  Low: 1

Action: Log warnings, proceed with orchestration.
```

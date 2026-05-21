---
name: challenge
description: Dispatch the challenger agent for operational feasibility scrutiny before implementation. Required pre-implementation for oneoff-spec workflows.
allowed-tools: Read, Glob, Grep, Task
user-invocable: true
---

# Challenge Skill

## Required Context

Before beginning work, read these files for project-specific guidelines:

- `.claude/memory-bank/best-practices/subagent-design.md`
- `.claude/memory-bank/tech.context.md`

## Purpose

Dispatch the challenger agent as a dedicated subagent for operational feasibility scrutiny. This is required for oneoff-spec at `pre-implementation`, after investigation convergence and before implementation.

The embedded pre-flight questions in each skill still run as part of normal skill execution -- this dedicated dispatch provides additional scrutiny as a separate workflow step.

## Usage

```
/challenge <spec-group-id> --stage <stage>
```

**Stage value**: `pre-implementation`

## When to Use

Use the dedicated `/challenge` dispatch at the required challenger stage:

- **`pre-implementation`**: Oneoff-spec only. After investigation convergence, before implementation begins. Fix agent: `implementer`.

The dedicated `/challenge` dispatch is **NOT required** for:

- **oneoff-vibe workflows**: Too lightweight to warrant dedicated scrutiny
- **refactor workflows**: Behavior preservation is enforced by tests, not pre-flight checks
- **journal-only workflows**: No implementation to challenge
- **testing or review transitions**: Former post-implementation challenger dispatches were deleted. `/unify` preflight and reviewer-focus metadata now carry those signals.

## Process

### Step 1: Determine Stage and Mode

| Workflow Phase        | Stage Parameter      | Fix Agent     |
| --------------------- | -------------------- | ------------- |
| Before implementation | `pre-implementation` | `implementer` |

### Step 2: Gather Stage-Specific Input Context

| Stage                | Required Input Context                                                               |
| -------------------- | ------------------------------------------------------------------------------------ |
| `pre-implementation` | Approved spec, environment configuration, dependency manifest, execution environment |

### Step 3: Execute Convergence Loop

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
  Return the structured findings needed for convergence.
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

**Cross-stage resolution guidance** (advisory -- not code-enforced): If a fix at one stage introduces a blocker at another stage, the operator should escalate to the human after roughly 3 round-trips with the full blocker chain rather than continue indefinitely. This prevents infinite oscillation between stages.

### Step 4: Record Convergence (Convergence Loop Stages Only)

After 2 consecutive clean passes, run the canonical recorder:

```bash
node .claude/scripts/session-checkpoint.mjs update-convergence challenger
```

Do not edit `manifest.json` or `session.json` directly. On verified convergence, `update-convergence` updates the session counters and mirrors `convergence.challenger_converged = true` to the manifest.

## Finding Deduplication

If both `/challenge` and `/investigate` produce findings about the same issue:

- Investigation findings take precedence (formal convergence gate vs. challenger)
- Deduplication occurs in the main spec convergence loop

## Integration with Workflow

```
Embedded pre-flight (always active in each skill):
  Subagent reads SKILL.md -> Encounters Pre-Flight Challenge section -> Addresses questions inline

Dedicated dispatch (this skill):
  oneoff-spec:   After investigation convergence -> /challenge --stage pre-implementation -> Auto-Approval -> Implementation begins
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

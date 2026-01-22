---
name: <agent-name>
description: <Brief description of the agent's purpose and behavior>
tools: <Comma-separated list: Read, Write, Edit, Glob, Grep, Bash>
model: opus
skills: <optional: comma-separated skill names>
exit_validation: <optional: array of validation steps>
---

# <Agent Name> Subagent

You are a <agent-name> subagent responsible for <primary responsibility>.

## YAML Frontmatter Schema

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique identifier for the agent (lowercase, hyphenated) |
| `description` | string | Brief description of purpose and behavior |
| `tools` | string | Comma-separated list of allowed tools |
| `model` | string | Model to use (typically "opus") |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `skills` | string | Comma-separated list of associated skills |
| `exit_validation` | array | Validation steps to run before completion |

### exit_validation Schema

The `exit_validation` field specifies automated checks that MUST pass before the agent can report completion.

**Valid values**: `lint`, `build`, `test`

**Example configurations**:

```yaml
# For implementation agents (code changes)
exit_validation: [lint, build, test]

# For test-writing agents (test files only)
exit_validation: [lint, test]

# For read-only agents (no validation needed)
# Omit exit_validation field entirely
```

**Behavior by validation type**:

| Validation | Command | Purpose |
|------------|---------|---------|
| `lint` | `npm run lint` | Ensure code style compliance |
| `build` | `npm run build` | Verify TypeScript compilation |
| `test` | `npm test` | Confirm all tests pass |

**Execution order**: Validations run in the order specified. Failing any validation blocks completion.

**Agent requirements**:
- Agents with `exit_validation` MUST run all specified checks before reporting completion
- If any validation fails, the agent MUST fix issues or escalate
- Validation results MUST be included in the completion report

## Your Role

<Describe the agent's primary function and value proposition>

**Critical**: <Key constraint or invariant>

## When You're Invoked

You're dispatched when:
1. <Scenario 1>
2. <Scenario 2>
3. <Scenario 3>

## Your Responsibilities

### 1. <First Responsibility>

<Details>

### 2. <Second Responsibility>

<Details>

### N. Exit Validation (Required)

Before reporting completion, run all exit validations:

```bash
# Run all validations specified in frontmatter
npm run lint      # If lint in exit_validation
npm run build     # If build in exit_validation
npm test          # If test in exit_validation
```

All validations must pass. Include results in completion report:

```markdown
## Exit Validation

| Check | Status | Details |
|-------|--------|---------|
| lint | PASS | 0 warnings |
| build | PASS | Compiled successfully |
| test | PASS | 147 tests, 100% passing |
```

If any validation fails:
1. Attempt to fix the issue
2. Re-run validation
3. If still failing, escalate with details

## Guidelines

<Agent-specific best practices>

## Constraints

<Hard rules the agent must follow>

## Success Criteria

<What defines successful completion>

## Handoff

<What happens after this agent completes>

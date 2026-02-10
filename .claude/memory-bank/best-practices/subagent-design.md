---
domain: agents
tags: [agents, delegation, prompts]
---

# Subagent Design Best Practices

## Subagent Philosophy

Each subagent is a **specialist** with:

- A focused purpose (one job done well)
- Appropriate tools (no more, no less)
- Clear boundaries (knows what it doesn't do)
- Structured output (summaries the main agent can use)

## Agent Definition Structure

### Frontmatter Schema

```yaml
---
agent_name: implementer
model: opus
tools: [Read, Write, Edit, Bash, Glob, Grep]
delegatable: true
purpose: Implement from approved specs with traceability
---
```

### Required Sections

1. **Purpose**: One-sentence description of the agent's role
2. **When You're Invoked**: Conditions that trigger this agent
3. **Your Responsibilities**: What this agent does
4. **Guidelines**: How to do it well
5. **Constraints**: What this agent must NOT do
6. **Output Contract**: What to return to main agent

## Tool Assignment

### Principle of Least Privilege

Give agents only the tools they need:

| Agent               | Tools                               | Rationale                      |
| ------------------- | ----------------------------------- | ------------------------------ |
| `explore`           | Read, Glob, Grep                    | Information gathering only     |
| `implementer`       | Read, Write, Edit, Bash, Glob, Grep | Full implementation capability |
| `code-reviewer`     | Read, Glob, Grep                    | Read-only review               |
| `security-reviewer` | Read, Glob, Grep                    | Read-only security analysis    |

### Tool Exclusions

- **Read-only agents** (reviewers): No Write, Edit
- **Research agents** (explore): No Edit (report findings, don't change)
- **Validation agents** (unifier): Read to verify, but flag issues rather than fix

## Writing Effective Agent Prompts

### Be Specific About Scope

**Bad** (too vague):

```markdown
You implement features.
```

**Good** (clear scope):

```markdown
You implement code changes from approved atomic specs. Each atomic spec
describes a single behavior to implement. You follow the spec exactly,
escalating when requirements are unclear rather than making assumptions.
```

### Include Anti-Goals

State what the agent should NOT do:

```markdown
## What This Agent Does NOT Do

- Does not write tests (test-writer handles that)
- Does not approve specs (user approval required)
- Does not make architectural decisions (escalate to main agent)
- Does not deviate from spec (propose amendments instead)
```

### Specify Output Format

```markdown
## Output Contract

Return to main agent:

1. **Summary**: 2-3 sentences on what was accomplished
2. **Files Modified**: List with line numbers
3. **Evidence**: How each AC was satisfied
4. **Issues**: Any blockers or concerns discovered
```

## Escalation Protocols

### When Subagents Should Escalate

Define clear escalation triggers:

```markdown
## Escalation Triggers

Escalate to main agent when:

- Spec is ambiguous about a requirement
- Discovered behavior conflicts with spec assumption
- Implementation would break existing functionality
- Security concern not addressed in spec
- Task scope expands beyond original spec
```

### How to Escalate

```markdown
## Escalation Format

When escalating, provide:

1. **Issue**: What problem was discovered
2. **Context**: Where in the implementation this occurred
3. **Options**: Possible resolutions (if any)
4. **Recommendation**: Your suggested path forward
5. **Blocking**: Whether work can continue without resolution
```

## Parallel-Safe Design

### Avoiding Conflicts

When multiple agents work in parallel:

```markdown
## Parallel Execution Notes

This agent may run in parallel with test-writer. To avoid conflicts:

- Coordinate file access via spec's file list
- Implementation writes to src/
- Tests write to **tests**/
- Both can read but only one modifies each file
```

### Contract Boundaries

For orchestrated workstreams:

```markdown
## Contract Compliance

This workstream produces:

- Interface: AuthService with logout() method
- Events: LOGOUT_SUCCESS, LOGOUT_FAILURE

Other workstreams may depend on these contracts. Do not change
signatures without updating MasterSpec contract registry.
```

## Agent Collaboration Patterns

### Sequential Handoff

```
explore → findings → spec-author → spec → implementer → code
```

Each agent completes before the next starts.

### Parallel Execution

```
         ┌→ implementer → code
spec → ─┤
         └→ test-writer → tests
```

Both work from same spec, different outputs.

### Review Chain

```
code → code-reviewer → findings → security-reviewer → findings → main agent
```

Read-only agents in sequence, findings aggregated.

## Quality Markers

### What Makes a Good Subagent

| Marker               | Description                                  |
| -------------------- | -------------------------------------------- |
| **Focused**          | Does one thing well                          |
| **Predictable**      | Same input produces consistent output        |
| **Bounded**          | Knows its limits and escalates appropriately |
| **Traceable**        | Output links back to input requirements      |
| **Self-documenting** | Logs what it did and why                     |

### Testing Agent Behavior

Validate agents with scenarios:

```markdown
## Test Scenarios

1. **Happy path**: Spec is clear, implementation straightforward
   - Expected: Complete implementation, all ACs satisfied

2. **Ambiguous spec**: Requirement has multiple interpretations
   - Expected: Escalation with options, not assumption

3. **Conflicting requirement**: Spec conflicts with codebase reality
   - Expected: Escalation with evidence, proposed amendment

4. **Scope creep**: Discover needed change outside spec
   - Expected: Complete spec scope, note additional work needed
```

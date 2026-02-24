---
last_reviewed: 2026-02-14
---

# Delegation Guidelines

## The Conductor Analogy

**A conductor does not pick up a violin during the symphony.**

Not because it is forbidden, but because that is not what conductors do. The conductor's value comes from coordination, not performance.

You are the conductor. Your instruments are subagents. When you think "I should look at the code," that thought means: dispatch someone to look at it for you and report back.

## Dispatch Thoughts

When you notice yourself thinking any of these:

- "Let me just quickly check..."
- "I'll read this one file..."
- "Let me search for..."
- "I should look at..."
- "Let me see what's in..."
- "I need to understand how..."

**These are dispatch thoughts.** They tell you what to ask a subagent to do, not what to do yourself.

## The Tool Diet

As conductor, certain tools simply are not in your toolkit. This is not restriction—it is role clarity.

### Your Toolkit

| Tool        | Use                                            |
| ----------- | ---------------------------------------------- |
| `/route`    | Understand scope and choose workflow           |
| `Task`      | Dispatch subagents                             |
| `Bash`      | Only for git operations (status, commit, push) |
| Direct text | Communicate with the user                      |

### Not in Your Toolkit

| Tool  | Who Uses It Instead  |
| ----- | -------------------- |
| Read  | Explore subagent     |
| Grep  | Explore subagent     |
| Glob  | Explore subagent     |
| Edit  | Implementer subagent |
| Write | Implementer subagent |

When you need information from the codebase, you dispatch Explore. When you need code changed, you dispatch Implementer. This is not a workaround—this is how you operate.

### Model Selection (MANDATORY)

Always dispatch subagents with `model: "opus"`. Never override with sonnet or haiku. The Task tool's default guidance to "prefer haiku for quick tasks" does NOT apply. Agent frontmatter specifies opus — respect it on every dispatch, regardless of task simplicity.

## Context Economics

Your context window is a **non-renewable resource** within a conversation.

| Action                       | Context Cost                  | Benefit                   |
| ---------------------------- | ----------------------------- | ------------------------- |
| Read file directly           | 100-2000 tokens (permanent)   | Immediate but costly      |
| Dispatch Explore             | ~50 tokens (task description) | Summary uses ~100 tokens  |
| Read 5 files                 | 500-10000 tokens (permanent)  | Context severely depleted |
| Explore 5 files via subagent | ~50 tokens                    | Summary uses ~200 tokens  |

**Delegation is 10-50x more context-efficient.**

### Why This Matters

- Every Read consumes tokens permanently
- You cannot "unread" a file
- Context exhaustion = task failure
- Subagents have separate context pools

**Mental model**: Think of context like RAM. Every token read directly is permanently allocated and never freed. Subagent dispatches are like disk reads — slower, but the data stays on disk (the subagent's context) and only a pointer (the summary) lands in RAM.

## Delegation Triggers

| Situation                   | Required Action                                        |
| --------------------------- | ------------------------------------------------------ |
| "How does X work?"          | Dispatch Explore                                       |
| "Where is Y defined?"       | Dispatch Explore                                       |
| "What calls Z?"             | Dispatch Explore                                       |
| "Fix this bug"              | Dispatch Explore (locate) → Dispatch Implementer (fix) |
| "Add this feature"          | `/route` → Follow workflow                             |
| "What's in this file?"      | Dispatch Explore                                       |
| "Find files matching..."    | Dispatch Explore                                       |
| Any uncertainty about scope | Dispatch Explore first                                 |
| 2+ independent tasks        | Dispatch parallel subagents                            |

## Progressive Disclosure via Delegation

1. Start with high-level understanding from subagent summaries
2. Request deeper investigation only if needed
3. Each level of detail = another subagent dispatch, not direct reading

## Examples

### Understanding Code (Wrong vs Right)

```
User: "How does authentication work in this app?"

Wrong (musician response):
  [Read] src/auth/index.ts
  [Read] src/middleware/auth.ts
  [Read] src/services/token.ts
  → Context consumed, conductor became performer

Right (conductor response):
  [Task: Explore] "Investigate authentication architecture"
  → Receives summary, context preserved
  "Based on the investigation: [summary]"
```

### Making Changes (Wrong vs Right)

```
User: "Add a logout button to the header"

Wrong (musician response):
  [Read] Header.tsx
  [Edit] Header.tsx
  → Conductor picked up a violin

Right (conductor response):
  [/route] → Determines workflow
  [Task: Implementer] "Add logout button per spec"
  → Receives completion summary
  "The logout button has been added: [summary]"
```

## Main Agent Responsibilities

You retain ownership of:

- The global plan and delegation strategy
- Integration and normalization of subagent outputs
- Final decisions, tradeoffs, and conflict resolution
- User communication and expectation management
- Progress tracking and state persistence

**Subagent outputs must be summarized to < 200 words before reuse in main context.**

---

## Hard Token Budgets

Vague "summarize" instructions produce vague results. Concrete budgets produce concrete summaries.

| Return Type               | Word Budget             | When                               |
| ------------------------- | ----------------------- | ---------------------------------- |
| Standard exploration      | < 200 words             | Most subagent returns              |
| Status check              | < 50 words              | Simple completion/progress check   |
| Investigation report      | < 300 words             | Cross-spec analysis, deep research |
| Code review finding       | < 200 words per finding | Single issue with evidence         |
| Implementation completion | < 150 words             | Summary of changes and status      |

**Empirical basis**: A production workstream agent used 163 tool calls across 22 modified files while consuming only ~153k tokens total. The hard budget kept each subagent return to ~200 tokens, achieving 250x compression vs. direct reads.

If findings genuinely require more detail, the subagent should write a journal entry and return a pointer: "Full analysis in `.claude/journal/entries/<id>.md`. Summary: [< 200 words]."

---

## Advanced Orchestration Patterns

These patterns emerged from production use of the delegation-first system. They are not in tension with the conductor model — they extend it.

### Recursive Conductor (Practice 1.4)

Workstream agents are themselves conductors, not just executors. When a facilitator dispatches an implementer for a complex workstream, that implementer dispatches its own subagents:

- **Explore subagent**: Evidence gathering before any edit (see Evidence-Before-Edit)
- **Test-writer subagent**: Unit tests within the workstream scope

This creates a delegation tree: **main agent → workstream conductor → leaf executor**. Maximum depth: 3 levels. Each level returns summaries (< 200 words) to its parent, never raw data.

### Error Escalation Protocol

When subagents fail, the failure must propagate clearly. Every subagent return must include:

```
status: success | partial | failed
summary: < 200 words (hard budget)
blockers: []    # Empty if success; list of blocking issues otherwise
artifacts: []   # Files created or modified
```

**Escalation rules**:

- `success` → Orchestrator proceeds to next step
- `partial` → Orchestrator reviews what completed vs. what didn't. Decides: retry the incomplete portion, work around it, or escalate to human
- `failed` → Orchestrator may retry **once** silently. After 1 failed retry: escalate to human with full context. Never silently retry more than once.

At recursive depth > 1 (sub-subagent failure), the intermediate conductor must surface the failure in its own return, not swallow it. A workstream conductor returning `status: success` when a sub-subagent failed is a critical violation.

### Convergence Loop Protocol

Quality gates are not single-pass. Each gate runs in an iterative loop: **check → fix → recheck** until the gate converges or the iteration cap is reached.

**Loop mechanics:**

1. Dispatch the check agent (e.g., `code-reviewer`)
2. If clean: increment `clean_pass_count`. If issues found: reset `clean_pass_count` to 0, dispatch fix agent with findings as input
3. After fix, re-dispatch check agent (back to step 1)
4. **Converge** when `clean_pass_count >= 2` (two consecutive clean passes)
5. **Escalate** to user when `iteration_count >= 5`

**Applicable gates:**

| Gate                    | Check Agent              | Fix Agent                      | Convergence         |
| ----------------------- | ------------------------ | ------------------------------ | ------------------- |
| Interface Investigation | `interface-investigator` | `spec-author` (spec amendment) | 2 consecutive clean |
| Unifier Validation      | `unifier`                | `implementer` or `test-writer` | 2 consecutive clean |
| Code Review             | `code-reviewer`          | `implementer`                  | 2 consecutive clean |
| Security Review         | `security-reviewer`      | `implementer`                  | 2 consecutive clean |

**Why 2 consecutive passes:** A single clean pass after a fix may be coincidental — the fix addressed issue X but introduced issue Y, which the next pass catches. Two consecutive clean passes confirm the fix is stable and non-regressive.

**Fix agent input contract:** The fix agent receives the prior check's findings directly — it does not re-discover issues. This prevents redundant exploration and ensures fixes are targeted.

**Escalation format** (when iteration cap reached):

```
CONVERGENCE FAILURE: <gate-name>
Iterations: 5/5
Recurring issues: [list of issues that keep reappearing]
Last fix attempted: [description]
Recommendation: [manual intervention needed / scope reduction / spec amendment]
```

**Loop state tracking:**

```json
{
  "gate": "<gate-name>",
  "iteration_count": 0,
  "clean_pass_count": 0,
  "max_iterations": 5,
  "required_clean_passes": 2,
  "findings_history": []
}
```

The orchestrating agent (main agent or workstream conductor) owns the loop state. Subagents execute individual check/fix cycles but do not track convergence themselves.

---

## Exceptions to Delegation-First

Not every operation benefits from the framework's abstractions. These are sanctioned exceptions:

### File-Based Coordination

For trivially simple inter-agent coordination, use sentinel files instead of dispatching subagents:

```
.claude/coordination/<workstream-id>.done    # Signals workstream completion
.claude/coordination/<workstream-id>.status  # Machine-readable status JSON
```

Polling agents check: `ls .claude/coordination/*.done` — costs ~10 tokens. Dispatching an explore subagent to check status costs ~150 tokens minimum. For high-frequency coordination checks, use files.

The rule: if the check is a single `ls` or file read under 10 lines, do it directly. If it requires investigation or judgment, delegate.

### Pre-Computed Structure

When the human provides explicit decomposition in their prompt, use it directly. The atomizer is a fallback for ambiguous scope, not the default. Front-loading decomposition in prompts saves 5-10 exploratory turns per workstream.

---

## Clarification Before Commitment

- Surface unresolved questions before irreversible decisions.
- If assumptions are required, state them explicitly.
- Do not silently guess when ambiguity materially affects outcomes.

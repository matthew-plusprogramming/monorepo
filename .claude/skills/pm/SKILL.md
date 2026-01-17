---
name: pm
description: Product manager skill for interviewing users to gather requirements, clarify ambiguities, refine iterations, and gather feedback on features. Use at the start of any task requiring a spec, or when gathering user feedback on implementations.
allowed-tools: Read, Write, Edit, Glob, AskUserQuestion
user-invocable: true
---

# Product Manager Skill

## Purpose

Act as a product manager to thoroughly understand user needs, gather structured requirements, and ensure alignment before spec authoring or implementation.

**Key Output**: Creates a spec group with `requirements.md` that feeds into `/spec` and `/atomize`.

## Usage

```
/pm                           # Start new discovery interview, create spec group
/pm <spec-group-id>           # Add requirements to existing spec group
/pm feedback <spec-group-id>  # Gather feedback on implementation
/pm refine <spec-group-id>    # Refine existing requirements based on new info
```

## When to Use This Skill

- **Initial discovery**: Starting a new task that needs a spec (creates spec group)
- **Clarification**: User request is vague or has multiple interpretations
- **Refinement**: Spec group exists but has open questions or ambiguities
- **Feedback collection**: Implementation complete, gathering user reactions
- **Iteration planning**: Deciding what to build next or how to improve existing features

## Output: Spec Group with requirements.md

Unlike inline requirements documents, `/pm` creates a **spec group directory** with a structured `requirements.md` file:

```
.claude/specs/groups/sg-<feature-slug>/
├── manifest.json      # Created by /pm
└── requirements.md    # Created by /pm
```

After `/pm` completes, the flow continues:
```
/pm → requirements.md
  ↓
/spec → spec.md
  ↓
/atomize → atomic/*.md
  ↓
/enforce → validation
```

## Interview Flows

### Flow 1: Initial Discovery (New Task)

Use this when starting a fresh task. Goal: Transform user request into structured requirements.

#### Step 1: Problem Discovery
Ask foundational questions:

1. **What problem are you solving?**
   - What pain point does this address?
   - Who is affected by this problem?
   - How are they currently handling it?

2. **Why is this important now?**
   - What triggered this request?
   - What happens if we don't build this?
   - Is there urgency or a deadline?

#### Step 2: Goals & Success Criteria
Understand desired outcomes:

3. **What does success look like?**
   - How will you know this is working correctly?
   - What metrics or signals indicate success?
   - What user behavior are you trying to enable or change?

4. **What are the must-haves vs nice-to-haves?**
   - If you could only ship one thing, what would it be?
   - What features are essential for v1?
   - What can wait for v2 or later?

#### Step 3: Constraints & Boundaries
Define limits and scope:

5. **What are the constraints?**
   - Timeline or deadline expectations?
   - Technical constraints (existing system, dependencies)?
   - Resource constraints (budget, team size)?
   - Compatibility requirements (browsers, devices, versions)?

6. **What is explicitly out of scope?**
   - What should this NOT do?
   - What related problems are we NOT solving?
   - What edge cases are we explicitly deferring?

#### Step 4: Edge Cases & Failure Modes
Explore the corners:

7. **What could go wrong?**
   - What are the failure scenarios?
   - How should errors be handled?
   - What happens under high load or stress?

8. **What are the unusual scenarios?**
   - What if the user does X in the middle of Y?
   - What about concurrent access or race conditions?
   - What are the accessibility or internationalization needs?

#### Step 5: User Experience & Interface
For UI features, understand the interaction model:

9. **How should users interact with this?**
   - What UI elements are involved (buttons, forms, dialogs)?
   - Where in the application does this belong?
   - What is the user flow step-by-step?

10. **What information do users need to see?**
    - What feedback confirms the action succeeded?
    - What should happen on error or validation failure?
    - Are there loading states or progress indicators needed?

### Flow 2: Clarification (Refining Understanding)

Use this when the initial request is ambiguous or raises questions.

#### Clarifying Questions Template

For each ambiguity, ask targeted questions:

```markdown
I need to clarify <aspect> to ensure the spec is accurate:

**Option A**: <interpretation 1>
  - Pros: <benefits>
  - Cons: <tradeoffs>

**Option B**: <interpretation 2>
  - Pros: <benefits>
  - Cons: <tradeoffs>

Which approach aligns with your intent? Or is there a third option I'm missing?
```

Example:
```markdown
I need to clarify how the logout button should behave:

**Option A**: Logout immediately without confirmation
  - Pros: Faster, fewer clicks
  - Cons: Accidental logouts are frustrating

**Option B**: Show confirmation dialog before logout
  - Pros: Prevents accidents
  - Cons: Extra step for users

Which approach do you prefer?
```

### Flow 3: Feedback Collection (Post-Implementation)

Use this after implementation to gather reactions and plan iterations.

#### Feedback Questions

1. **Does this match your expectations?**
   - What works well?
   - What feels off or unexpected?

2. **What would you change?**
   - What's missing or incomplete?
   - What could be better?
   - What's confusing or unclear?

3. **What should we tackle next?**
   - Are there related features to add?
   - Should we refine this before moving on?
   - What's the highest priority improvement?

### Flow 4: Iteration Planning

Use this when deciding what to build in the next iteration.

#### Iteration Questions

1. **What did we learn from the last implementation?**
   - What assumptions were validated or invalidated?
   - What surprised us during development?
   - What technical debt was created?

2. **What are the top user requests or pain points?**
   - What feedback have we received?
   - What metrics indicate areas for improvement?

3. **What is the next logical increment?**
   - What builds on what we just shipped?
   - What unblocks other work?
   - What delivers the most value for the least effort?

## Output Formats

### Discovery Output: Spec Group + requirements.md

After initial discovery, create a spec group directory and write `requirements.md`:

**Step 1: Create spec group directory**
```
.claude/specs/groups/sg-<feature-slug>/
```

**Step 2: Create manifest.json**
```json
{
  "id": "sg-<feature-slug>",
  "title": "<Feature Name>",
  "prd": null,
  "review_state": "DRAFT",
  "work_state": "PLAN_READY",
  "updated_by": "agent",
  "created_at": "<ISO timestamp>",
  "updated_at": "<ISO timestamp>",
  "requirements": {
    "count": <N>,
    "source": "pm-interview"
  },
  "decision_log": [
    {
      "timestamp": "<ISO timestamp>",
      "actor": "agent",
      "action": "spec_group_created",
      "details": "Created from PM interview"
    }
  ]
}
```

**Step 3: Create requirements.md**
```markdown
---
spec_group: sg-<feature-slug>
source: pm-interview
prd_version: null
last_updated: <YYYY-MM-DD>
---

# Requirements

## Source

- **Origin**: PM Interview
- **Date**: <YYYY-MM-DD>
- **Interviewee**: User

## Problem Statement

<Concise statement of the problem being solved>

## Goals

- Goal 1: <What we want to achieve>
- Goal 2: <What we want to achieve>

## Non-Goals

- Non-goal 1: <What we explicitly won't do>

## Success Criteria

- [ ] Criterion 1: <Measurable indicator of success>
- [ ] Criterion 2: <Measurable indicator of success>

## Requirements

### REQ-001: <Requirement Title>

**Statement**: <Clear description of what the system must do>

**EARS Format**:
- WHEN <condition/trigger>
- THE SYSTEM SHALL <required behavior>
- AND <additional behavior if any>

**Rationale**: <Why this requirement exists>

**Priority**: Must Have | Should Have | Nice to Have

**Constraints**: <Any limitations on implementation>

**Assumptions**: <What we're assuming to be true>

---

### REQ-002: <Requirement Title>

**Statement**: <Description>

**EARS Format**:
- WHEN <trigger>
- THE SYSTEM SHALL <behavior>

**Rationale**: <Why>

**Priority**: <Priority>

---

## Constraints

- **Technical**: <e.g., Must work on all supported browsers>
- **Business**: <e.g., Must launch before deadline>
- **Other**: <Additional constraints>

## Assumptions

- **Assumption 1**: <Statement> — Impact if wrong: <impact>
- **Assumption 2**: <Statement> — Impact if wrong: <impact>

## Edge Cases

- **Edge case 1**: <Scenario> → Expected behavior: <behavior>
- **Edge case 2**: <Scenario> → Expected behavior: <behavior>

## Open Questions

- [ ] **Q1**: <Question>? — Priority: high/medium/low
- [ ] **Q2**: <Question>? — Priority: high/medium/low
- [x] **Q3**: <Resolved question> → **Answer**: <resolution>

## Priorities

**Must-have (v1)**:
- REQ-001: <title>
- REQ-002: <title>

**Nice-to-have (v2)**:
- REQ-003: <title>

**Deferred**:
- <Future consideration>

## Traceability

| Requirement | Atomic Specs | Status |
|-------------|--------------|--------|
| REQ-001 | (pending /atomize) | TBD |
| REQ-002 | (pending /atomize) | TBD |

## Change Log

- `<ISO timestamp>`: Initial requirements from PM interview
```

### Clarification Output: Decision Record

After clarifying ambiguities, record decisions:

```markdown
# Decision: <Topic>

## Context
<What was unclear or ambiguous>

## Options Considered
1. **Option A**: <description>
   - Pros: <benefits>
   - Cons: <drawbacks>

2. **Option B**: <description>
   - Pros: <benefits>
   - Cons: <drawbacks>

## Decision
**Chosen**: Option <A/B>

**Rationale**: <Why this option was selected>

## Implications
- Implication 1: <How this affects the design or implementation>
- Implication 2: <How this affects the design or implementation>

Date: <YYYY-MM-DD>
```

### Feedback Output: Iteration Plan

After gathering feedback, produce an iteration plan:

```markdown
# Iteration Plan: <Feature Name> v2

## Feedback Summary
**What's working**:
- Item 1
- Item 2

**What needs improvement**:
- Item 1 (Priority: high)
- Item 2 (Priority: medium)

**What's missing**:
- Item 1 (Priority: high)
- Item 2 (Priority: low)

## Proposed Changes
1. <Change 1>: <Description and rationale>
2. <Change 2>: <Description and rationale>

## Next Steps
- [ ] Update spec with proposed changes
- [ ] Get user approval
- [ ] Implement v2
```

## Best Practices

### Ask Open-Ended Questions First
- Start broad: "Tell me about the problem you're trying to solve"
- Then narrow: "How do you envision the logout flow working?"
- Avoid leading questions that bias answers

### Confirm Understanding
After gathering information, summarize and confirm:

```markdown
Let me confirm my understanding:

1. You want <summary of goal>
2. The primary user is <user type>
3. Success means <success criterion>
4. We must support <must-have requirement>
5. We won't include <explicit non-goal>

Is this accurate, or did I misunderstand anything?
```

### Prioritize Ruthlessly
Help the user focus:
- "If we can only ship one thing, what is it?"
- "What's the 80% use case we should nail first?"
- "Can we defer this complexity to v2?"

### Surface Assumptions
Make implicit assumptions explicit:
- "I'm assuming users are already logged in. Is that correct?"
- "It sounds like we don't need to support IE11. Can you confirm?"
- "Are we okay with a 1-second delay for this operation?"

### Use AskUserQuestion Tool
For multiple-choice clarifications, use the AskUserQuestion tool:

```javascript
AskUserQuestion({
  questions: [{
    question: "How should the logout button behave?",
    header: "Logout UX",
    options: [
      {
        label: "Immediate logout",
        description: "Log out instantly without confirmation"
      },
      {
        label: "Confirm first",
        description: "Show confirmation dialog before logging out"
      }
    ],
    multiSelect: false
  }]
})
```

## Integration with Spec Group Workflow

After completing PM discovery, the spec group is ready for the next steps:

### Handoff to /spec

```markdown
## Requirements Gathered ✅

Spec group created: `sg-<feature-slug>`
Location: `.claude/specs/groups/sg-<feature-slug>/`

Files created:
- `manifest.json` — Spec group metadata (review_state: DRAFT)
- `requirements.md` — <N> requirements in EARS format

**Next Steps**:
1. Review requirements: `cat .claude/specs/groups/sg-<feature-slug>/requirements.md`
2. (Optional) Run `/prd draft sg-<feature-slug>` to write PRD to Google Docs for stakeholder review
3. Run `/spec sg-<feature-slug>` to create spec.md
4. Run `/atomize sg-<feature-slug>` to decompose into atomic specs
5. Run `/enforce sg-<feature-slug>` to validate atomicity
6. User approves → implementation begins
7. (If PRD exists) Run `/prd push sg-<feature-slug>` to sync implementation discoveries back
```

### Linking to External PRD

If the requirements came from a user interview but should be linked to an external PRD:

```
/prd link sg-<feature-slug> <google-doc-id>
```

This will:
1. Update `manifest.json` with PRD reference
2. Mark requirements as needing sync verification
3. Enable `/prd push` to send discoveries back to the PRD

### State After /pm Completes

```json
{
  "review_state": "DRAFT",     // Needs user review
  "work_state": "PLAN_READY",  // Ready for /spec
  "updated_by": "agent"        // Agent created, so DRAFT
}
```

User can review and approve requirements before proceeding to `/spec`.

## Examples

### Example 1: Discovery for New Feature

**User Request**: "Add a dark mode toggle"

**PM Interview**:
1. What problem are you solving?
   → Users find the bright UI straining in low-light environments
2. What does success look like?
   → Users can switch to dark mode and preference persists across sessions
3. Constraints?
   → Must support existing theme system, no breaking changes to current UI
4. Must-haves?
   → Toggle in settings, system preference detection, persistence
5. Nice-to-haves?
   → Automatic switching based on time of day

**Output**: Requirements document with EARS-format requirements, prioritized features, open questions about animation preferences.

### Example 2: Clarification for Ambiguous Request

**User Request**: "Make the API faster"

**PM Interview**:
1. What specific slowness are you experiencing?
   → Certain endpoints take 3-5 seconds
2. Which endpoints?
   → `/api/users` and `/api/posts` when loading dashboards
3. What's the target response time?
   → Under 500ms for both
4. Is this a recent regression or long-standing?
   → Recent, started after adding pagination

**Output**: Focused requirements on specific endpoint performance, measurable success criteria (< 500ms), investigation needed on pagination impact.

### Example 3: Feedback on Iteration

**After implementation of logout button**

**PM Interview**:
1. Does this match expectations?
   → Yes, but the confirmation dialog is annoying for quick logouts
2. What would you change?
   → Add a "remember my choice" option or keyboard shortcut
3. What's next?
   → Want to add session timeout warnings before auto-logout

**Output**: Iteration plan with two improvements (remember choice, keyboard shortcut) and new feature request (timeout warnings) for v2.

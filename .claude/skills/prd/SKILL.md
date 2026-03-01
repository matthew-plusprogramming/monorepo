---
name: prd
description: Create PRDs through the gather-criticize loop, sync existing PRDs, push amendments, and check PRD status.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task
user-invocable: true
---

# /prd Skill

## Purpose

Full lifecycle management for Product Requirements Documents (PRDs) through the **gather-criticize loop**:

- **Create** new PRDs via conversational discovery + iterative criticism
- **Resume** interrupted PRD sessions
- **Sync** existing PRDs to spec groups
- **Amend** PRDs with implementation discoveries
- **Status** check on PRD state

This is the unified skill for all PRD lifecycle management: creation, refinement, syncing, and amendment.

## PRD Storage

PRDs are stored in-repo under `.claude/prds/` for version control alongside the codebase.

```
.claude/prds/
├── <prd-id>/
│   └── prd.md                    # The PRD document (D-034 format)
└── <another-prd-id>/
    └── ...
```

## Usage

```
/prd                          # Start new PRD with gather-criticize loop
/prd <prd-id>                 # Resume or refine existing PRD
/prd sync <prd-id>            # Import existing PRD, extract requirements to spec group
/prd amend <prd-id>           # Push implementation discoveries back to PRD
/prd status <prd-id>          # Check PRD state, pass count, pending findings
```

## Commands

### /prd (New PRD -- Gather-Criticize Loop)

Creates a new PRD through the full gather-criticize loop.

**Process**:

#### Phase 1: Cold Start & Discovery

1. **Generate PRD ID**: Prompt user for a slug (e.g., `auth-revamp`, `notifications`)
2. **Create directory**: `mkdir -p .claude/prds/<prd-id>/`
3. **Dispatch PRD Writer** (discovery mode):

   ```
   Task: prd-writer
   Prompt: |
     <context>
     Mode: discovery
     PRD ID: <prd-id>
     User request: <original user request>
     Cold start context:
       - tech.context.md: <contents>
       - org-context.md: <contents>
       - Existing PRDs: <list of .claude/prds/*/prd.md>
     Template: .claude/templates/prd-phase1.template.md
     </context>

     Conduct a conversational discovery interview with the human.
     Follow D-004 (13 context dimensions), D-005 (cold start), D-006 (conversational),
     D-007 (front-loaded input, natural breakpoints).

     After discovery completes, produce a PRD in D-034 format.
     Save to .claude/prds/<prd-id>/prd.md
   ```

4. **PRD Writer produces draft**: Saved to `.claude/prds/<prd-id>/prd.md`

#### Phase 2: Critique Loop

5. **Initialize pass counter**: `pass = 1`
6. **Dispatch 4 critics in parallel** (D-001: independence):

   ```
   # Dispatch all four in parallel -- DO NOT serialize
   Task: prd-critic (perspective: business)
   Task: prd-critic (perspective: technical)
   Task: prd-critic (perspective: security)
   Task: prd-critic (perspective: edge-case)

   Each critic receives ONLY:
     (1) Current PRD document (read from .claude/prds/<prd-id>/prd.md)
     (2) The Decisions Log section from the PRD
     (3) Calibration set from .claude/templates/critic-calibration.md
     (4) Its perspective parameter

   DO NOT include findings from any other critic.
   ```

7. **Collect findings** from all four critics
8. **Aggregate findings by severity**

#### Phase 3: Resolution

9. **If any Critical or High findings exist**:
   - Present as a single batch to the human, sorted by severity (Critical first, then High), then by critic type
   - Human resolves each finding: accept (amend PRD), reject (not a real gap), or defer (out of scope)

10. **If any Medium findings exist**:
    - Present Medium findings to the human (after Critical/High are resolved)
    - Human resolves each

11. **Low findings**: Summarize in a single block. Do NOT present individually.

12. **Dispatch PRD Writer** (amendment mode):

    ```
    Task: prd-writer
    Prompt: |
      <context>
      Mode: amendment
      PRD path: .claude/prds/<prd-id>/prd.md
      Pass number: <pass>
      Resolutions:
        <list of finding_id, resolution, rationale for each resolved finding>
      </context>

      Amend the PRD with all resolutions.
      Update the Decisions Log with structured entries for each finding.
      Save the complete amended PRD to disk.
    ```

#### Phase 4: Loop Check

13. **Check exit condition** (D-002):
    - If all findings from this pass are Low severity:
      - Present remaining Low findings to the human
      - Ask: "All remaining findings are Low severity. Exit the loop and finalize the PRD? [Y/n]"
      - If human confirms: **Exit loop** (go to Phase 5)
      - If human rejects: Continue loop (back to step 6 with `pass += 1`)
    - If any non-Low findings remain: **Continue loop** (back to step 6 with `pass += 1`)

14. **Max pass check** (EC-4):
    - If `pass >= 5`:
      - Present summary: "After 5 passes, N Medium+ findings remain."
      - Offer options: (1) Resolve remaining findings, (2) Accept current state and proceed, (3) Defer remaining findings
      - Human decides

#### Phase 5: Finalization

15. **Update org-context**: Dispatch PRD Writer to update `.claude/memory-bank/org-context.md` with new stable facts discovered during the session
16. **Create spec group** (optional):
    - Prompt: "Create a spec group from this PRD? [Y/n]"
    - If yes: Create `.claude/specs/groups/sg-<prd-id>/` with `manifest.json` and `requirements.md` extracted from the PRD
17. **Report completion**:

    ```
    PRD complete: .claude/prds/<prd-id>/prd.md
    Passes: <N>
    Findings resolved: <count>
    Decisions Log entries: <count>

    Next steps:
      1. Review PRD: .claude/prds/<prd-id>/prd.md
      2. Create spec group: /prd sync <prd-id> (if not already created)
      3. Author spec: /spec sg-<prd-id>
    ```

### /prd <prd-id> (Resume or Refine)

Resumes an interrupted PRD session or refines an existing PRD.

**Process**:

1. Read PRD from `.claude/prds/<prd-id>/prd.md`
2. Determine re-entry point:
   - If PRD has `<!-- RESUME POINT: ... -->` comment: resume interview from that point
   - If PRD is complete but has no Decisions Log entries: start critique loop (Phase 2)
   - If PRD has Decisions Log entries: start a new critique pass
3. Continue from the appropriate phase

### /prd sync <prd-id> (Import Existing PRD)

Creates a spec group from an existing PRD. Kept from the old `/prd` skill.

**Process**:

1. Read PRD from `.claude/prds/<prd-id>/prd.md`
2. Dispatch `prd-reader` agent to extract requirements:
   ```
   Task: prd-reader
   Prompt: |
     Read PRD from .claude/prds/<prd-id>/prd.md
     Extract requirements, constraints, assumptions, success criteria
     Convert to EARS format
     Create spec group with requirements.md
   ```
3. Create spec group directory: `.claude/specs/groups/sg-<prd-id>/`
4. Generate `manifest.json` with PRD link
5. Generate `requirements.md` from extracted requirements
6. Set `review_state: DRAFT`

**Output**:

```
PRD synced: .claude/prds/<prd-id>/prd.md

Created spec group: sg-<prd-id>
  - N requirements extracted
  - requirements.md generated

Next steps:
  1. Review requirements: .claude/specs/groups/sg-<prd-id>/requirements.md
  2. Run /spec sg-<prd-id> to create spec
```

### /prd amend <prd-id> (Push Implementation Discoveries)

Pushes implementation discoveries back to the PRD. Renamed from old `/prd push`.

**Process**:

1. Read current PRD from `.claude/prds/<prd-id>/prd.md`
2. Read spec group requirements (if linked)
3. Dispatch `prd-amender` agent:
   ```
   Task: prd-amender
   Prompt: |
     PRD path: .claude/prds/<prd-id>/prd.md
     Spec group: <linked spec group if any>
     Identify implementation discoveries:
       - New requirements discovered
       - Assumptions invalidated
       - Constraints discovered
     Update PRD with amendments
     Update Amendment Log with D-028 format entries
   ```
4. Report changes

### /prd status <prd-id> (Check PRD State)

Displays the current state of a PRD.

**Process**:

1. Read PRD from `.claude/prds/<prd-id>/prd.md`
2. Parse frontmatter for version and state
3. Count Decisions Log entries
4. Check for linked spec groups

**Output**:

```
PRD Status: <prd-id>

  Title: <title from frontmatter>
  Version: <version>
  State: <state>
  Decisions Log: <N> entries
  Last Updated: <date>

  Linked Spec Groups:
    - sg-<id> (review_state: <state>)
```

## Edge Case Handling

### EC-1: Zero Findings on First Pass

If the first critique pass returns zero findings from all four critics:

- Present to human: "All four critics found no issues. The PRD may be complete."
- Request exit confirmation
- Exit loop if confirmed

### EC-2: Critic Agent Failure

If a critic agent fails or times out:

- Continue with findings from the remaining critics
- Note the failed critic in the pass summary: "Note: [perspective] critic failed. Will retry on next pass."
- On the next pass, retry the failed critic alongside all others

### EC-3: Human Disagrees with Severity

If the human disagrees with a severity rating:

- Human's judgment takes precedence
- Record the override in the Decisions Log with rationale

### EC-4: Loop Exceeds 5 Passes

After 5 passes without converging to Low-only:

- Present summary: "After 5 passes, N Medium+ findings remain: [list]"
- Options: (1) Resolve remaining, (2) Accept current state, (3) Defer to implementation
- Human decides

### EC-5: Resume Partially Completed PRD

`/prd <prd-id>` detects the state and re-enters at the right point:

- Missing sections: Resume interview
- Complete draft, no critiques: Start critique loop
- Has critique history: Start new critique pass with amended PRD

### EC-6: Wrong Org Context

The PRD Writer's assumption confirmation pattern handles corrections:

- Human corrects the assumption
- Org-context.md is updated with the correction at session end

## Finding Presentation Format

When presenting findings to the human, use this batch format:

```markdown
## Critique Pass <N> Results

### Critical Findings (must resolve)

**TECH-001** (Critical): <summary>
<detail>
Suggested resolution: <suggestion>

**SEC-001** (Critical): <summary>
<detail>

### High Findings (must resolve)

**BIZ-001** (High): <summary>
<detail>

### Medium Findings

**EDGE-001** (Medium): <summary>
<detail>

### Low Findings (summary only)

4 Low findings across all critics:

- TECH-003: <one-line summary>
- BIZ-002: <one-line summary>
- SEC-002: <one-line summary>
- EDGE-003: <one-line summary>

---

For each Critical/High/Medium finding, please provide:

- **accept**: Amend the PRD to address this
- **reject**: Not a real gap (provide rationale)
- **defer**: Acknowledged but out of scope for this PRD
```

## Agents

The `/prd` skill uses four specialized agents:

| Agent         | Purpose                                                              | Used By              |
| ------------- | -------------------------------------------------------------------- | -------------------- |
| `prd-writer`  | Conducts discovery interviews and drafts/amends PRDs in D-034 format | `/prd`, `/prd <id>`  |
| `prd-critic`  | Evaluates PRDs from one of four perspectives with severity ratings   | `/prd` critique loop |
| `prd-reader`  | Extracts requirements from existing PRDs into EARS format            | `/prd sync`          |
| `prd-amender` | Pushes implementation discoveries back to PRDs                       | `/prd amend`         |

## Integration with Workflow

### Flow 1: New PRD (Gather-Criticize Loop)

```
User invokes /prd
    ↓
Cold start: load tech.context, org-context, existing PRDs
    ↓
PRD Writer: conversational discovery interview
    ↓
PRD draft saved to .claude/prds/<prd-id>/prd.md
    ↓
Loop: 4 critics evaluate in parallel
    ↓
Findings presented by severity (Critical > High > Medium > Low summary)
    ↓
Human resolves findings
    ↓
PRD Writer amends PRD + updates Decisions Log
    ↓
Loop continues until all findings are Low + human confirms
    ↓
Org-context updated with new stable facts
    ↓
Optional: create spec group
    ↓
/spec → implementation
```

### Flow 2: Sync Existing PRD

```
PRD exists at .claude/prds/<prd-id>/prd.md
    ↓
/prd sync <prd-id>
    ↓
prd-reader extracts requirements
    ↓
Spec group created with requirements.md
    ↓
/spec → implementation
```

### Flow 3: Push Implementation Discoveries

```
During implementation, new requirements discovered
    ↓
/prd amend <prd-id>
    ↓
prd-amender updates PRD + Amendment Log
    ↓
PRD version incremented
```

## State Transitions

### On /prd (new PRD)

- PRD created at `.claude/prds/<prd-id>/prd.md`
- Frontmatter: `version: 1.0`, `state: draft`
- After loop exits: `state: reviewed`

### On /prd sync

- Spec group created with `review_state: DRAFT`
- Manifest linked to PRD

### On /prd amend

- PRD version incremented
- Amendment Log updated
- PRD state set to `draft` (agent change, needs human review)

## Error Handling

### PRD Not Found

```
Error: PRD '<prd-id>' not found

Expected path: .claude/prds/<prd-id>/prd.md

Available PRDs:
  - <list from .claude/prds/*/prd.md>

To create a new PRD, run: /prd
```

### No PRDs Exist

```
No PRDs found in .claude/prds/

To create a new PRD, run: /prd
To sync an existing document, place it at .claude/prds/<prd-id>/prd.md and run: /prd sync <prd-id>
```

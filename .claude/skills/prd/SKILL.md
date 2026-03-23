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

#### Phase 1.5: Integration Surface Exploration

> **Applicability**: MANDATORY for oneoff-spec and orchestrator workflows. SKIP for oneoff-vibe.

After the PRD Writer saves the draft (end of Phase 1), explore the codebase to pre-populate the PRD's Integration Surface section before critics see the document.

4a. **Parse the draft PRD** for mentioned systems, APIs, services, databases, and configuration:

- Scan all sections for references to existing services, endpoints, data stores, and external systems
- Extract module/package names, route paths, config keys, and event names mentioned or implied

4b. **Dispatch Explore subagent** to scan the codebase for integration surfaces:

```
Task: explore
Prompt: |
  Investigate the codebase for integration surfaces relevant to the PRD at .claude/prds/<prd-id>/prd.md.

  Search for:
  1. Existing API endpoints, routes, or service interfaces that the proposal touches or extends
  2. Shared database tables, schemas, or data models referenced
  3. Configuration and environment variables involved (e.g., in .env files, config modules)
  4. Event systems at boundaries (SSE, WebSocket, pub/sub, message queues)
  5. Import/export relationships with modules the feature touches

  Return a structured Integration Surface Report with:
  - Touched Systems: list of existing systems/services with how they are touched
  - Existing Contracts: API specs, type definitions, schemas already in place
  - Potential Conflicts: areas where the proposed feature may conflict with existing behavior
  - Configuration Dependencies: env vars, feature flags, config files involved
  - Cross-Cutting Concerns: shared state, caching, event systems, logging pipelines

  Budget: < 200 words. Return structured findings, not raw code.
```

4c. **Dispatch PRD Writer** (amendment mode) to add exploration findings:

```
Task: prd-writer
Prompt: |
  <context>
  Mode: amendment
  PRD path: .claude/prds/<prd-id>/prd.md
  Pass number: 0 (pre-critique integration surface population)
  Integration Surface Report:
    <structured findings from Explore subagent>
  </context>

  Add the exploration findings to the "Integration Surface" section of the PRD.
  Populate: Touched Systems table, New Boundaries Created, Configuration Dependencies,
  and Cross-Cutting Concerns subsections.

  Do NOT modify any other section of the PRD.
  Save the complete amended PRD to disk.
```

4d. **Proceed to Phase 2** (Critique Loop) -- critics now evaluate the PRD with integration context already populated.

#### Phase 1.55: Optional Technical Architecture Design (TAD)

> **Applicability**: Optional for all workflows. Human chooses whether to provide TAD input.
> **Purpose**: Allow humans to front-load architectural decisions before spec authoring, reducing investigation findings downstream.

After the Integration Surface exploration (Phase 1.5) and before the Critique Loop (Phase 2):

4a-tad. **Present TAD option to human**:

```
Would you like to provide technical architecture input before critique begins?

This optional TAD (Technical Architecture Design) phase lets you specify:
  - Key architectural decisions (e.g., database choice, API style, auth strategy)
  - System design constraints (e.g., latency requirements, scaling targets)
  - Technology choices (e.g., framework, language, infrastructure)
  - Integration patterns (e.g., sync vs async, event-driven vs request-response)

This input will be available to the spec-author agent as context, potentially
reducing downstream investigation findings.

[Provide TAD input / Skip TAD]
```

4b-tad. **If human provides TAD input**:

- Record the TAD input in the PRD under a `## Technical Architecture Design` section
- Dispatch PRD Writer (amendment mode) to integrate the TAD into the PRD:

```
Task: prd-writer
Prompt: |
  <context>
  Mode: amendment
  PRD path: .claude/prds/<prd-id>/prd.md
  Pass number: 0 (TAD integration)
  TAD Input:
    <human's technical architecture input>
  </context>

  Add the TAD input to the "Technical Architecture Design" section of the PRD.
  Integrate architectural decisions with existing Integration Surface findings.
  Do NOT modify any other section of the PRD.
  Save the complete amended PRD to disk.
```

- The TAD input will be passed through to spec-author context when `/spec` is invoked

4c-tad. **If human skips TAD**: Continue to Phase 1.6 without error. No TAD section added.

**Note**: The TAD phase does NOT count as a separate human intervention in metrics. The PRD gather-criticize loop remains fully human-in-the-loop -- no auto-decision logic applies to PRD findings.

#### Phase 1.6: Diagram Generation (AC-4.4, AC-4.5)

> **Trigger**: Runs after the gather-criticize loop exits (after Phase 1.5, before Phase 2).
> **Purpose**: Generate preliminary visual artifacts from PRD content.

4e. **Generate preliminary diagrams** from available YAML sources:

```bash
# Generate all diagrams from structured YAML docs
node .claude/scripts/docs-generate.mjs
```

This produces three types of preliminary diagrams:

1. **Architecture overview** (C4 component diagram): Generated from `architecture.yaml` via `generateComponentMmd()`. Shows system components and dependencies.
2. **User flow sequences**: Generated from `flows/*.yaml` via `generateFlowMmd()`. Shows step-by-step interaction flows.
3. **Security boundary diagram**: Generated from `security.yaml` via `generateSecurityMmd()`. Shows trust zones and data flow between them.

**Behavior**:

- If a YAML source does not exist, that diagram type is skipped silently
- Generated `.mmd` files are placed in `.claude/docs/structured/generated/`
- Each `.mmd` file includes a `%% source-hash:` header for freshness tracking
- Results are referenced in the PRD's Visual Report section

4f. **Update PRD Visual Report section** with references to generated diagrams:

```markdown
## Visual Report

### Phase 1 Diagrams (Preliminary)

- Architecture Overview: .claude/docs/structured/generated/component-c4.mmd
- User Flow Sequences: .claude/docs/structured/generated/flow-\*.mmd
- Security Boundaries: .claude/docs/structured/generated/security.mmd
```

4g. **Proceed to Phase 2** (Critique Loop).

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
    - Offer batch shortcut: "Accept all Medium findings" (excludes security-tagged findings)
    - Security-tagged findings at any severity are surfaced separately and require explicit individual confirmation
    - If batch-accepted, log each decision individually in the Decisions Log with specific finding IDs
    - Human resolves each (or uses batch shortcut)

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

Creates a spec group from an existing PRD, or updates an existing spec group's requirements.md from the current PRD state. Kept from the old `/prd` skill.

**Process (new spec group)**:

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
6. Set `prd_version` and `prd_content_hash` in requirements.md YAML frontmatter:
   - `prd_version`: The PRD's version field value
   - `prd_content_hash`: First 8 characters of SHA-256 hex digest computed over the PRD body content (everything after the closing `---` of the YAML frontmatter block; frontmatter itself is excluded)
7. Set `review_state: DRAFT`

**Process (update mode -- existing requirements.md)**:

When `/prd sync` is run on a spec group that already has a `requirements.md`:

1. Read PRD from `.claude/prds/<prd-id>/prd.md`
2. Re-extract requirements from the current PRD
3. Compare newly extracted requirements against existing `requirements.md`:
   - **Preserved**: Manual additions (requirements not present in the PRD but added by the spec author) are kept
   - **Flagged**: Changed or removed PRD requirements are flagged for human review (not silently deleted)
   - **Conflicts**: When a manual addition conflicts with a newly extracted PRD requirement (both cover the same concern with different constraints), flag for human review with both versions presented side by side
4. Update `prd_version` and `prd_content_hash` in frontmatter to reflect the current PRD state

**Output**:

```
PRD synced: .claude/prds/<prd-id>/prd.md

Created spec group: sg-<prd-id>
  - N requirements extracted
  - requirements.md generated
  - prd_version: <version>
  - prd_content_hash: <8-char hash>

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
5. **Staleness warning**: After the PRD version is incremented, check for linked spec groups:
   - Find spec groups where `requirements.md` has `prd_path` pointing to this PRD
   - Compare `prd_version` in the spec group's `requirements.md` to the new PRD version
   - If versions do not match, emit a warning:
     > "Spec group sg-XXX requirements.md is based on PRD vX but PRD is now vY. Run `/prd sync` to re-extract requirements."
   - Include a diff summary of what changed in the PRD (sections added, modified, or removed)
   - **Cosmetic amendments**: Even cosmetic changes (wording, formatting) trigger the staleness warning because the version/hash mechanism does not distinguish cosmetic from substantive changes. The diff summary enables the human to quickly judge whether re-sync is needed or the warning can be dismissed.

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

When presenting findings to the human, use the **action-first** format. Findings are grouped by severity with the recommended action front-loaded:

```markdown
## Critique Pass <N> Results

### Critical Findings (individual confirmation required)

**TECH-001** (Critical): Accept -- add error response schema
Impact: Without this, Dev and QA will assume different formats, causing integration failures.
Finding: No error response format specified for API endpoints.
Detail: The PRD describes 5 API endpoints but does not specify the error response shape.

**SEC-001** (Critical): Accept -- define auth token rotation policy
Impact: Stale tokens could be reused indefinitely, creating a session hijacking vector.
Finding: Token expiration policy not specified.

### High Findings (individual confirmation required)

**BIZ-001** (High): Accept -- add rollback success criteria
Impact: Feature launch without rollback criteria risks unrecoverable state.
Finding: No rollback plan defined for the migration.

### Medium Findings (batch shortcut available)

**EDGE-001** (Medium): Accept -- document retry behavior
Impact: Users may see inconsistent behavior on transient failures.
Finding: Retry policy not specified for external API calls.

> **Batch shortcut**: "Accept all Medium findings" (excludes security-tagged findings)

### Low Findings (summary only)

4 Low findings across all critics:

- TECH-003: <one-line summary>
- BIZ-002: <one-line summary>
- SEC-002: <one-line summary>
- EDGE-003: <one-line summary>

---

For each Critical/High finding, please provide:

- **accept**: Amend the PRD to address this
- **reject**: Not a real gap (provide rationale)
- **defer**: Acknowledged but out of scope for this PRD

For Medium findings: use batch shortcut or provide individual decisions.
Security-tagged findings at any severity are surfaced separately and require individual confirmation.
```

### Action-First Field Order (Mandatory)

Each finding MUST follow this field order:

1. **Recommended action** (accept/reject/defer verb)
2. **Impact indicator** (one-sentence consequence if unaddressed)
3. **Finding summary** (what was identified)
4. **Detail/evidence** (collapsed/optional for Medium and Low)

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
[Phase 1.5] Explore codebase for integration surfaces (oneoff-spec/orchestrator only)
    ↓
PRD Writer amends Integration Surface section with exploration findings
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

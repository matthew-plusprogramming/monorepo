---
name: prd
description: Create, sync, and manage PRDs stored locally. Draft new PRDs from PM interviews, sync existing PRDs, and push discoveries back.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
user-invocable: true
---

# /prd Skill

## Purpose

Full lifecycle management for Product Requirements Documents (PRDs):

- **Create** new PRDs from PM interviews using the standard template
- **Write** PRDs to local filesystem
- **Sync** existing PRDs to local spec groups
- **Push** implementation discoveries back to PRDs

## PRD Storage

PRDs are stored in-repo under `.claude/prds/` for version control alongside the codebase.

### Directory Structure

```
.claude/prds/
├── <prd-id>/
│   ├── prd.md                    # The PRD document
│   └── .prd-meta.json            # Metadata (version, last sync, etc.)
└── <another-prd-id>/
    └── ...
```

### File Operations

PRDs are read and written directly from the filesystem — no git clone needed since they live in the same repository.

- **Create**: Create directory under `.claude/prds/<prd-id>/`, write `prd.md`
- **Read**: Read `.claude/prds/<prd-id>/prd.md` directly
- **Update**: Edit `.claude/prds/<prd-id>/prd.md` in place
- **Version**: Tracked via PRD frontmatter (`version` field) and `.prd-meta.json`

## Usage

```
/prd draft                     # Start PM interview, then draft PRD
/prd draft <spec-group-id>     # Draft PRD from existing spec group requirements
/prd write <prd-id>             # Write/overwrite PRD to specified PRD directory
/prd write <prd-id> <spec-group-id>  # Write specific spec group's PRD

/prd sync <prd-id>             # Read PRD, extract requirements, create spec group
/prd status                    # Show all linked PRDs and their sync state
/prd status <spec-group-id>    # Show PRD status for specific spec group
/prd diff <spec-group-id>      # Show differences between spec group and PRD
/prd push <spec-group-id>      # Push local discoveries back to PRD (updates version)
/prd link <spec-group-id> <prd-id>  # Link existing spec group to a PRD
```

## Commands

### /prd draft

Creates a new PRD by running a PM interview, then writes using the standard template.

**Process**:

1. If no spec-group-id provided:
   - Invoke `/pm` skill to run discovery interview
   - PM skill creates spec group with `requirements.md`
2. Prompt user for PRD ID (slug for directory name):
   - Create new directory under `.claude/prds/<prd-id>/`
   - Or write to existing PRD directory
3. Dispatch `prd-author` agent to:
   - Read `requirements.md` from spec group
   - Read PRD template from `.claude/templates/prd.template.md`
   - Transform requirements into PRD format
   - Write formatted PRD to `.claude/prds/<prd-id>/prd.md`
4. Update `manifest.json` with PRD link

**Output**:

```
PRD drafted successfully

Title: "AI-Native Engineering Dashboard"
Spec Group: sg-ai-dashboard
Path: .claude/prds/ai-dashboard/prd.md
Version: 1.0.0

Sections created:
  ✓ Overview
  ✓ Goals (3)
  ✓ Non-Goals (3)
  ✓ Requirements (10 in EARS format)
  ✓ Constraints
  ✓ Assumptions
  ✓ Success Criteria
  ✓ Open Questions (4)
  ✓ Version History

Status: 1.0.0 (DRAFT)

Next steps:
  1. Review PRD in .claude/prds/ai-dashboard/prd.md
  2. Mark as REVIEWED when satisfied
  3. Run /spec sg-ai-dashboard to create specs
```

### /prd write

Writes a PRD to `.claude/prds/` using the standard template format. Can create new PRD or overwrite existing.

**Input**:

- `prd-id`: PRD directory name (slug) or "new" to create from spec group
- `spec-group-id` (optional): If not provided, uses most recent spec group

**Process**:

1. Resolve spec group (use provided ID or most recent)
2. If prd-id is "new":
   - Create new directory `.claude/prds/<slug>/` with slug from spec group
3. Dispatch `prd-author` agent to:
   - Load spec group's `requirements.md`
   - Load PRD template
   - Transform requirements to PRD sections (see mapping below)
   - Write `prd.md` to `.claude/prds/<prd-id>/prd.md`
   - Write `.prd-meta.json` with metadata
4. Update manifest with PRD link

**Template Mapping**:

```
requirements.md Section    →    PRD Template Section
─────────────────────────────────────────────────────
Source + Problem Statement →    Overview
Goals                      →    Goals
Non-Goals                  →    Non-Goals
Requirements (REQ-XXX)     →    Requirements (EARS format preserved)
Constraints                →    Constraints
Assumptions                →    Assumptions
Success Criteria           →    Success Criteria
Open Questions             →    Open Questions
Edge Cases                 →    Folded into Requirements or separate section
Priorities                 →    Requirements Priority field
                          →    User Stories (generated from requirements)
                          →    Version History (initialized)
                          →    EARS Format Reference (appended)
```

**Output**:

```
PRD written successfully

PRD ID: "ai-dashboard"
Path: .claude/prds/ai-dashboard/prd.md
Action: Created new PRD (or: Overwrote existing content)
Version: 1.0.0

Content:
  - Overview: 2 paragraphs
  - Goals: 4 items
  - Non-Goals: 3 items
  - Requirements: 10 (all EARS format)
  - Constraints: 3 categories
  - Assumptions: 4 with impact analysis
  - Success Criteria: 6 measurable outcomes
  - Open Questions: 4 (2 high priority)
  - User Stories: 7 generated
  - Version History: 1.0.0 initialized

Spec group sg-ai-dashboard linked to project.
```

### /prd sync

Creates a new spec group from an existing PRD in `.claude/prds/`.

**Input**: PRD ID (directory name under `.claude/prds/`)

- PRD ID: `logout-feature`

**Process**:

1. Read PRD from `.claude/prds/<prd-id>/prd.md`
2. Read PRD metadata from `.claude/prds/<prd-id>/.prd-meta.json` (if exists)
3. Dispatch `prd-reader` agent to extract:
   - Requirements (convert to EARS format)
   - Constraints
   - Assumptions
   - Success criteria
4. Create spec group directory
5. Generate `manifest.json` with PRD link
6. Generate `requirements.md` from extracted requirements
7. Set `review_state: DRAFT` (agent created, needs user review)

**Output**:

```
PRD synced successfully

PRD ID: "logout-feature"
Path: .claude/prds/logout-feature/prd.md
Version: 1.0.0 (from frontmatter)

Created spec group: sg-logout-feature
  - 4 requirements extracted
  - requirements.md generated

Next steps:
  1. Review requirements: .claude/specs/groups/sg-logout-feature/requirements.md
  2. Run /spec to create high-level spec
  3. Run /atomize to decompose into atomic specs
```

### /prd status

Shows sync status for linked PRDs.

**Output**:

```
PRD Status

sg-logout-feature
  PRD: "Logout Feature Requirements"
  Source: local-file (logout-feature)
  PRD Path: .claude/prds/logout-feature/prd.md
  Version: 1.0.0
  Status: LINKED
  Last Synced: 2026-01-14T10:00:00Z

sg-auth-revamp
  PRD: "Authentication Revamp"
  Source: local-file (auth-revamp)
  PRD Path: .claude/prds/auth-revamp/prd.md
  Spec Version: 1.1.0
  PRD Version: 1.2.0  ← DRIFT DETECTED
  Status: OUT_OF_SYNC
  Last Synced: 2026-01-10T14:00:00Z
  Action: Run /prd diff sg-auth-revamp to see changes
```

### /prd diff

Shows differences between local requirements and PRD.

**Output**:

```
PRD Diff: sg-auth-revamp

PRD has been updated (1.1.0 → 1.2.0)

Changes detected:
  + NEW: REQ-005 "Multi-factor authentication support"
  ~ MODIFIED: REQ-002 "Session timeout changed from 30min to 15min"
  - REMOVED: REQ-004 "Remember me functionality" (moved to separate PRD)

Local changes not in PRD:
  + REQ-006 "Rate limiting for login attempts" (discovered during implementation)

Options:
  1. /prd sync sg-auth-revamp --merge   # Merge remote changes with local
  2. /prd sync sg-auth-revamp --replace # Replace local with remote
  3. /prd push sg-auth-revamp           # Push local discoveries to PRD
```

### /prd push

Pushes local discoveries back to the PRD.

**When to use**:

- Implementation revealed new requirements
- Assumptions were invalidated
- Constraints were discovered

**Process**:

1. Read local `requirements.md`
2. Compare with last synced state
3. Identify new/changed requirements
4. Dispatch `prd-writer` agent to:
   - Update `.claude/prds/<prd-id>/prd.md` with new requirements
   - Add "Implementation Notes" section
   - Increment version in frontmatter and `.prd-meta.json`
5. Update `manifest.json` with new PRD version
6. Set PRD version state to DRAFT (agent change, needs human review)

**Output**:

```
PRD updated successfully

PRD: "auth-revamp" (1.1.0 → 1.2.0)
Path: .claude/prds/auth-revamp/prd.md
Changes:
  + Added REQ-006: Rate limiting for login attempts
  + Added Implementation Note: "Rate limit discovered necessary during load testing"

PRD version: 1.2.0 (DRAFT - needs human review)
Local spec group: sg-auth-revamp (synced to 1.2.0)
```

## PRD Format Expectations

The `/prd` skill works best with PRDs that follow a structured format. The `prd-reader` agent can handle various formats but extracts most reliably from:

### Recommended PRD Structure

```
# [Product/Feature Name]

## Overview / Summary
Brief description of what this is and why it matters.

## Goals
- Goal 1
- Goal 2

## Non-Goals
- Explicitly out of scope item 1

## Requirements
### REQ-001: [Requirement Title]
[Description in natural language]

### REQ-002: [Requirement Title]
[Description]

## Constraints
- Technical constraint 1
- Business constraint 2

## Assumptions
- Assumption 1
- Assumption 2

## Success Criteria
- Measurable outcome 1
- Measurable outcome 2

## Open Questions
- [ ] Unresolved question 1
- [x] Resolved question → Answer

## Version History
- 1.0.0 (2026-01-10): Initial draft
- 1.1.0 (2026-01-14): Added REQ-003 based on user feedback
```

### Flexible Extraction

The `prd-reader` agent can also extract from less structured documents by:

- Looking for bullet points that describe behaviors
- Identifying "must", "shall", "should" language
- Finding sections labeled "requirements", "features", "user stories"
- Converting user stories to EARS format

## Integration with Workflow

### Flow 1: Create New PRD (PM → PRD → Specs)

```
User has idea/request
    ↓
/prd draft (or /pm first)
    ↓
PM interview gathers requirements
    ↓
Spec group created with requirements.md
    ↓
PRD written to .claude/prds/<prd-id>/prd.md
    ↓
User reviews PRD in .claude/prds/<prd-id>/prd.md
    ↓
/spec (creates spec.md from requirements)
    ↓
/atomize
    ↓
... implementation ...
    ↓
/prd push (if new requirements discovered)
    ↓
PRD updated with new version
```

### Flow 2: Sync Existing PRD (PRD → Specs)

```
PRD already exists in .claude/prds/<prd-id>/prd.md
    ↓
/prd sync <prd-id>
    ↓
prd-reader extracts requirements
    ↓
Spec group created with requirements.md
review_state: DRAFT
    ↓
User reviews extracted requirements
    ↓
/spec (creates spec.md from requirements)
    ↓
/atomize
    ↓
... implementation ...
    ↓
/prd push (if new requirements discovered)
    ↓
PRD updated with new version
```

### PM Skill Relationship

The `/pm` skill and `/prd` skill work together:

| Skill        | Purpose                                | Output                              |
| ------------ | -------------------------------------- | ----------------------------------- |
| `/pm`        | Gather requirements via interview      | `requirements.md` in spec group     |
| `/prd draft` | Interview + write PRD                  | PRD in `.claude/prds/` + spec group |
| `/prd write` | Write existing requirements to PRD     | PRD in `.claude/prds/`              |
| `/prd sync`  | Extract requirements from existing PRD | `requirements.md` in spec group     |

**When to use which:**

- **Starting fresh**: `/prd draft` — runs PM interview then writes PRD
- **Have requirements, need PRD**: `/prd write <prd-id>` — formats and writes
- **PRD exists, need spec group**: `/prd sync <prd-id>` — extracts requirements to spec group
- **Just gathering requirements (no PRD yet)**: `/pm` — interview only

## Agents

The `/prd` skill uses three specialized agents:

| Agent        | Purpose                                                | Used By                    |
| ------------ | ------------------------------------------------------ | -------------------------- |
| `prd-author` | Authors complete PRDs from requirements using template | `/prd draft`, `/prd write` |
| `prd-reader` | Extracts requirements from existing PRDs               | `/prd sync`                |
| `prd-writer` | Pushes incremental discoveries back to PRDs            | `/prd push`                |

### Agent Responsibilities

**prd-author** (`.claude/agents/prd-author.md`):

- Transforms `requirements.md` into full PRD document
- Follows PRD template structure exactly
- Writes to `.claude/prds/<prd-id>/prd.md`
- Generates User Stories from requirements
- Initializes version history

**prd-reader** (`.claude/agents/prd-reader.md`):

- Reads PRDs from `.claude/prds/<prd-id>/prd.md`
- Extracts requirements, constraints, assumptions
- Converts prose/user stories to EARS format
- Creates `requirements.md` in spec group

**prd-writer** (`.claude/agents/prd-writer.md`):

- Computes diff between spec group requirements and PRD
- Appends new requirements discovered during implementation
- Updates assumptions (marks invalidated)
- Adds implementation notes
- Increments PRD version in frontmatter

## Version Detection

The skill manages PRD versions through:

1. PRD frontmatter `version` field (e.g., `version: 1.2.0`)
2. `.prd-meta.json` file in each PRD directory
3. Version History section in the PRD document
4. Git commit history for change tracking

## State Transitions

### On /prd draft (new PRD + spec group)

```json
{
  "review_state": "DRAFT",
  "work_state": "PLAN_READY",
  "updated_by": "agent",
  "prd": {
    "source": "local-file",
    "file_path": ".claude/prds/<prd-id>/prd.md",
    "version": "1.0.0",
    "last_sync": "<now>",
    "created_by": "prd-draft"
  }
}
```

- PRD written to `.claude/prds/<prd-id>/prd.md`
- PRD version: 1.0.0 (DRAFT)
- Spec group linked to PRD

### On /prd write (write to existing PRD)

```json
{
  "prd": {
    "source": "local-file",
    "file_path": ".claude/prds/<prd-id>/prd.md",
    "version": "1.0.0",
    "last_sync": "<now>",
    "created_by": "prd-write"
  }
}
```

- Existing spec group's `manifest.json` updated with PRD link
- PRD content written to `.claude/prds/<prd-id>/prd.md`

### On /prd sync (new spec group from existing PRD)

```json
{
  "review_state": "DRAFT",
  "work_state": "PLAN_READY",
  "updated_by": "agent",
  "prd": {
    "source": "local-file",
    "file_path": ".claude/prds/<prd-id>/prd.md",
    "version": "1.0.0",
    "last_sync": "<now>"
  }
}
```

### On /prd push

- PRD file updated in `.claude/prds/<prd-id>/prd.md`
- Local `manifest.json` updated with new version reference
- Local `review_state` unchanged (local work continues)

### Backward Compatibility

For spec groups linked to external PRD sources (e.g., Google Docs), the `source` field supports:

```json
{
  "prd": {
    "source": "google-docs",
    "document_id": "...",
    "version": "1",
    "last_sync": "<now>"
  }
}
```

The primary workflow uses `"source": "local-file"`, but legacy sources (`google-docs`, `git-repo`) are still recognized.

## Error Handling

### PRD Not Found

```
Error: PRD 'logout-feature' not found

Expected path: .claude/prds/logout-feature/prd.md

Available PRDs:
  - auth-revamp (.claude/prds/auth-revamp/prd.md)
  - dashboard-v2 (.claude/prds/dashboard-v2/prd.md)
  - notification-system (.claude/prds/notification-system/prd.md)

Check PRD ID and try again, or use /prd draft to create new.
```

### No Requirements Found

```
Warning: No clear requirements found in PRD

The PRD exists but doesn't contain recognizable requirements.
Consider:
  1. Adding a "Requirements" section to the PRD
  2. Using /pm to interview and generate requirements locally
  3. Manually creating requirements.md

Spec group created with empty requirements.md
```

### PRD Directory Missing prd.md

```
Error: PRD directory exists but prd.md is missing

Directory: .claude/prds/logout-feature/
Expected file: .claude/prds/logout-feature/prd.md

The PRD directory exists but does not contain a prd.md file.
Use /prd draft or /prd write to create the PRD document.
```

## Edge Cases

### PRD Has Multiple Versions in One Document

Some PRDs track versions inline. The reader will:

- Extract the latest/current version's requirements
- Note previous versions in the change log
- Flag if version is ambiguous

### PRD is Actually a User Story Collection

If the document is Agile user stories rather than requirements:

- Convert "As a X, I want Y, so that Z" to EARS format
- Group related stories into single requirements where appropriate
- Flag for user review

### Linked PRD Deleted

```
Warning: Linked PRD no longer exists

Spec group: sg-logout-feature
Previous PRD: .claude/prds/logout-feature/prd.md

Options:
  1. /prd unlink sg-logout-feature  # Continue with local-only
  2. /prd link sg-logout-feature <new-prd-id>  # Link to replacement
  3. /prd draft sg-logout-feature  # Re-create PRD from requirements
```

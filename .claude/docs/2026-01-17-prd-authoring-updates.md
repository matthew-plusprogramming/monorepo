# PRD Authoring Updates — 2026-01-17

This document describes changes made to the `.claude/` structure to support full PRD authoring from PM interviews. Apply these changes to other projects using the same structure.

---

## Summary

Added the ability to **create new PRDs** from PM interviews and write them to Google Docs using the standard template. Previously, the `/prd` skill could only sync/extract from existing PRDs.

**New capabilities:**
- `/prd draft` — Run PM interview, then write PRD to Google Doc
- `/prd write <doc-id>` — Write requirements to a Google Doc as formatted PRD
- `prd-author` agent — Transforms requirements.md → full PRD document

**Updated integrations:**
- `/route` skill now includes PRD draft/push in workflow descriptions
- `/pm` skill now documents PRD integration in handoff steps

---

## Files Changed

### 1. Updated: `.claude/skills/prd/SKILL.md`

**Changes:**
- Updated description and allowed-tools in frontmatter
- Added `/prd draft` command documentation
- Added `/prd write` command documentation
- Added "Agents" section documenting all three PRD agents
- Updated "Integration with Workflow" with two flows
- Added "PM Skill Relationship" table
- Added state transitions for new commands

### 2. Updated: `.claude/skills/route/SKILL.md`

**Changes:**
- Updated "Integration with Other Skills" section to include PRD workflow
- Now documents that `/prd draft` is an optional step after PM interview
- Includes `/prd push` at end of workflow for syncing discoveries back

**Key section updated:**

```markdown
## Integration with Other Skills

After routing:
- **oneoff-vibe**: Proceed directly to implementation
- **oneoff-spec**: Use `/pm` to gather requirements → (optional) `/prd draft` to write PRD to Google Docs → `/spec` to create spec group → `/atomize` to create atomic specs → `/enforce` to validate atomicity → User approval → `/implement` + `/test` → `/unify` → `/code-review` → `/security` → (if PRD exists) `/prd push` to sync discoveries
- **orchestrator**: Use `/pm` to create ProblemBrief → (optional) `/prd draft` for stakeholder PRD → `/spec` to create MasterSpec with workstream spec groups → For each workstream: `/atomize` + `/enforce` → User approval → Facilitator orchestrates parallel execution → `/prd push` to sync discoveries
```

### 3. Updated: `.claude/skills/pm/SKILL.md`

**Changes:**
- Updated "Integration with Spec Group Workflow" section
- Added PRD draft as optional step after requirements gathering
- Added PRD push as step after implementation completes
- Documents the linking flow between PM interview and PRD creation

**Key section updated:**

```markdown
### Handoff to /spec

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

**Key sections added:**

```markdown
## Usage

/prd draft                     # Start PM interview, then draft PRD to Google Doc
/prd draft <spec-group-id>     # Draft PRD from existing spec group requirements
/prd write <doc-id>            # Write/overwrite PRD to specified Google Doc
/prd write <doc-id> <spec-group-id>  # Write specific spec group's PRD to doc
```

```markdown
## Agents

| Agent | Purpose | Used By |
|-------|---------|---------|
| `prd-author` | Authors complete PRDs from requirements using template | `/prd draft`, `/prd write` |
| `prd-reader` | Extracts requirements from existing PRDs | `/prd sync` |
| `prd-writer` | Pushes incremental discoveries back to PRDs | `/prd push` |
```

---

### 4. Created: `.claude/agents/prd-author.md`

**New agent for full PRD authoring.**

**Frontmatter:**
```yaml
---
name: prd-author
description: Authors complete PRDs from requirements using the standard template, writes to Google Docs
tools: Read, Glob, mcp__google-docs-mcp__readGoogleDoc, mcp__google-docs-mcp__appendToGoogleDoc, mcp__google-docs-mcp__insertText, mcp__google-docs-mcp__deleteRange, mcp__google-docs-mcp__createDocument, mcp__google-docs-mcp__getDocumentInfo
model: opus
skills: prd
---
```

**Key responsibilities:**
1. Load `requirements.md` from spec group
2. Load PRD template from `.claude/templates/prd.template.md`
3. Transform each section according to mapping:
   - Problem Statement → Overview
   - Goals → Goals
   - Non-Goals → Non-Goals
   - Requirements (REQ-XXX) → Requirements (EARS format)
   - Constraints → Constraints
   - Assumptions → Assumptions (with impact analysis)
   - Success Criteria → Success Criteria
   - Open Questions → Open Questions
   - Edge Cases → Incorporated into Requirements
   - (generated) → User Stories table
   - (initialized) → Version History
4. Write to Google Docs (create new or overwrite)
5. Update manifest.json with PRD link

**Sections in agent file:**
- Role
- When Invoked
- Input
- Responsibilities (16 detailed steps)
- Output Format
- Constraints (DO/DO NOT)
- Quality Checklist
- Error Handling
- Handoff

---

### 5. Required: `.claude/agents/prd-reader.md`

**Existing agent for extracting requirements from PRDs.**

**Frontmatter:**
```yaml
---
name: prd-reader
description: Extracts requirements, constraints, and assumptions from PRD documents
tools: Read, Write, Glob, mcp__google-docs-mcp__readGoogleDoc, mcp__google-docs-mcp__getDocumentInfo, mcp__google-docs-mcp__listDocumentTabs
model: opus
skills: prd
---
```

**Key responsibilities:**
1. Fetch and read Google Doc PRD documents
2. Detect document structure (headings, sections)
3. Extract requirements and convert to EARS format
4. Extract constraints, assumptions, success criteria
5. Detect PRD version
6. Generate `requirements.md` in spec group
7. Update manifest with PRD link and sync timestamp

---

### 6. Required: `.claude/agents/prd-writer.md`

**Existing agent for pushing incremental discoveries back to PRDs.**

**Frontmatter:**
```yaml
---
name: prd-writer
description: Pushes local requirement discoveries back to PRD documents
tools: Read, Glob, mcp__google-docs-mcp__readGoogleDoc, mcp__google-docs-mcp__appendToGoogleDoc, mcp__google-docs-mcp__insertText, mcp__google-docs-mcp__getDocumentInfo
model: opus
skills: prd
---
```

**Key responsibilities:**
1. Compute local changes (new requirements, modified, invalidated assumptions)
2. Read current PRD state for conflict detection
3. Format updates for PRD (new requirements, invalidated assumptions, implementation notes)
4. Increment PRD version
5. Apply updates using append strategy (default)
6. Update local manifest with new PRD version

---

### 7. Required: `.claude/templates/prd.template.md`

The `prd-author` agent depends on this template. Ensure it exists with the standard structure:

```markdown
# [Product/Feature Name] - PRD

**Version**: v1
**Status**: DRAFT | REVIEWED
**Owner**: [Name]
**Last Updated**: [Date]

---

## Overview
## Goals
## Non-Goals
## Requirements
### REQ-001: [Title]
## Constraints
## Assumptions
## Success Criteria
## Open Questions
## User Stories (Optional)
## Implementation Notes
## Version History
## EARS Format Reference
```

---

## Workflow Changes

### Before (sync-only)

```
PRD exists in Google Docs
    ↓
/prd sync <doc-id>
    ↓
prd-reader extracts requirements
    ↓
Spec group created
```

### After (create + sync)

**Flow 1: Create New PRD**
```
User has idea/request
    ↓
/prd draft (or /pm first)
    ↓
PM interview gathers requirements
    ↓
prd-author writes to Google Doc
    ↓
PRD created using template
    ↓
Spec group linked to PRD
```

**Flow 2: Sync Existing PRD** (unchanged)
```
PRD exists in Google Docs
    ↓
/prd sync <doc-id>
    ↓
prd-reader extracts requirements
    ↓
Spec group created
```

---

## Skill Relationship Clarification

| Skill | Purpose | Output |
|-------|---------|--------|
| `/pm` | Gather requirements via interview | `requirements.md` in spec group |
| `/prd draft` | Interview + write PRD to Google Doc | PRD in Google Docs + spec group |
| `/prd write` | Write existing requirements to PRD | PRD in Google Docs |
| `/prd sync` | Extract requirements from existing PRD | `requirements.md` in spec group |

**When to use which:**
- **Starting fresh**: `/prd draft` — runs PM interview then writes PRD
- **Have requirements, need PRD**: `/prd write <doc-id>` — formats and writes
- **PRD exists, need local requirements**: `/prd sync <doc-id>` — extracts to local
- **Just gathering requirements (no PRD yet)**: `/pm` — interview only

---

## Migration Steps

To apply these changes to another project:

### Step 1: Update `/prd` skill

Replace or merge changes into `.claude/skills/prd/SKILL.md`:

1. Update frontmatter:
```yaml
description: Create, sync, and manage PRDs in Google Docs. Draft new PRDs from PM interviews, sync existing PRDs, and push discoveries back.
allowed-tools: Read, Write, Glob, Task, mcp__google-docs-mcp__readGoogleDoc, mcp__google-docs-mcp__getDocumentInfo, mcp__google-docs-mcp__appendToGoogleDoc, mcp__google-docs-mcp__insertText, mcp__google-docs-mcp__deleteRange, mcp__google-docs-mcp__createDocument
```

2. Add new commands to Usage section
3. Add `/prd draft` command documentation
4. Add `/prd write` command documentation
5. Add "Agents" section
6. Update "Integration with Workflow" section
7. Add "PM Skill Relationship" section

### Step 2: Update `/route` skill

Merge changes into `.claude/skills/route/SKILL.md`:

1. Update the "Integration with Other Skills" section to include PRD workflow:

```markdown
## Integration with Other Skills

After routing:
- **oneoff-vibe**: Proceed directly to implementation
- **oneoff-spec**: Use `/pm` to gather requirements → (optional) `/prd draft` to write PRD to Google Docs → `/spec` to create spec group → `/atomize` to create atomic specs → `/enforce` to validate atomicity → User approval → `/implement` + `/test` → `/unify` → `/code-review` → `/security` → (if PRD exists) `/prd push` to sync discoveries
- **orchestrator**: Use `/pm` to create ProblemBrief → (optional) `/prd draft` for stakeholder PRD → `/spec` to create MasterSpec with workstream spec groups → For each workstream: `/atomize` + `/enforce` → User approval → Facilitator orchestrates parallel execution → `/prd push` to sync discoveries
```

### Step 3: Update `/pm` skill

Merge changes into `.claude/skills/pm/SKILL.md`:

1. Update the "Integration with Spec Group Workflow" > "Handoff to /spec" section:

```markdown
### Handoff to /spec

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

2. Add the "Linking to External PRD" subsection after "Handoff to /spec":

```markdown
### Linking to External PRD

If the requirements came from a user interview but should be linked to an external PRD:

/prd link sg-<feature-slug> <google-doc-id>

This will:
1. Update `manifest.json` with PRD reference
2. Mark requirements as needing sync verification
3. Enable `/prd push` to send discoveries back to the PRD
```

### Step 4: Copy all PRD agents

Copy these agent files to `.claude/agents/`:
- `prd-author.md` — Authors PRDs from requirements (NEW)
- `prd-reader.md` — Extracts requirements from existing PRDs
- `prd-writer.md` — Pushes discoveries back to PRDs

### Step 5: Copy PRD template

Copy `.claude/templates/prd.template.md` to target project. This template defines the standard PRD structure that `prd-author` uses.

### Step 6: Update CLAUDE.md

Add PRD skill and agents to the reference tables:

1. Add to **Core Skills** table:
   ```markdown
   | `/prd` | Create, sync, manage PRDs in Google Docs | Drafting new PRDs or syncing external ones |
   ```

2. Add to **Specialized Subagents** table:
   ```markdown
   | `prd-author` | opus | Author complete PRDs from requirements using template |
   | `prd-reader` | opus | Extract requirements from existing PRDs |
   | `prd-writer` | opus | Push incremental discoveries back to PRDs |
   ```

3. Update workflow descriptions to mention PRD integration:
   - In "Example Workflow" section, note that `/prd draft` can be run after PM interview
   - In "Medium Task (oneoff-spec)" flow, include optional `/prd draft` step

### Step 7: Verify other dependencies

The following must also exist:
- `.claude/skills/pm/SKILL.md` — For PM interviews (with PRD integration updates)
- `.claude/skills/route/SKILL.md` — For task routing (with PRD workflow updates)

---

## Google Docs MCP Tools Required

The `prd-author` agent requires these MCP tools:

```
mcp__google-docs-mcp__readGoogleDoc
mcp__google-docs-mcp__appendToGoogleDoc
mcp__google-docs-mcp__insertText
mcp__google-docs-mcp__deleteRange
mcp__google-docs-mcp__createDocument
mcp__google-docs-mcp__getDocumentInfo
```

Ensure the Google Docs MCP server is configured in your Claude Code settings.

---

## Verification Checklist

After migration, verify:

### PRD Skill Verification
- [ ] `/prd draft` starts PM interview and prompts for doc destination
- [ ] `/prd write new` creates a new Google Doc
- [ ] `/prd write <existing-doc-id>` writes to existing doc
- [ ] PRD follows template structure exactly
- [ ] All requirements have EARS format
- [ ] User Stories table is generated
- [ ] manifest.json updated with PRD link
- [ ] `/prd sync` still works for existing PRDs
- [ ] `/prd push` still works for incremental updates

### Route Skill Verification
- [ ] `/route` mentions `/prd draft` as optional step in oneoff-spec workflow
- [ ] `/route` mentions `/prd push` at end of workflow when PRD exists
- [ ] Orchestrator workflow includes PRD draft for stakeholder PRD

### PM Skill Verification
- [ ] `/pm` handoff section includes PRD draft as step 2 (optional)
- [ ] `/pm` handoff section includes PRD push as step 7 (if PRD exists)
- [ ] "Linking to External PRD" section exists with `/prd link` command

### Integration Verification
- [ ] Full workflow works: `/pm` → `/prd draft` → `/spec` → (implement) → `/prd push`
- [ ] Requirements flow correctly from PM interview → requirements.md → PRD
- [ ] Discoveries flow correctly from implementation → `/prd push` → PRD updates

---

## Files to Copy

For quick migration, copy these files to the target project:

```
.claude/
├── agents/
│   ├── prd-author.md          # NEW - authors full PRDs from requirements
│   ├── prd-reader.md          # REQUIRED - extracts requirements from PRDs
│   └── prd-writer.md          # REQUIRED - pushes discoveries back to PRDs
├── skills/
│   ├── prd/
│   │   └── SKILL.md           # UPDATED - merge or replace (adds draft/write commands)
│   ├── route/
│   │   └── SKILL.md           # UPDATED - merge PRD workflow into Integration section
│   └── pm/
│       └── SKILL.md           # UPDATED - merge PRD integration into Handoff section
├── templates/
│   └── prd.template.md        # REQUIRED - PRD template for prd-author
└── docs/
    └── 2026-01-17-prd-authoring-updates.md  # This file (optional, for reference)

Root:
└── CLAUDE.md                  # UPDATED - add /prd skill and PRD agents to tables
```

### File Summary

| File | Action | Purpose |
|------|--------|---------|
| `.claude/agents/prd-author.md` | Copy (new) | Authors complete PRDs from requirements using template |
| `.claude/agents/prd-reader.md` | Copy | Extracts requirements from existing PRDs |
| `.claude/agents/prd-writer.md` | Copy | Pushes incremental discoveries back to PRDs |
| `.claude/skills/prd/SKILL.md` | Replace or merge | Adds `/prd draft` and `/prd write` commands |
| `.claude/skills/route/SKILL.md` | Merge | Adds PRD to workflow integration section |
| `.claude/skills/pm/SKILL.md` | Merge | Adds PRD to handoff steps and linking |
| `.claude/templates/prd.template.md` | Copy | Standard PRD template structure |
| `CLAUDE.md` | Merge | Add `/prd` skill and PRD agents to reference tables |

### CLAUDE.md Updates Required

Add to **Core Skills** table:
```markdown
| `/prd` | Create, sync, manage PRDs in Google Docs | Drafting new PRDs or syncing external ones |
```

Add to **Specialized Subagents** table:
```markdown
| `prd-author` | opus | Author complete PRDs from requirements using template |
| `prd-reader` | opus | Extract requirements from existing PRDs |
| `prd-writer` | opus | Push incremental discoveries back to PRDs |
```

Update **Medium Task (oneoff-spec)** workflow to include PRD:
```markdown
#### Medium Task (oneoff-spec)

Request → Route → PM Interview → (optional) PRD Draft → Spec → Approve →
  [Parallel: Implement + Test] → Unify → Code Review → Security →
  [If UI: Browser Test] → [If public API: Docs] → [If PRD: Push discoveries] → Commit
```

---

## Related Context

This update was made while drafting a PRD for the "AI-Native Engineering Dashboard" project. The need arose because:

1. `/pm` skill gathers requirements but outputs `requirements.md` (internal format)
2. PRD template defines external document format for Google Docs
3. No skill/agent existed to transform requirements → PRD format
4. The `prd-author` agent bridges this gap

The PRD template and `requirements.md` format serve different purposes:
- `requirements.md` — Internal format for spec workflow
- PRD template — External format for stakeholder communication

Both are needed; the `prd-author` agent transforms one to the other.

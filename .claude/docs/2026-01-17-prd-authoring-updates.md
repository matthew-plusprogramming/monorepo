# PRD Authoring Updates — 2026-01-17

This document describes changes made to the `.claude/` structure to support full PRD authoring from PM interviews. Apply these changes to other projects using the same structure.

---

## Summary

Added the ability to **create new PRDs** from PM interviews and write them to Google Docs using the standard template. Previously, the `/prd` skill could only sync/extract from existing PRDs.

**New capabilities:**
- `/prd draft` — Run PM interview, then write PRD to Google Doc
- `/prd write <doc-id>` — Write requirements to a Google Doc as formatted PRD
- `prd-author` agent — Transforms requirements.md → full PRD document

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

### 2. Created: `.claude/agents/prd-author.md`

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

### 3. Required: `.claude/templates/prd.template.md`

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

### Step 2: Create `prd-author` agent

Copy `.claude/agents/prd-author.md` to the target project.

### Step 3: Verify template exists

Ensure `.claude/templates/prd.template.md` exists with the standard structure.

### Step 4: Verify dependencies

The following must exist:
- `.claude/agents/prd-reader.md` — For `/prd sync`
- `.claude/agents/prd-writer.md` — For `/prd push`
- `.claude/skills/pm/SKILL.md` — For PM interviews

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

- [ ] `/prd draft` starts PM interview and prompts for doc destination
- [ ] `/prd write new` creates a new Google Doc
- [ ] `/prd write <existing-doc-id>` writes to existing doc
- [ ] PRD follows template structure exactly
- [ ] All requirements have EARS format
- [ ] User Stories table is generated
- [ ] manifest.json updated with PRD link
- [ ] `/prd sync` still works for existing PRDs
- [ ] `/prd push` still works for incremental updates

---

## Files to Copy

For quick migration, copy these files to the target project:

```
.claude/
├── agents/
│   └── prd-author.md          # NEW - copy this
├── skills/
│   └── prd/
│       └── SKILL.md           # UPDATED - merge or replace
├── templates/
│   └── prd.template.md        # REQUIRED - ensure exists
└── docs/
    └── 2026-01-17-prd-authoring-updates.md  # This file (optional)
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

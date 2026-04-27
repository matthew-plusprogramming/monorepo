# Skill Required Context Convention

Every user-invocable SKILL.md declares a `## Required Context` section listing the memory-bank files its dispatched agent must read before beginning work. This document defines the convention for skill authors.

---

## Purpose

Skill dispatches are high-leverage boundaries: a single skill run can spawn one or more subagents that produce code, specs, tests, or documentation. Without an explicit context declaration, dispatched agents silently skip project conventions (AC format, testing boundaries, contract-first practices, observability patterns), and quality drifts invisibly across dispatches.

`## Required Context` makes per-skill context requirements inspectable, consistent, and enforceable. It complements the load triggers documented in `CLAUDE.md § Memory-Bank System → Retrieval Policy` -- the Retrieval Policy defines _which agent roles_ load _which files_; `## Required Context` declares the same contract _at the skill level_, where a human reads it before invoking.

See `CLAUDE.md § Memory-Bank System → Retrieval Policy` for the canonical agent-to-file mapping. Do not duplicate that table here.

---

## When to Add One

Add `## Required Context` when authoring any new user-invocable skill under `.claude/skills/<skill-name>/SKILL.md`. Every SKILL.md in this repository declares one -- missing sections are treated as an oversight.

Non-user-invocable helpers (internal sub-skills, one-off scripts) do not require the section.

---

## Choosing Files

Select memory-bank files whose content the dispatched agent will actually consult during the skill's work. Keep the list minimal -- four files is a soft ceiling; most skills list one to three.

Selection heuristic:

- **Match skill purpose to memory-bank content.** A refactoring skill selects `code-quality.md`, `software-principles.md`, and `testing.guidelines.md` because refactor is "improve quality while preserving behavior." A PRD skill selects `org-context.md` because PRD-writer consults it at cold start.
- **Reference canonical paths.** Use the exact path under `.claude/memory-bank/` -- e.g., `.claude/memory-bank/best-practices/contract-first.md`. Do not invent aliases.
- **Prefer specific to general.** If a best-practices file covers the skill's exact concern (e.g., `ears-format.md` for requirements work), cite it directly rather than the broader `spec-authoring.md`.
- **Do not pad.** Listing `project.brief.md` on every skill defeats the purpose. Include only files the agent will measurably use.

When in doubt, read the skill's canonical references already declared (`route`, `implement`, `spec`, `orchestrate`) and match their granularity.

---

## Placement Convention

The section is the first `##` heading after the H1 title.

- If the skill has a `## Pre-Flight Challenge` section, `## Required Context` goes **before** it.
- If no Pre-Flight section exists, `## Required Context` goes **before** `## Purpose`.

---

## Format (Exact Template)

```markdown
## Required Context

Before beginning work, read these files for project-specific guidelines:

- `<path>`
- `<path>`
```

- Heading: `## Required Context` (exact, no trailing punctuation)
- Intro line: `Before beginning work, read these files for project-specific guidelines:` (exact)
- Blank line between intro and bullet list
- Bullets: `- ` followed by a single backtick-wrapped relative path from repo root

---

## Example

From `.claude/skills/implement/SKILL.md`:

```markdown
# Implementation Skill

## Required Context

Before beginning work, read these files for project-specific guidelines:

- `.claude/memory-bank/best-practices/subagent-design.md`

## Pre-Flight Challenge

Before beginning work, address these operational feasibility questions:

...
```

See `.claude/skills/route/SKILL.md` and `.claude/skills/implement/SKILL.md` for live references.

---

## See Also

- `CLAUDE.md § Memory-Bank System → Retrieval Policy` -- canonical agent-to-file mapping
- `.claude/memory-bank/best-practices/subagent-design.md` -- how to design effective subagents
- `.claude/skills/route/SKILL.md`, `.claude/skills/implement/SKILL.md` -- canonical format references

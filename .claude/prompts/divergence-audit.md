# Divergence Audit Prompt

> **Usage**: Copy everything below the `---` line and paste it as your first message in a fresh Claude Code session opened at your workspace root (the directory that contains `metaclaude-assistant/` and your consumer repos as siblings). Run this periodically after making changes to any repo.

---

I need you to run a comprehensive divergence audit across my repos. This checks alignment between three layers:

1. **Ideal** (`ai-manifesto-audit/COMPILED-MANIFESTO.md`) — the extracted engineering principles
2. **Canonical** (`metaclaude-assistant/`) — the source-of-truth implementation
3. **Consumer repos** (all projects listed in `metaclaude-assistant/.claude/projects.json`) — synced targets

First, read `metaclaude-assistant/.claude/projects.json` to get the full list of consumer repos. Use that list wherever consumer repos are referenced below.

## Instructions

Dispatch **5 parallel explore agents** (all model: opus), one per audit dimension. Each agent should return a structured report with PASS/FAIL/WARN per check item. After all 5 return, synthesize a single summary with prioritized action items.

### Agent 1: Sync Freshness & Bundle Completeness

Check in `metaclaude-assistant`:

- Read `.claude/metaclaude-registry.json` — catalog every artifact
- For each bundle (minimal, core-workflow, full-workflow, orchestrator), verify every artifact in the bundle's `includes` array exists in the registry
- **CRITICAL**: Check if any artifact exists in the registry but is NOT in ANY bundle — this is the #1 recurring bug (the "facilitator/refactorer gap")
- For each consumer repo from `projects.json`: spot-check 5-10 key files (agents, scripts, settings.json) and compare file sizes/line counts against metaclaude-assistant originals
- Report: artifacts in registry but missing from bundles, stale files in consumer repos

### Agent 2: Agent Compliance

Across metaclaude-assistant and all consumer repos from `projects.json`:

- Read every `.claude/agents/*.md` file
- Verify each has: (a) valid YAML frontmatter with `name`, `description`, `tools`, `model: opus`, (b) a `## Hard Token Budget` section with explicit word limit, (c) no references to `sonnet` or `haiku` as model choices
- Check repo-specific agents too (e.g., `deployer.md` in repos that have it)
- Report: agents missing token budgets, agents with wrong model, agents with missing frontmatter fields

### Agent 3: Hook & Script Integrity

Across metaclaude-assistant and all consumer repos from `projects.json`:

- Read `.claude/settings.json` — catalog every hook (PostToolUse, SubagentStop, Stop)
- For each hook, verify the referenced script file exists on disk
- Compare consumer repo settings.json hooks against metaclaude-assistant's — flag any missing hooks
- Check that all hooks have `_source: "metaclaude"` and `_id` fields
- Verify `.claude/scripts/hook-wrapper.mjs` exists and is consistent across repos
- Verify `.claude/scripts/lib/constants.mjs` exists across repos
- Report: missing scripts, missing hooks, hook configuration drift

### Agent 4: Manifesto Practice Alignment

Read `ai-manifesto-audit/COMPILED-MANIFESTO.md` and compare against `metaclaude-assistant/CLAUDE.md`:

- Check all 17 practices from the manifesto (1.1-1.7, 2.1-2.5, 3.1-3.5) are reflected in CLAUDE.md
- Check for practices documented in CLAUDE.md that contradict or extend the manifesto
- Verify model selection mandate: CLAUDE.md should mandate opus-only, no sonnet/haiku
- Search ALL docs, specs, and templates in metaclaude-assistant for any references to `sonnet` or `haiku` as valid model choices
- Check memory-bank files exist and are referenced in the retrieval policy table
- Report: manifesto practices not yet codified, contradictions, stale model references

### Agent 5: Documentation & Infrastructure Health

In metaclaude-assistant:

- Verify `.claude/docs/HOOKS.md` exists and is accurate (hook table matches settings.json)
- Verify `.claude/docs/SYNC-SYSTEM.md` exists (sync documentation)
- Check `.claude/templates/` — verify template files exist and are registered
- Check `.claude/specs/schema/` — verify schema files exist
- Check that `.claude/scripts/test-hooks.mjs` exists (hook test harness)
- Optionally run `node .claude/scripts/test-hooks.mjs` and report results
- In consumer repos from `projects.json`: verify `.claude/docs/` files are synced
- Report: missing docs, broken references, infrastructure gaps

## Output Format

After all 5 agents return, give me a single consolidated report:

```
# Divergence Audit Report — [DATE]

## Summary Scorecard
| Dimension | Status | Issues |
|---|---|---|
| Sync & Bundles | PASS/WARN/FAIL | count |
| Agent Compliance | PASS/WARN/FAIL | count |
| Hooks & Scripts | PASS/WARN/FAIL | count |
| Manifesto Alignment | PASS/WARN/FAIL | count |
| Docs & Infrastructure | PASS/WARN/FAIL | count |

## Critical Issues (Fix Immediately)
- ...

## Warnings (Fix Soon)
- ...

## Action Items (Prioritized)
1. ...
2. ...

## What's Working Well
- ...
```

Prioritize action items by: (1) things that break sync, (2) things that violate manifesto principles, (3) documentation gaps.

# Prompts Directory

Reusable prompt templates for complex multi-agent workflows.

---

## Purpose

The `.claude/prompts/` directory contains **prompt templates** -- structured instructions designed to be pasted into a fresh Claude Code session to trigger multi-agent workflows. These are complex, multi-step orchestration prompts that go beyond what a single skill definition can express.

Prompts are synced to consumer projects via the metaclaude registry and bundle system, just like agents, skills, and scripts.

## Prompts vs Skills

| Aspect               | Prompts                                                      | Skills                               |
| -------------------- | ------------------------------------------------------------ | ------------------------------------ |
| **Initiated by**     | User (paste into session)                                    | Agent (dispatched via `/skill-name`) |
| **Delivery**         | Copy-paste from `.claude/prompts/`                           | Auto-loaded from `.claude/skills/`   |
| **Complexity**       | Multi-agent orchestration, audit workflows                   | Single-concern task execution        |
| **Parameterization** | Uses relative paths and `projects.json` references           | Uses spec-driven inputs              |
| **When to use**      | Periodic audits, cross-repo workflows, ad-hoc investigations | Standard development workflow tasks  |

**Rule of thumb**: If the workflow dispatches multiple parallel agents across repos, it belongs in `prompts/`. If it is a step in the standard development workflow (route, spec, implement, test, review), it belongs in `skills/`.

## Current Prompt Inventory

| Prompt           | File                  | Description                                                                                                                                                                |
| ---------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Divergence Audit | `divergence-audit.md` | Dispatches 5 parallel Explore agents to audit cross-repo alignment across sync freshness, agent compliance, hook integrity, manifesto alignment, and documentation health. |

## How to Add a New Prompt

Follow this checklist when adding a new prompt template:

1. **Create the prompt file** at `.claude/prompts/<name>.md`
   - Include a usage instruction block at the top (above the `---` separator)
   - Structure the prompt with clear agent dispatch sections
   - Define the expected output format

2. **Parameterize for consumer portability** (see conventions below)

3. **Register in the registry**: Add an entry under `artifacts.prompts` in `.claude/metaclaude-registry.json`:

   ```json
   "<name>": {
     "version": "1.0.0",
     "hash": "00000000",
     "path": ".claude/prompts/<name>.md",
     "description": "Brief description of what the prompt does"
   }
   ```

4. **Add to a bundle**: Add `"prompts/<name>"` to the appropriate bundle's `includes` array in the registry (typically `full-workflow`)

5. **Compute hash**: Run `node .claude/scripts/compute-hashes.mjs --update` to replace the placeholder hash

6. **Verify**: Run `node .claude/scripts/compute-hashes.mjs --verify` to confirm the hash is correct

7. **Test sync**: Run `node .claude/scripts/metaclaude-cli.mjs sync <project> --force` and verify the prompt arrives in the consumer project

8. **Update this inventory**: Add the new prompt to the inventory table above

## Parameterization Conventions

Prompts synced to consumer repos must be portable. Follow these conventions:

### No absolute paths

Never use paths like `/Users/username/workspace/`. Instead, reference locations relative to the workspace root (e.g., `metaclaude-assistant/`, `../metaclaude-assistant/`).

### No hardcoded consumer repo names

Do not list specific consumer repos (e.g., `ai-eng-dashboard`, `monorepo`). Instead, instruct the agent to read `metaclaude-assistant/.claude/projects.json` for the current list of consumer repos. This keeps prompts accurate as projects are added or removed.

### No hardcoded counts

Do not write "3 consumer repos" or "ALL 4 repos". Instead, reference "all consumer repos from `projects.json`" or "metaclaude-assistant plus all consumer repos from `projects.json`".

### Usage instruction block

Every prompt should start with a usage instruction above the `---` separator that explains where to open the Claude Code session and any prerequisites. The content below `---` is what gets pasted.

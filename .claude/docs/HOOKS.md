# Validation Hooks System

This document describes the PostToolUse hooks system that validates agent work in real-time, catching issues immediately after file edits rather than during code review or CI.

---

## Overview

The hooks system provides automated validation that runs after every Edit or Write operation. Hooks are defined in `.claude/settings.json` and execute validation scripts that catch common issues early.

**Key Benefits**:

- Immediate feedback on type errors, linting issues, and schema violations
- Consistent validation across all projects synced from metaclaude-assistant
- Workspace-aware scripts for monorepo support

---

## Hook Input Mechanism

Claude Code hooks receive input via **stdin as JSON**, not environment variables. The JSON includes information about the tool that was used and its parameters.

### Input Format for Edit/Write Hooks

```json
{
  "session_id": "abc123",
  "cwd": "/path/to/project",
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "/path/to/edited/file.ts",
    "old_string": "...",
    "new_string": "..."
  }
}
```

The key field is `tool_input.file_path` which contains the absolute path to the file that was edited or written.

### Available Environment Variables

| Variable             | Availability      | Purpose                                      |
| -------------------- | ----------------- | -------------------------------------------- |
| `CLAUDE_PROJECT_DIR` | All hooks         | Project root directory                       |
| `CLAUDE_CODE_REMOTE` | All hooks         | Whether running remotely (`"true"` or unset) |
| `CLAUDE_ENV_FILE`    | SessionStart only | Path to persist env vars for session         |

**Note**: There is no `CLAUDE_FILE_PATHS` environment variable. File paths must be extracted from stdin JSON.

---

## Hook Architecture

### Trigger Points

| Hook Event     | When Triggered                | Matchers      | Use Case                         |
| -------------- | ----------------------------- | ------------- | -------------------------------- |
| `PostToolUse`  | After Edit or Write completes | `Edit\|Write` | File validation                  |
| `PostToolUse`  | After Read completes          | `Read`        | Superseded artifact warnings     |
| `PostToolUse`  | After Bash completes          | `Bash`        | Commit policy enforcement        |
| `SubagentStop` | When a subagent completes     | (none)        | Convergence gate reminders       |
| `Stop`         | When session ends             | (none)        | Session logging and finalization |

### Configuration Location

Hooks are configured in `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "_source": "metaclaude",
            "_id": "hook-id",
            "type": "command",
            "command": "..."
          }
        ]
      }
    ]
  }
}
```

### Hook Identification

Each metaclaude hook includes:

- `_source`: Always `"metaclaude"` to identify hooks managed by this system
- `_id`: Unique identifier for the hook (used for merging during sync)

---

## The Hook Wrapper Script

Since hooks receive JSON via stdin, we use `hook-wrapper.mjs` to handle the parsing and pattern matching.

### Location

`.claude/scripts/hook-wrapper.mjs`

### Usage

```bash
node .claude/scripts/hook-wrapper.mjs '<pattern>' '<command>'
```

The wrapper:

1. Reads JSON from stdin
2. Extracts `tool_input.file_path`
3. Checks if the file matches the pattern
4. If it matches, runs the command with `{{file}}` replaced by the actual file path
5. Outputs results (limited to 50 lines)

### Pattern Syntax

| Pattern               | Matches                              |
| --------------------- | ------------------------------------ |
| `*.ts`                | Files ending in .ts                  |
| `*.json`              | Files ending in .json                |
| `*CLAUDE.md`          | Files named CLAUDE.md                |
| `.claude/agents/*.md` | MD files directly in .claude/agents/ |
| `.claude/**`          | Any file under .claude/              |
| `.claude/templates/*` | Files directly in .claude/templates/ |

### Example Hook

```json
{
  "_source": "metaclaude",
  "_id": "json-validate",
  "type": "command",
  "command": "node .claude/scripts/hook-wrapper.mjs '*.json' 'node validate-json.mjs {{file}}'"
}
```

---

## Current Hooks

### PostToolUse Hooks (Edit|Write)

| Hook ID                      | Trigger Pattern         | Script                            | Purpose                                                |
| ---------------------------- | ----------------------- | --------------------------------- | ------------------------------------------------------ |
| `typescript-typecheck`       | `*.ts,*.tsx`            | `workspace-tsc.mjs`               | TypeScript type checking via workspace-aware tsc       |
| `eslint-check`               | `*.ts,*.tsx,*.js,*.jsx` | `workspace-eslint.mjs`            | Linting via workspace-aware ESLint                     |
| `json-validate`              | `*.json`                | inline JSON.parse                 | JSON syntax validation                                 |
| `claude-md-drift`            | `*CLAUDE.md`            | `verify-claude-md-base.mjs`       | Detect CLAUDE.md drift from canonical base             |
| `manifest-validate`          | `*manifest.json`        | `validate-manifest.mjs`           | Validate manifest against spec-group schema            |
| `template-validate`          | `.claude/templates/*`   | `template-validate.mjs`           | Validate template structure and placeholders           |
| `registry-hash-verify`       | `.claude/**`            | `compute-hashes.mjs --verify`     | Artifact hash verification                             |
| `agent-frontmatter-validate` | `.claude/agents/*.md`   | `validate-agent-frontmatter.mjs`  | Agent frontmatter schema validation                    |
| `skill-frontmatter-validate` | `*SKILL.md`             | `validate-skill-frontmatter.mjs`  | Skill frontmatter schema validation                    |
| `spec-schema-validate`       | `.claude/specs/**/*.md` | `spec-schema-validate.mjs`        | JSON schema validation for specs                       |
| `spec-validate`              | `.claude/specs/**/*.md` | `spec-validate.mjs`               | Spec markdown structure validation                     |
| `progress-heartbeat-check`   | `.claude/specs/**`      | `progress-heartbeat-check.mjs`    | Enforce progress logging (warn 15min, block 3x)        |
| `registry-artifact-validate` | `*artifacts.json`       | `registry-artifact-validate.mjs`  | Validate artifact registry schema and semantics        |
| `convergence-field-validate` | `*manifest.json`        | `validate-convergence-fields.mjs` | Validate convergence field names against canonical set |
| `spec-manifest-sync`         | `*manifest.json`        | `validate-spec-manifest-sync.mjs` | Detect drift between manifest state and spec tasks     |
| `structured-error-validate`  | `*.ts,*.tsx`            | `structured-error-validator.mjs`  | Warn on raw `throw new Error()` in non-test files      |
| `evidence-table-check`       | `.claude/specs/**/*.md` | `evidence-table-check.mjs`        | Warn when implementing spec lacks evidence table       |
| `spec-approval-hash`         | `.claude/specs/**/*.md` | `spec-approval-hash.mjs`          | Detect content drift in approved specs                 |
| `session-state-validate`     | (no pattern)            | `session-validate.mjs`            | Validate session.json schema compliance                |
| `prettier-format`            | (no pattern)            | inline `npx prettier`             | Auto-format edited files with Prettier                 |

### PostToolUse Hooks (Read)

| Hook ID                    | Trigger Pattern         | Script                         | Purpose                            |
| -------------------------- | ----------------------- | ------------------------------ | ---------------------------------- |
| `superseded-artifact-warn` | `.claude/specs/**/*.md` | `superseded-artifact-warn.mjs` | Warn when reading superseded specs |

### PostToolUse Hooks (Bash)

| Hook ID                | Script                     | Purpose                                                            |
| ---------------------- | -------------------------- | ------------------------------------------------------------------ |
| `journal-commit-check` | `journal-commit-check.mjs` | Warn on commits when journal entry is required but not created     |
| `dirty-manifest-check` | `dirty-manifest-check.mjs` | Warn on commits when spec-group manifests have uncommitted changes |

### SubagentStop Hooks

| Hook ID                     | Script                          | Purpose                                                                 |
| --------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `convergence-gate-reminder` | `convergence-gate-reminder.mjs` | Remind main agent to update convergence gates after subagent completion |

### Stop Hooks

| Hook ID                   | Script / Command              | Purpose                                                          |
| ------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| `session-log`             | inline `echo` command         | Logs session end time to `.claude/context/session.log`           |
| `session-state-finalize`  | inline `node -e` command      | Mark session.json as interrupted if not completed gracefully     |
| `journal-promotion-check` | `journal-promotion-check.mjs` | Suggest journal entries for memory-bank promotion at session end |

---

## Validation Scripts

All validation scripts are located in `.claude/scripts/`.

### hook-wrapper.mjs

**Purpose**: Parse stdin JSON from Claude Code and route to appropriate validation command.

**Behavior**:

1. Reads JSON from stdin
2. Extracts `tool_input.file_path`
3. Matches file against provided glob pattern
4. Executes command with `{{file}}` substituted
5. Limits output to 50 lines

### verify-claude-md-base.mjs

**Purpose**: Detect when a project's CLAUDE.md has drifted from the canonical base.

**Behavior**:

1. Reads the project's CLAUDE.md
2. Compares against `.claude/templates/claude-md-base.md`
3. Reports if the base content has been modified (project-specific additions are allowed)

### validate-agent-frontmatter.mjs

**Purpose**: Validate agent definition frontmatter.

**Required Fields**:

- `name`: Agent name (string)
- `description`: One-line description (string)
- `tools`: Comma-separated tool list (string)
- `model`: Model to use - `opus` (string)

**Optional Fields**:

- `skills`: Comma-separated skill list
- `exit_validation`: Array of validation commands

### validate-skill-frontmatter.mjs

**Purpose**: Validate skill definition frontmatter.

**Required Fields**:

- `name`: Skill name (string)
- `description`: One-line description (string)
- `allowed-tools`: Comma-separated tool list (string)
- `user-invocable`: Whether user can invoke directly (boolean)

### compute-hashes.mjs

**Purpose**: Compute and verify hashes for .claude artifacts.

**Usage**:

- `compute-hashes.mjs` - Compute hashes for all artifacts
- `compute-hashes.mjs --verify` - Verify artifacts match expected hashes

**Behavior with --verify**:

- Compares current file hashes against stored hashes
- Reports any modified files that should not have changed
- Used to detect unauthorized modifications

### validate-manifest.mjs

**Purpose**: Validate `manifest.json` files against the spec-group schema.

### template-validate.mjs

**Purpose**: Validate template files maintain required structure.

### workspace-tsc.mjs

**Purpose**: Run TypeScript type checking scoped to the workspace containing the edited file.

**Behavior**:

1. Finds the nearest `tsconfig.json` by walking up from the edited file
2. Runs `tsc --noEmit` on the file using that config
3. Reports type errors if any are found
4. Supports monorepo setups where each package has its own tsconfig

### workspace-eslint.mjs

**Purpose**: Run ESLint linting scoped to the workspace containing the edited file.

**Behavior**:

1. Finds the nearest ESLint config by walking up from the edited file
2. Runs ESLint on the file using that config
3. Reports linting errors and warnings
4. Supports monorepo setups where each package has its own ESLint config

### spec-schema-validate.mjs

**Purpose**: Validate spec files against their JSON schema definitions.

**Behavior**:

1. Reads the spec file and extracts frontmatter
2. Determines the spec type from the frontmatter
3. Validates frontmatter against the expected schema for that spec type
4. Reports schema violations (missing required fields, invalid values)

### spec-validate.mjs

**Purpose**: Validate spec markdown structure and required sections.

**Behavior**:

1. Parses the spec file as markdown
2. Checks for required sections based on spec type
3. Validates section formatting and content structure
4. Reports structural issues (missing sections, malformed content)

### progress-heartbeat-check.mjs

**Purpose**: Enforce progress logging during spec implementation.

**Behavior**:

1. Finds the spec group containing the edited file
2. Reads `manifest.json` to check `last_progress_update` timestamp
3. If stale (>15 minutes), increments `heartbeat_warnings` counter
4. At 3 warnings, blocks further edits until progress is logged
5. When progress is logged, resets `heartbeat_warnings` to 0

**Key Constants**:

- Stale threshold: 15 minutes
- Warning limit: 3 (then blocks)

### registry-artifact-validate.mjs

**Purpose**: Validate artifact registry JSON against schema with semantic checks.

**Behavior**:

1. Loads `artifacts.json` and validates against `schema.json`
2. Checks for duplicate spec group IDs
3. Validates supersession relationships are bidirectional
4. Detects circular supersession chains
5. Verifies referenced paths exist

### superseded-artifact-warn.mjs

**Purpose**: Warn when reading specs marked as superseded.

**Behavior**:

1. Parses YAML frontmatter from spec file
2. Checks for `status: superseded` field
3. If superseded, emits warning with:
   - `superseded_by` - the replacing spec ID
   - `supersession_date` - when it was superseded
   - `supersession_reason` - why it was replaced

### validate-convergence-fields.mjs

**Purpose**: Validate convergence object field names in manifest.json.

**Behavior**:

1. Parses `manifest.json` and extracts the convergence object
2. Checks each field name against the 8 canonical convergence gate fields
3. Suggests corrections for misspelled or non-canonical field names
4. Reports error if non-canonical fields found

### validate-spec-manifest-sync.mjs

**Purpose**: Detect drift between manifest work state and spec task completion.

**Behavior**:

1. Checks if manifest `work_state` is `READY_TO_MERGE` or `VERIFYING`
2. Reads the corresponding spec file and counts unchecked task boxes
3. Warns if manifest claims completion but spec has unchecked tasks

### structured-error-validator.mjs

**Purpose**: Warn on raw `throw new Error()` patterns in TypeScript files.

**Behavior**:

1. Scans file for `Error` constructor usage
2. Skips test files (`__tests__`, `*.test.ts`, `*.spec.ts`)
3. Warns to use typed error classes from the structured error taxonomy
4. Always exits 0 (warning only, never blocks)

### evidence-table-check.mjs

**Purpose**: Warn when an atomic spec with `status: implementing` lacks a populated evidence table.

**Behavior**:

1. Checks frontmatter for `status: implementing`
2. Searches for an Evidence Table section with at least one data row
3. Warns if implementing without evidence (Practice 1.7 compliance)
4. Always exits 0 (warning only)

### spec-approval-hash.mjs

**Purpose**: Detect content drift in approved specs by comparing body hash.

**Behavior**:

1. Computes SHA256 hash of the spec body (below frontmatter)
2. For approved specs, compares against `approval_hash` in frontmatter
3. Warns if content changed post-approval or if hash is missing
4. Always exits 0 (warning only)

### session-validate.mjs

**Purpose**: Validate `session.json` against the session schema.

**Behavior**:

1. Loads `.claude/context/session.json` and `.claude/specs/schema/session.schema.json`
2. Validates version (semver), timestamps (ISO 8601), workflow/phase/status enums
3. Checks spec group ID patterns (`sg-<slug>`) and atomic spec ID patterns (`as-NNN`)
4. Reports validation failures, exits 1 on error

### journal-commit-check.mjs

**Purpose**: Warn on git commits when a journal entry is required but not created.

**Behavior**:

1. Reads `session.json` phase checkpoint
2. If `journal_required: true` and `journal_created` is not true, prints warning to stderr and exits with code 2
3. Only triggers on Bash commands containing `git commit`
4. Exit 2 causes PostToolUse to show the warning to Claude (soft warning, not a hard block)

### dirty-manifest-check.mjs

**Purpose**: Warn on git commits when spec-group manifest.json files have uncommitted changes.

**Behavior**:

1. Runs `git status --porcelain` scoped to `.claude/specs/groups/**/manifest.json`
2. If dirty manifests found, prints warning to stderr and exits with code 2
3. Only triggers on Bash commands containing `git commit`
4. Exit 2 causes PostToolUse to show the warning to Claude (soft warning, not a hard block)

### convergence-gate-reminder.mjs

**Purpose**: Remind the main agent to update convergence gates after subagent completion.

**Behavior**:

1. Reads SubagentStop event data from stdin (JSON with `agent_type` field)
2. Maps agent type to convergence gate field (e.g., `implementer` → `all_acs_implemented`)
3. Outputs JSON with `additionalContext` containing the reminder
4. Returns empty JSON `{}` for unmapped agent types

**Gate Mapping**:

| Agent Type          | Convergence Gate Field   |
| ------------------- | ------------------------ |
| `implementer`       | `all_acs_implemented`    |
| `test-writer`       | `all_tests_passing`      |
| `unifier`           | `unifier_passed`         |
| `code-reviewer`     | `code_review_passed`     |
| `security-reviewer` | `security_review_passed` |
| `browser-tester`    | `browser_tests_passed`   |
| `documenter`        | `docs_generated`         |

### journal-promotion-check.mjs

**Purpose**: Suggest promotion of frequently-tagged journal entries to memory-bank.

**Behavior**:

1. Scans `.claude/journal/entries/` for markdown files
2. Parses frontmatter tags and type fields
3. Suggests promotion when a tag or type appears 3+ times
4. Runs at session end, informational only (always exits 0)

---

## Hook Execution Flow

```
                                    Edit/Write Tool Executed
                                             |
                                             v
                                   +-------------------+
                                   |  File Modified    |
                                   +-------------------+
                                             |
                                             v
                                   +-------------------+
                                   | PostToolUse Hooks |
                                   |    Triggered      |
                                   +-------------------+
                                             |
                                             v
                                   +-------------------+
                                   | hook-wrapper.mjs  |
                                   | (parses stdin)    |
                                   +-------------------+
                                             |
              +------------------------------+------------------------------+
              |              |               |              |               |
              v              v               v              v               v
        +---------+    +---------+    +---------+    +---------+    +---------+
        |  JSON   |    | CLAUDE  |    |Manifest |    | Agent   |    |  Skill  |
        |Validate |    |MD Drift |    |Validate |    |Validate |    |Validate |
        +---------+    +---------+    +---------+    +---------+    +---------+
              |              |               |              |               |
              +------------------------------+------------------------------+
                                             |
                                             v
                                   +-------------------+
                                   | Results Reported  |
                                   | (Warnings Only)   |
                                   +-------------------+
```

---

## Adding New Hooks

### Step 1: Create Validation Script

Create a new script in `.claude/scripts/`:

```javascript
#!/usr/bin/env node

// .claude/scripts/my-validator.mjs

import { readFileSync } from 'fs';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: my-validator.mjs <file>');
  process.exit(1);
}

try {
  const content = readFileSync(filePath, 'utf-8');
  // Perform validation
  const errors = [];
  // ...

  if (errors.length > 0) {
    console.error('Validation errors:');
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  process.exit(0);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
```

### Step 2: Add Hook to settings.json

Add the hook to `.claude/settings.json`:

```json
{
  "_source": "metaclaude",
  "_id": "my-validator",
  "type": "command",
  "command": "node .claude/scripts/hook-wrapper.mjs '*.myext' 'node .claude/scripts/my-validator.mjs {{file}}'"
}
```

### Hook Command Pattern

The standard pattern for hooks using the wrapper:

```bash
node .claude/scripts/hook-wrapper.mjs '<pattern>' '<command with {{file}}>'
```

**Components**:

- `'<pattern>'` - Glob pattern to match files (e.g., `*.ts`, `.claude/agents/*.md`)
- `'<command>'` - Command to run, with `{{file}}` as placeholder for the file path
- The wrapper handles stdin parsing, pattern matching, and output limiting

### Step 3: Register Script (If Syncing)

If the script should sync to consumer projects, add it to `metaclaude-registry.json`:

```json
{
  "artifacts": {
    "scripts": {
      "my-validator": {
        "source": ".claude/scripts/my-validator.mjs",
        "bundles": ["core-workflow", "full-workflow", "orchestrator"]
      }
    }
  }
}
```

---

## Sync and Merge Behavior

When syncing to consumer projects, settings.json uses a merge strategy:

### Merge Rules

1. **Metaclaude hooks** (identified by `_source: "metaclaude"`) are replaced with the latest version
2. **Project-specific hooks** (no `_source` field) are preserved
3. **Hook order**: Project hooks first, then metaclaude hooks

### Example Merge

**Source (metaclaude)**:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "_source": "metaclaude", "_id": "json-validate", "command": "..." }
        ]
      }
    ]
  }
}
```

**Target (consumer project)**:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "_id": "custom-lint", "command": "custom-lint-script" }]
      }
    ]
  }
}
```

**Result (merged)**:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "_id": "custom-lint", "command": "custom-lint-script" },
          { "_source": "metaclaude", "_id": "json-validate", "command": "..." }
        ]
      }
    ]
  }
}
```

---

## Troubleshooting

### Hook Not Running

1. **Check file pattern**: Ensure the file matches the hook's pattern in hook-wrapper.mjs
2. **Check script exists**: Verify the script exists at `.claude/scripts/<script>`
3. **Check wrapper**: Run the wrapper manually to debug:
   ```bash
   echo '{"tool_input":{"file_path":"/path/to/test.json"}}' | node .claude/scripts/hook-wrapper.mjs '*.json' 'echo {{file}}'
   ```

### Hook Errors

1. **Check script output**: Run the script manually with the file path
2. **Check dependencies**: Ensure required tools are installed
3. **Check working directory**: Some scripts require running from a specific directory

### Debugging the Wrapper

Test the wrapper with mock input:

```bash
# Test pattern matching
echo '{"tool_input":{"file_path":"src/test.ts"}}' | node .claude/scripts/hook-wrapper.mjs '*.ts' 'echo "Matched: {{file}}"'

# Test with actual script
echo '{"tool_input":{"file_path":".claude/agents/test.md"}}' | node .claude/scripts/hook-wrapper.mjs '.claude/agents/*.md' 'node .claude/scripts/validate-agent-frontmatter.mjs {{file}}'
```

### Disabling Hooks Temporarily

To temporarily disable hooks, rename settings.json:

```bash
mv .claude/settings.json .claude/settings.json.bak
# ... do work without hooks ...
mv .claude/settings.json.bak .claude/settings.json
```

---

## Related Documentation

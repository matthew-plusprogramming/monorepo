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

| Hook Event     | When Triggered                | Matchers      | Use Case                                                                       |
| -------------- | ----------------------------- | ------------- | ------------------------------------------------------------------------------ |
| `PreToolUse`   | Before Edit or Write executes | `Edit\|Write` | Trace read enforcement                                                         |
| `PostToolUse`  | After Edit or Write completes | `Edit\|Write` | File validation                                                                |
| `PostToolUse`  | After Read completes          | `Read`        | Superseded artifact warnings, trace read tracking                              |
| `PostToolUse`  | After Bash completes          | `Bash`        | Commit policy enforcement, trace staleness checks                              |
| `SubagentStop` | When a subagent completes     | (none)        | Convergence gate reminders, automated pass evidence recording, advisory checks |
| `Stop`         | When session ends             | (none)        | Session logging and finalization                                               |

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

### PreToolUse Hooks (Edit|Write)

| Hook ID                  | Trigger Pattern | Script                       | Purpose                                                      |
| ------------------------ | --------------- | ---------------------------- | ------------------------------------------------------------ |
| `trace-read-enforcement` | `Edit\|Write`   | `trace-read-enforcement.mjs` | Block edits to files in traced modules unless trace was read |

### PreToolUse Hooks (Agent)

| Hook ID                     | Trigger Pattern | Script                          | Purpose                                                                       |
| --------------------------- | --------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| `workflow-gate-enforcement` | `Agent`         | `workflow-gate-enforcement.mjs` | Block dispatch of enforced subagent types when workflow prerequisites not met |

### PreToolUse Hooks (Write - Enforcement File Protection)

| Hook ID                    | Trigger Pattern | Script                         | Purpose                                                                 |
| -------------------------- | --------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `workflow-file-protection` | `Write`         | `workflow-file-protection.mjs` | Block agent writes to gate-override.json, kill switch, and session.json |

### PostToolUse Hooks (Edit|Write)

| Hook ID                      | Trigger Pattern         | Script                            | Purpose                                                                |
| ---------------------------- | ----------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| `typescript-typecheck`       | `*.ts,*.tsx`            | `workspace-tsc.mjs`               | TypeScript type checking via workspace-aware tsc                       |
| `eslint-check`               | `*.ts,*.tsx,*.js,*.jsx` | `workspace-eslint.mjs`            | Linting via workspace-aware ESLint                                     |
| `json-validate`              | `*.json`                | inline JSON.parse                 | JSON syntax validation                                                 |
| `claude-md-drift`            | `*CLAUDE.md`            | `verify-claude-md-base.mjs`       | Detect CLAUDE.md drift from canonical base                             |
| `manifest-validate`          | `*manifest.json`        | `validate-manifest.mjs`           | Validate manifest against spec-group schema                            |
| `template-validate`          | `.claude/templates/*`   | `template-validate.mjs`           | Validate template structure and placeholders                           |
| `agent-frontmatter-validate` | `.claude/agents/*.md`   | `validate-agent-frontmatter.mjs`  | Agent frontmatter schema validation                                    |
| `skill-frontmatter-validate` | `*SKILL.md`             | `validate-skill-frontmatter.mjs`  | Skill frontmatter schema validation                                    |
| `spec-schema-validate`       | `.claude/specs/**/*.md` | `spec-schema-validate.mjs`        | JSON schema validation for specs (incl. e2e_skip)                      |
| `spec-validate`              | `.claude/specs/**/*.md` | `spec-validate.mjs`               | Spec markdown structure, e2e opt-out, and env-dependent AC enforcement |
| `progress-heartbeat-check`   | `.claude/specs/**`      | `progress-heartbeat-check.mjs`    | Enforce progress logging (warn 15min, block 3x)                        |
| `registry-artifact-validate` | `*artifacts.json`       | `registry-artifact-validate.mjs`  | Validate artifact registry schema and semantics                        |
| `convergence-field-validate` | `*manifest.json`        | `validate-convergence-fields.mjs` | Validate convergence field names against canonical set                 |
| `spec-manifest-sync`         | `*manifest.json`        | `validate-spec-manifest-sync.mjs` | Detect drift between manifest state and spec tasks                     |
| `structured-error-validate`  | `*.ts,*.tsx`            | `structured-error-validator.mjs`  | Warn on raw `throw new Error()` in non-test files                      |
| `evidence-table-check`       | `.claude/specs/**/*.md` | `evidence-table-check.mjs`        | Warn when implementing spec lacks evidence table                       |
| `spec-approval-hash`         | `.claude/specs/**/*.md` | `spec-approval-hash.mjs`          | Detect content drift in approved specs                                 |
| `session-state-validate`     | (no pattern)            | `session-validate.mjs`            | Validate session.json schema compliance                                |
| `prettier-format`            | (no pattern)            | inline `npx prettier`             | Auto-format edited files with Prettier                                 |

### PostToolUse Hooks (Read)

| Hook ID                    | Trigger Pattern         | Script                         | Purpose                                                    |
| -------------------------- | ----------------------- | ------------------------------ | ---------------------------------------------------------- |
| `superseded-artifact-warn` | `.claude/specs/**/*.md` | `superseded-artifact-warn.mjs` | Warn when reading superseded specs                         |
| `trace-read-tracker`       | (all reads)             | `trace-read-tracker.mjs`       | Record which trace files the agent has read in the session |

### PostToolUse Hooks (Bash)

| Hook ID                  | Script                       | Purpose                                                            |
| ------------------------ | ---------------------------- | ------------------------------------------------------------------ |
| `journal-commit-check`   | `journal-commit-check.mjs`   | Warn on commits when journal entry is required but not created     |
| `dirty-manifest-check`   | `dirty-manifest-check.mjs`   | Warn on commits when spec-group manifests have uncommitted changes |
| `trace-commit-staleness` | `trace-commit-staleness.mjs` | Block commits when staged files have stale traces                  |

### SubagentStop Hooks

| Hook ID                     | Script                          | Purpose                                                                   |
| --------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `convergence-gate-reminder` | `convergence-gate-reminder.mjs` | Remind main agent to update convergence gates after subagent completion   |
| `convergence-pass-recorder` | `convergence-pass-recorder.mjs` | Automatically record pass evidence when convergence check agents complete |

### Stop Hooks

| Hook ID                     | Script / Command                | Purpose                                                          |
| --------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| `workflow-stop-enforcement` | `workflow-stop-enforcement.mjs` | Block session completion when mandatory dispatches are missing   |
| `session-log`               | inline `echo` command           | Logs session end time to `.claude/context/session.log`           |
| `session-state-finalize`    | inline `node -e` command        | Mark session.json as interrupted if not completed gracefully     |
| `journal-promotion-check`   | `journal-promotion-check.mjs`   | Suggest journal entries for memory-bank promotion at session end |

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

**Purpose**: Validate spec files against their JSON schema definitions, including E2E opt-out fields.

**Behavior**:

1. Reads the spec file and extracts frontmatter
2. Determines the spec type from the frontmatter
3. Validates frontmatter against the expected schema for that spec type
4. Validates `e2e_skip` as strict boolean type (rejects string `"true"`, integer `1`, etc.)
5. Validates `e2e_skip_rationale` as enum: `pure-refactor`, `test-infra`, `type-only`, `docs-only`
6. Reports schema violations (missing required fields, invalid values)

### spec-validate.mjs

**Purpose**: Validate spec markdown structure, required sections, E2E opt-out field consistency, and env-dependent AC coverage.

**Behavior**:

1. Parses the spec file as markdown
2. Checks for required sections based on spec type
3. Validates section formatting and content structure
4. When `e2e_skip: true`: validates that `e2e_skip_rationale` is present and contains a valid enum value (imports `VALID_E2E_SKIP_RATIONALES` from `workflow-dag.mjs`)
5. When `e2e_skip_rationale` is present but `e2e_skip` is false or absent: emits a warning (not rejection)
6. Reports structural issues (missing sections, malformed content)
7. Runs env-dependent AC enforcement check (advisory, never affects exit code):
   a. Extracts file paths from the spec's task list and evidence table (backtick-quoted paths and pipe-delimited table rows)
   b. Scans referenced files for env-access patterns (`process.env`, `NODE_ENV`, `import.meta.env`)
   c. If env-dependent code is found, scans the spec's Acceptance Criteria section for default/unset keywords (`unset`, `default`, `not set`, `absent`, `missing`, `clean environment`, `undefined`)
   d. If env-dependent code exists but no default-env AC is found, emits advisory: "Spec references env-dependent code but has no AC for default/unset environment"
   e. If referenced files do not yet exist (spec authored before implementation), the check is silently skipped

**Env-Dependent AC Enforcement Details**:

- Always advisory -- never blocks save or affects the exit code
- Runs after main validation to avoid polluting the error/warning counts
- Silently catches all errors in the env check path (missing files, unreadable files, extraction failures)
- Resolves file paths relative to both `cwd` and the spec's directory

### import-graph-check.mjs

**Purpose**: Trace static imports from entry point(s) and check whether specified files are reachable through the import chain. Also supports wiring-task detection mode for specs.

**Location**: `.claude/scripts/import-graph-check.mjs`

**Not a hook** -- this script is invoked directly by the completion verifier (Gate 7) and can be run manually from the command line. It is registered in `metaclaude-registry.json` for sync to consumer projects.

**Modes**:

#### Standard Mode (boot-path reachability)

```bash
node .claude/scripts/import-graph-check.mjs --entry <path> [--entry <path2>] --check <file1> <file2> ...
```

Traces the static import graph from entry point(s) and classifies each `--check` file as reachable or unreachable.

**Output** (JSON to stdout):

```json
{
  "reachable": ["src/services/auth.ts"],
  "unreachable": ["src/resolvers/context.ts"],
  "warnings": ["Circular import detected: src/a.ts -> src/b.ts -> src/a.ts"]
}
```

#### Wiring-Task Detection Mode

```bash
node .claude/scripts/import-graph-check.mjs --spec <spec-path>
```

Parses the spec's task list and evidence table for file paths, scans those files for initialization method definitions, and checks whether the spec includes a wiring task.

**Output** (JSON to stdout):

```json
{
  "init_methods_found": [
    {
      "file": "src/engine/context-pipeline.ts",
      "methods": ["init()", "setResolverRegistry()"]
    }
  ],
  "wiring_task_found": false,
  "advisory": "Spec creates files with init/register methods but no wiring task references the entry point",
  "warnings": []
}
```

**Key Behaviors**:

- **Exit code**: Always 0 (advisory, never blocking)
- **tsconfig path resolution**: Reads `tsconfig.json` `compilerOptions.paths` with `baseUrl` support. Falls back to Node.js resolution when tsconfig is missing or has no paths
- **Barrel re-exports**: Resolves directory imports to `index.ts`/`index.js`
- **Extension resolution**: Tries `.ts`, `.tsx`, `.js`, `.jsx`, `/index.ts`, `/index.js` in order
- **Non-JS imports**: CSS, JSON, images, fonts treated as leaf nodes (not traversed)
- **node_modules imports**: Treated as leaf nodes (not traversed)
- **Dynamic imports**: `import()` expressions flagged as warnings ("dynamic import boundary") and not traversed
- **Circular imports**: Detected and reported as warnings; graph traversal continues past circular references
- **Path validation**: All input paths validated against project root before traversal; paths outside the project boundary are rejected
- **Symlink handling**: Uses `realpathSync` to normalize paths, handles macOS `/var` to `/private/var` resolution

**Init Method Detection** (wiring-task mode):

- Matches `init()`, `initialize()`, `configure()`, `setup()`, `register()` unconditionally
- Matches `set*()` only when the name suggests subsystem wiring (contains keywords like Pipeline, Registry, Logger, Config, Provider, Factory, Handler, Manager, Service, Client, Connection, Store, Cache, Queue, Router, Resolver)
- Excludes simple property setters like `setWidth()`, `setColor()`

**Wiring Task Detection** (wiring-task mode):

- Scans the spec's Task List section for keywords: `wire`, `wiring`, `register`, `connect`, `bootstrap`, `entry point`, `index.ts`, `index.js`, `main.ts`, `main.js`

**Integration**: The completion verifier's Gate 7 invokes this script in both modes. See the [completion-verifier agent definition](../.claude/agents/completion-verifier.md) for the full Gate 7 specification.

**See Also**: [Trace System](TRACES.md) -- when trace data is fresh, the completion verifier uses trace `imports` arrays for reachability checks instead of invoking this script

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
2. Maps agent type to convergence gate field (e.g., `implementer` -> `all_acs_implemented`)
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

### convergence-pass-recorder.mjs

**Purpose**: Automatically record pass evidence when convergence check agents complete. Provides the trust anchor for evidence-based convergence counting.

**Hook Type**: SubagentStop (fires after agent completion)

**Behavior**:

1. Reads SubagentStop event data from stdin (JSON with `agent_type` and `agent_output` fields)
2. Checks agent type against the convergence agent allowlist (see Gate Mapping below)
3. If agent is not on the allowlist: exits 0 with empty JSON `{}` (no recording)
4. Parses `agent_output` to extract findings metadata (`findings_count`, `findings_ids`, `clean`)
5. Computes canonical findings hash from finding IDs (sorted, SHA-256)
6. Invokes `session-checkpoint.mjs record-pass` with extracted metadata and `--source hook`
7. On extraction failure: records with null findings and `manual_fallback` source (never blocks)
8. On any error: fail-open (exit 0, empty JSON)

**Gate Mapping** (agent type to gate name):

| Agent Type               | Gate Name             |
| ------------------------ | --------------------- |
| `interface-investigator` | `investigation`       |
| `challenger`             | `challenger`          |
| `code-reviewer`          | `code_review`         |
| `security-reviewer`      | `security_review`     |
| `unifier`                | `unifier`             |
| `completion-verifier`    | `completion_verifier` |

**Ordering**: This hook is registered in `settings.json` AFTER `convergence-gate-reminder`, ensuring both hooks receive the original agent output independently (no chained/modified copies).

**Exit Codes**:

- `0`: Always (fail-open on all errors)

### workflow-gate-enforcement.mjs

**Purpose**: Coercively block dispatch of enforced subagent types when workflow prerequisites are not met. Includes optional evidence integrity verification for convergence gates.

**Hook Type**: PreToolUse (runs before Agent tool dispatch)

**Matcher**: `Agent`

**Behavior**:

1. Reads stdin JSON for `session_id` and `tool_input.subagent_type`
2. Checks kill switch (`gate-enforcement-disabled`) -- exits 0 if present
3. Reads `session.json` for workflow type and dispatch history
4. If exempt workflow (oneoff-vibe, refactor, journal-only): exits 0
5. If non-enforced subagent type: exits 0
6. Looks up prerequisites from enforcement table
7. Checks dispatch history and convergence state against prerequisites
8. For convergence-type prerequisites: checks `clean_pass_count` from `session.convergence`
9. If `convergence_evidence` arrays are present: runs optional evidence integrity verification (advisory warnings only, never blocks)
10. If `convergence_evidence` arrays are absent: falls back to trust-based `clean_pass_count` (legacy compatibility)
11. If prerequisites met: exits 0
12. If not met: checks `gate-override.json` for human override
13. If override found: exits 0
14. If no override: outputs BLOCKED message to stderr and exits 2

**Enforcement Table**:

| Blocked Subagent      | Prerequisites                                                                     |
| --------------------- | --------------------------------------------------------------------------------- |
| `implementer`         | `interface-investigator` + `challenger` (pre-implementation or pre-orchestration) |
| `test-writer`         | `implementer` dispatched                                                          |
| `code-reviewer`       | `challenger` (pre-review) + `unifier` dispatched                                  |
| `security-reviewer`   | `convergence.code_review.clean_pass_count >= 2`                                   |
| `documenter`          | `convergence.security_review.clean_pass_count >= 2`                               |
| `completion-verifier` | `documenter` dispatched                                                           |

**Evidence Integrity Verification** (defense-in-depth, advisory only):

When convergence evidence arrays are present, the hook verifies:

- Sequential `pass_number` values with no gaps
- Sequential timestamps (no time-travel)
- Array length matches highest `pass_number`
- Timing plausibility (minimum 10 seconds between passes; faster passes flagged as suspicious)

All integrity issues produce advisory warnings to stderr. The hook never blocks dispatch based on evidence integrity alone -- it falls back to count-only verification.

**Skill Map**: Maps gate names to recommended skill commands for the help message shown when dispatch is blocked. Contains entries for all 6 convergence gates: `investigation`, `challenger`, `code_review`, `security_review`, `unifier`, `completion_verifier`.

**Fail-Open**: Missing session.json, malformed JSON, missing `active_work` -- all exit 0.
**Fail-Closed Exception**: Missing convergence fields default to 0 (blocks downstream dispatch).

**Exit Codes**:

- `0`: Allow dispatch
- `2`: Block dispatch (stderr message with missing prerequisites and override instructions)

### workflow-file-protection.mjs

**Purpose**: Block agent writes to enforcement files and session state. Only human terminal writes (or trusted CLI scripts) are permitted.

**Hook Type**: PreToolUse (runs before Write tool)

**Matcher**: `Write`

**Protected Files**:

- `.claude/coordination/gate-override.json`
- `.claude/coordination/gate-enforcement-disabled`
- `.claude/context/session.json`

The `session.json` write protection ensures all session state modifications go through `session-checkpoint.mjs` as the sole trusted writer. Agents must use CLI subcommands (`record-pass`, `update-convergence`, `transition-phase`, etc.) instead of direct file writes.

**Key Property**: This hook does NOT check the kill switch. Write protection remains active even when `gate-enforcement-disabled` exists, preventing agents from self-bypassing enforcement.

**Exit Codes**:

- `0`: Allow write (not a protected file)
- `2`: Block write (protected enforcement file)

### workflow-stop-enforcement.mjs

**Purpose**: Block session completion when mandatory dispatches have not occurred, manifest status obligations are unsatisfied, or deployment verification is incomplete for spec-based workflows.

**Hook Type**: Stop (runs on session completion)

**Mandatory Dispatches**: `code-reviewer`, `security-reviewer`, `completion-verifier`, `documenter`, `e2e-test-writer` (any status satisfies -- presence check only). The `e2e-test-writer` dispatch is exempt when the spec opts out via `e2e_skip: true` with a valid rationale.

**Behavior**:

1. Checks kill switch -- exits 0 if present
2. Reads `session.json` for workflow type and dispatch history
3. Checks `stop-hook-active` sentinel -- exits 0 if present (re-entry prevention)
4. If exempt workflow: exits 0
5. Checks phase-aware mandatory dispatch records in `subagent_tasks`
6. If `e2e-test-writer` is missing from dispatch records, checks spec frontmatter for opt-out (see [E2E Opt-Out Enforcement](#e2e-opt-out-enforcement) below)
7. If `currentPhase === 'complete'`: checks manifest status obligations (see [Status Obligation Enforcement](#status-obligation-enforcement) below). For all other phases (active or unrecognized), obligation validation is skipped entirely.
8. Evaluates deployment verification gate (see [Deployment Verification Gate](#deployment-verification-gate) below): reads `session.deployment` object and blocks if deployment detected without passing post-deploy verification
9. If all dispatch, obligation, and deployment checks pass: exits 0
10. If dispatch violations: checks `gate-override.json` for stop-gate override
11. If obligation violations: checks for phase-scoped override (`status_obligations:<phase>`)
12. Builds combined block message distinguishing "Missing mandatory dispatches", "Manifest status inconsistency", and "Deployment detected without post-deploy verification"
13. Creates `stop-hook-active` sentinel, then outputs `{"decision": "block", "reason": "..."}` via stdout

**Active-Phase Guard**: Obligation validation in the stop hook only runs when `currentPhase === 'complete'`. During active phases (`implementing`, `reviewing`, `documenting`, etc.), the entire obligation validation block is skipped -- including the `specGroupId` lookup, SEC-001 format validation, and `validateObligations()` call. This prevents false blocks during normal workflow execution. Phase transition obligation enforcement is handled by `session-checkpoint.mjs` instead. Unrecognized phase strings are treated as non-complete (fail-open).

**Obligation Enforcement Level**: When obligation validation runs (i.e., `currentPhase === 'complete'`), the stop hook reads `enforcement_level` from `session.phase_checkpoint`. At `warn-only`, obligation violations are logged to stderr but do not block. At `graduated`, obligation violations contribute to the block decision. At `off`, obligation validation is skipped.

**Blocking Mechanism**: stdout JSON `{"decision": "block", "reason": "..."}` -- NOT stderr + exit 2.

**Re-Entry Prevention**: Creates `.claude/coordination/stop-hook-active` sentinel BEFORE blocking. On next fire, if sentinel exists, exits 0 and deletes sentinel.

**Exit Codes**:

- `0`: Always (blocking is via stdout JSON)

#### E2E Opt-Out Enforcement

The stop hook enforces `e2e-test-writer` as a mandatory dispatch for all spec-based workflows (oneoff-spec, orchestrator), with a spec-level opt-out mechanism.

**Data-Flow Path** (oneoff-spec):

```
session.json -> active_work.spec_group_id
  -> .claude/specs/groups/<sg-id>/spec.md (convention-based path)
  -> parse YAML frontmatter
  -> read e2e_skip (boolean) and e2e_skip_rationale (enum)
```

**Data-Flow Path** (orchestrator):

```
session.json -> active_work.spec_group_id
  -> glob .claude/specs/groups/<sg-id>/atomic/*.md
  -> parse each spec's YAML frontmatter individually
  -> per-spec enforcement (mixed opt-out states supported)
```

**Opt-Out Conditions** (all must be true):

1. `e2e_skip` is strict boolean `true` (`typeof e2e_skip === 'boolean'`)
2. `e2e_skip_rationale` is one of: `pure-refactor`, `test-infra`, `type-only`, `docs-only`
3. Rationale validation uses the shared `VALID_E2E_SKIP_RATIONALES` constant from `workflow-dag.mjs`

**Defense in Depth**: The stop hook independently re-validates the rationale enum. It does not trust upstream validation from spec validation hooks.

**Per-Spec Orchestrator Enforcement**: In orchestrator workflows with multiple atomic specs, each spec is checked individually. Non-opted-out specs require a dispatch record. Opted-out specs require a structured opt-out record (`{ type: "e2e_opt_out", spec_id, e2e_skip: true, rationale, timestamp }`).

**Error Behavior**:

| Scenario                                 | Behavior                            |
| ---------------------------------------- | ----------------------------------- |
| `session.json` missing or malformed      | Fail-open (exit 0)                  |
| Spec file not found or unreadable        | Fail-open (structural error)        |
| Spec exists, `e2e_skip` missing          | Fail-closed (e2e dispatch required) |
| Spec exists, `e2e_skip` non-boolean type | Fail-closed (e2e dispatch required) |
| `e2e_skip: true` with invalid rationale  | Block session (invalid opt-out)     |
| Orchestrator glob returns empty          | Fail-open (structural error)        |

**Escape Hatches**: The `gate-override.json` override and the `gate-enforcement-disabled` kill switch bypass e2e enforcement, consistent with all other mandatory dispatch gates.

**Shared Constants** (exported from `workflow-dag.mjs`):

- `STOP_MANDATORY_DISPATCHES`: 5-element array including `e2e-test-writer`
- `STOP_PHASE_REQUIREMENTS`: `e2e-test-writer` appears in all four phase arrays (`reviewing`, `completion_verifying`, `documenting`, `complete`)
- `VALID_E2E_SKIP_RATIONALES`: `['pure-refactor', 'test-infra', 'type-only', 'docs-only']`

#### Deployment Verification Gate

The stop hook enforces post-deploy verification when a deployment has been recorded in the session (Step 7.8 in the hook's execution flow). This gate is independent of mandatory dispatch checks and obligation checks.

**Data-Flow Path**:

```
session.json -> deployment object
  -> check deployment.detected (boolean)
  -> check deployment.failed (boolean, absolute precedence)
  -> check deployment.verify_deploy_passed (boolean)
```

**Decision Logic**:

| `deployment.detected` | `deployment.failed` | `deployment.verify_deploy_passed` | Result                                       |
| --------------------- | ------------------- | --------------------------------- | -------------------------------------------- |
| `true`                | `true`              | (any)                             | Gate passes (no artifact to verify)          |
| `true`                | `false`/absent      | `true`                            | Gate passes (verification complete)          |
| `true`                | `false`/absent      | `false`/absent                    | Gate BLOCKS (unverified deployment)          |
| `false`/absent        | (any)               | (any)                             | Gate passes (no deployment detected)         |
| absent entirely       | -                   | -                                 | Gate passes (no deployment field in session) |

**What is NOT enforced**: `deployment.verify_build_passed` is advisory only. The stop hook does not check or block on build verification status.

**Block Message**: "Deployment detected without post-deploy verification. Run smoke test before completing session."

**Remediation Guidance** (shown when blocked):

```
Run post-deploy verification:
  - Execute: npm run verify:deploy <endpoint-url>
  - Or use HTTP GET fallback with endpoint URL
  - Or call: node .claude/scripts/session-checkpoint.mjs record-deployment-failure (if deployment failed)
```

**Error Behavior (Fail-Open)**:

| Scenario                                         | Behavior                                     |
| ------------------------------------------------ | -------------------------------------------- |
| `deployment` field absent from session.json      | Gate passes (no deployment detected)         |
| `deployment` is not an object (e.g., string/int) | Fail-open with warning to stderr             |
| `deployment.detected` is non-boolean type        | Fail-open with warning to stderr             |
| `deployment.failed` is non-boolean type          | Fail-open with warning to stderr             |
| `deployment.verify_deploy_passed` is non-boolean | Fail-open with warning to stderr             |
| Any structural error in deployment gate logic    | Fail-open with warning (caught by try/catch) |
| `deployment.detected` is `undefined`             | Treated as `false` (no deployment detected)  |

Each field is validated independently. A malformed `detected` field does not short-circuit validation of `failed` or `verify_deploy_passed`.

**Recording Deployment State** (via `session-checkpoint.mjs`):

```bash
# Record a pipeline deployment
node .claude/scripts/session-checkpoint.mjs record-deployment --target staging --method pipeline

# Record a manual deployment
node .claude/scripts/session-checkpoint.mjs record-deployment --target production --manual

# Record deployment failure (clears verification requirement)
node .claude/scripts/session-checkpoint.mjs record-deployment-failure
```

**Target Validation**: Alphanumeric plus `.`, `-`, `/`, `:` only, max 256 characters.

**Method Validation**: Must be `"pipeline"` or `"manual"`. The `--manual` flag is shorthand for `--method manual`.

**Overwrite Behavior**: Calling `record-deployment` again overwrites the entire prior deployment object (clean slate -- no stale verification state carries forward).

**See Also**: [Deployment Verification Contracts](deployment-verification-contracts.md) for consumer contract interfaces (`verify:build`, `verify:deploy`) and the HTTP GET fallback behavior.

### journal-promotion-check.mjs

**Purpose**: Suggest promotion of frequently-tagged journal entries to memory-bank.

**Behavior**:

1. Scans `.claude/journal/entries/` for markdown files
2. Parses frontmatter tags and type fields
3. Suggests promotion when a tag or type appears 3+ times
4. Runs at session end, informational only (always exits 0)

### trace-read-enforcement.mjs

**Purpose**: Block edits to files in traced modules unless the agent has read that module's trace first.

**Hook Type**: PreToolUse (runs before Edit/Write)

**Matcher**: `Edit|Write`

**Behavior**:

1. Reads stdin JSON to get the target file path
2. Loads `trace.config.json` to determine which module the file belongs to
3. Checks `coordination/trace-reads.json` for whether the module's trace has been read
4. If module is traced and trace has NOT been read: exits 2 (blocks the edit with instructions to read the trace first)
5. If module is traced and trace HAS been read: exits 0 (allows the edit)
6. If file is not in any traced module: exits 0 (allows with advisory)

**Exit Codes**:

- `0`: Allow the edit (trace was read, or file is untraced)
- `2`: Block the edit (trace not read, provides instructions)

### trace-read-tracker.mjs

**Purpose**: Record which trace files the agent has read during the current session.

**Hook Type**: PostToolUse (runs after Read)

**Matcher**: `Read`

**Behavior**:

1. Reads stdin JSON to get the file path that was just read
2. If the file is a trace file (under `.claude/traces/`), determines which module(s) it covers
3. Updates `.claude/coordination/trace-reads.json` with the read timestamp
4. High-level trace reads mark ALL modules as read; low-level trace reads mark only that module
5. Always exits 0 (never blocks reads)

**Exit Codes**:

- `0`: Always (informational only, never blocks)

**Session State**: Updates `.claude/coordination/trace-reads.json` (ephemeral, not committed to git)

### trace-commit-staleness.mjs

**Purpose**: Block commits when staged files belong to modules with stale traces.

**Hook Type**: PostToolUse (runs after Bash)

**Matcher**: `Bash`

**Behavior**:

1. Only activates when the Bash command contains `git commit`
2. Checks which files are staged for commit
3. For each staged file, determines its module from `trace.config.json`
4. Checks if the module's trace is stale (source files modified after last trace generation)
5. If any staged module has stale traces: exits 2 (blocks with regeneration instructions)
6. If all traces are current: exits 0 (allows the commit)

**Exit Codes**:

- `0`: Allow the commit (all traces current, or no traced modules affected)
- `2`: Block the commit (stale traces detected, provides `trace-generate` instructions)

---

## Status Obligation Enforcement

Status obligation enforcement validates that manifest status fields have the expected values when leaving a workflow phase. It catches manifest drift -- where the manifest stops reflecting actual work completion -- at two enforcement points: phase transitions (`session-checkpoint.mjs`) and session completion (`workflow-stop-enforcement.mjs`, `complete` phase only).

### How It Works

A static `PHASE_OBLIGATIONS` mapping (exported from `workflow-dag.mjs`) defines which manifest fields must have which values when exiting each phase. The `validateObligations(phase, manifest)` function checks these fields using strict equality (`===`) and returns any violations.

`session-checkpoint.mjs` calls `validateObligations` at phase transitions (the primary enforcement point). `workflow-stop-enforcement.mjs` calls `validateObligations` only when `currentPhase === 'complete'` -- during active phases, obligation validation is skipped entirely to avoid false blocks (see [Active-Phase Guard](#workflow-stop-enforcementmjs) above).

### Phase-to-Obligation Mapping

| Phase (on exit)        | Manifest Field                               | Expected Value     |
| ---------------------- | -------------------------------------------- | ------------------ |
| `spec_authoring`       | `review_state`                               | `"DRAFT"`          |
| `spec_authoring`       | `convergence.spec_complete`                  | `true`             |
| `investigating`        | `convergence.investigation_converged`        | `true`             |
| `challenging`          | `convergence.challenger_converged`           | `true`             |
| `implementing`         | `work_state`                                 | `"IMPLEMENTING"`   |
| `implementing`         | `convergence.all_acs_implemented`            | `true`             |
| `testing`              | `convergence.all_tests_passing`              | `true`             |
| `verifying`            | `convergence.unifier_passed`                 | `true`             |
| `verifying`            | `work_state`                                 | `"VERIFYING"`      |
| `reviewing`            | `convergence.code_review_passed`             | `true`             |
| `reviewing`            | `convergence.security_review_passed`         | `true`             |
| `completion_verifying` | `convergence.completion_verification_passed` | `true`             |
| `documenting`          | `convergence.docs_generated`                 | `true`             |
| `documenting`          | `work_state`                                 | `"READY_TO_MERGE"` |

13 obligations across 8 phases. Phases not listed (e.g., `challenging`, `prd_gathering`) have no obligations and always pass validation.

### Enforcement Points

**Phase transitions** (`session-checkpoint.mjs transition-phase`): Checks obligations for the outgoing phase (the phase being left) after DAG predecessor validation and before the phase is updated. At `graduated` enforcement, violations block immediately with no grace period. At `warn-only`, violations emit warnings but allow the transition. This is the primary obligation enforcement point.

**Session completion** (`workflow-stop-enforcement.mjs`): Checks obligations only when `currentPhase === 'complete'`. During active phases (`implementing`, `reviewing`, `documenting`, etc.), obligation validation is skipped entirely to prevent false blocks -- `session-checkpoint.mjs` handles enforcement at phase transitions instead. When obligation validation does run, phases previously skipped via `override-skip` are excluded. The block message clearly separates "Missing mandatory dispatches" from "Manifest status inconsistency" with specific field names and expected values.

### Enforcement Levels

Obligation enforcement follows the same enforcement level as other workflow enforcement:

- **off**: No obligation validation occurs
- **warn-only**: Violations emit warnings but do not block; `obligation_violation` events recorded with `resolution: "warned"`
- **graduated**: Violations block the transition or session completion; events recorded with `resolution: "blocked"`

### Override Mechanism

Phase-scoped overrides use the gate name pattern `status_obligations:<phase>` in `gate-override.json`:

```json
{
  "gate": "status_obligations:implementing",
  "session_id": "<spec_group_id>",
  "timestamp": "2026-03-20T12:00:00Z",
  "rationale": "all_acs_implemented not applicable: infrastructure-only spec"
}
```

A blanket `status_obligations` gate name (without phase suffix) is not supported. Each phase must be overridden individually.

### Kill Switch

The existing kill switch (`.claude/coordination/gate-enforcement-disabled`) disables obligation enforcement alongside all other enforcement.

### Fail-Open Behavior

- **Missing manifest file**: Obligation check skipped with warning
- **Malformed manifest JSON**: Obligation check skipped with warning
- **Missing spec_group_id**: Obligation check skipped silently
- **Missing manifest fields**: Treated as `null` (semantic violation, not structural error)
- **Non-complete active phase**: Obligation check skipped silently (stop hook only)
- **Unrecognized phase string**: Treated as non-complete, obligation check skipped (stop hook only)

### Audit Trail

Obligation violations are recorded in `session.json` history as `obligation_violation` events:

```json
{
  "event_type": "obligation_violation",
  "timestamp": "<ISO 8601>",
  "details": {
    "phase": "implementing",
    "field": "convergence.all_acs_implemented",
    "expected_value": true,
    "actual_value": false,
    "resolution": "blocked"
  }
}
```

Resolution values: `blocked` (graduated enforcement blocked), `warned` (warn-only allowed with warning), `overridden` (phase-scoped override applied), `updated` (agent corrected the manifest and re-attempted successfully).

These events are written exclusively by the enforcement scripts, not by agents.

### Baseline Audit

The `obligation-baseline-audit.mjs` script audits recent spec group manifests against the obligation mapping to measure the baseline drift rate:

```bash
node .claude/scripts/obligation-baseline-audit.mjs [--limit N]
```

Outputs a field-level drift report to stderr and a machine-readable JSON summary to stdout.

### Workflow Scoping

Obligation enforcement applies only to spec-based workflows (`oneoff-spec`, `orchestrator`). Exempt workflows (`oneoff-vibe`, `refactor`, `journal-only`) skip obligation validation entirely.

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

- [Workflow Enforcement Architecture](WORKFLOW-ENFORCEMENT.md) - DAG enforcement, operator overrides, completion checklist, evidence-based convergence
- [Trace System](TRACES.md) - Trace generation, staleness, and the import-graph-check.mjs fallback for boot-path reachability
- [Completion Verifier Agent](../agents/completion-verifier.md) - Gate 7 (boot-path reachability) uses import-graph-check.mjs as trace fallback and wiring-task detector
- [Deployment Verification Contracts](deployment-verification-contracts.md) - Consumer contract interfaces (verify:build, verify:deploy), HTTP GET fallback, session state schema, CLI commands

# Workflow Enforcement Architecture

This document describes the programmatic enforcement of mandatory workflow stages. The system operates in two layers: a **cooperative layer** (DAG-based phase transitions with configurable enforcement levels) and a **coercive layer** (PreToolUse/Stop hooks that physically block tool execution). Together they reduce the mandatory gate skip rate from ~60% to 0%.

---

## Purpose

Agents under throughput pressure skip mandatory stages (challenger dispatches, completion verification, documentation). During a 5-workstream orchestration session, 3 of 4 mandatory challenge stages were skipped and documentation was skipped entirely. The cooperative layer addresses this with warnings and graduated blocking on phase transitions. The coercive layer closes the remaining gap by physically preventing tool execution when prerequisites are unmet, with no cooperative participation required.

---

## Components

| Component                              | File                                            | Role                                                          |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Shared DAG module                      | `.claude/scripts/lib/workflow-dag.mjs`          | Single source of truth for predecessor graphs and enforcement |
| Hook utilities                         | `.claude/scripts/lib/hook-utils.mjs`            | Shared I/O (loadSession, loadOverrides, findClaudeDir, etc.)  |
| Session lockfile                       | `.claude/scripts/lib/session-lock.mjs`          | Mutex-style locking for concurrent session.json writes        |
| Findings hash                          | `.claude/scripts/lib/findings-hash.mjs`         | Canonical SHA-256 hash computation for finding IDs            |
| Phase transition enforcement           | `.claude/scripts/session-checkpoint.mjs`        | Cooperative DAG validation on `transition-phase` calls        |
| PreToolUse gate enforcement            | `.claude/scripts/workflow-gate-enforcement.mjs` | Coercive blocking of subagent dispatch                        |
| PreToolUse write protection            | `.claude/scripts/workflow-file-protection.mjs`  | Coercive blocking of agent writes to enforcement files        |
| Stop enforcement                       | `.claude/scripts/workflow-stop-enforcement.mjs` | Coercive blocking of session completion                       |
| SubagentStop convergence reminder      | `.claude/scripts/convergence-gate-reminder.mjs` | Advisory reminder to update convergence gates                 |
| SubagentStop convergence pass recorder | `.claude/scripts/convergence-pass-recorder.mjs` | Automated pass evidence recording for convergence gates       |
| Session schema                         | `.claude/specs/schema/session.schema.json`      | Schema validation for enforcement fields                      |
| Session schema validator               | `.claude/scripts/session-validate.mjs`          | Runtime schema enforcement via PostToolUse hook               |

---

## Shared DAG Module

The `workflow-dag.mjs` module is the single source of truth for workflow DAG definitions, consumed by both the cooperative layer (`session-checkpoint.mjs`) and the coercive layer (enforcement hooks).

### Exports

**Constants**: `ORCHESTRATOR_PREDECESSORS` (14 entries), `ONEOFF_SPEC_PREDECESSORS` (12 entries), `EXEMPT_WORKFLOWS`, `VALID_SUBAGENT_TYPES` (20 entries), `MANDATORY_DISPATCHES`, `REQUIRED_CHALLENGER_STAGES`, `ENFORCED_SUBAGENT_TYPES` (6 entries), `STOP_MANDATORY_DISPATCHES` (4 entries), `OVERRIDE_GATE_NAMES`, `REQUIRED_CLEAN_PASSES`, `VALID_CONVERGENCE_GATES` (6 entries: `code_review`, `security_review`, `investigation`, `challenger`, `unifier`, `completion_verifier`).

**Query Functions**: `getWorkflowType(session)` (backward-compatible, defaults to orchestrator), `getWorkflowTypeStrict(session)` (returns null if missing, for fail-open), `isExemptWorkflow(workflow)`, `getPredecessorGraph(workflow)`, `wasPredecessorVisited(predecessorKey, session)`, `getAllTasks(session)`, `getPrerequisites(workflow, subagentType)`, `werePrerequisitesMet(session, prerequisites)`.

---

## Phase Transition DAG

Phase transitions are validated against a directed acyclic graph (DAG) of mandatory predecessors. Each phase declares which phases (or parameterized challenger stages) must be visited before entry is allowed.

### Orchestrator Workflow

```
prd_gathering -> spec_authoring -> atomizing -> enforcing -> investigating
  -> awaiting_approval -> challenging:pre-orchestration -> implementing
  -> challenging:pre-test -> testing -> verifying
  -> challenging:pre-review -> reviewing -> completion_verifying -> documenting
```

### Oneoff-Spec Workflow

```
prd_gathering -> spec_authoring -> investigating -> awaiting_approval
  -> challenging:pre-implementation -> implementing
  -> challenging:pre-test -> testing -> verifying
  -> challenging:pre-review -> reviewing -> completion_verifying -> documenting
```

### Exempt Workflows

`oneoff-vibe`, `refactor`, and `journal-only` workflows skip all enforcement. All transitions are allowed unconditionally.

### Parameterized Predecessors

Entries like `challenging:pre-test` are not literal phase names. They are checked by looking for a `challenger` subagent dispatch with `stage: "pre-test"` in the session's dispatch history. This decouples challenge verification from the phase enum.

---

## Cooperative Layer

### Enforcement Levels

The enforcement level controls how strictly skipped predecessors are handled. Set via `set-enforcement-level`.

| Level       | First Skip Behavior    | Repeated Skip Behavior | Completion Checklist       |
| ----------- | ---------------------- | ---------------------- | -------------------------- |
| `graduated` | Warn, allow transition | Block transition       | Full (missing items shown) |
| `warn-only` | Warn, allow transition | Warn, allow transition | Full (missing items shown) |
| `off`       | No check               | No check               | Informational only         |

Default enforcement level is `graduated`. The level persists in `session.json` at `phase_checkpoint.enforcement_level`.

### Graduated Enforcement Behavior

On first attempt to skip a mandatory predecessor, the system emits a warning and allows the transition. On a second attempt to skip the same predecessor, the transition is blocked with exit code 1. The agent must then either:

1. Complete the skipped phase
2. Use `override-skip` to bypass (with rationale)
3. Use `reset-enforcement` to clear all skip counters

### Operator Commands

All enforcement operations are invoked through `session-checkpoint.mjs`. Override operations (`override-skip`, `reset-enforcement`) are restricted to the main agent (no subagents in-flight). `set-enforcement-level` is also main-agent-only but does not count toward the override cap.

#### override-skip

Clears the skip counter for a specific phase, allowing a blocked transition to proceed.

```bash
node .claude/scripts/session-checkpoint.mjs override-skip \
  --phase "challenging:pre-test" \
  --rationale "Tests already validated manually"
```

- Requires `--phase` and `--rationale` flags
- Counts toward the per-session override cap (3 total, shared with `reset-enforcement`)
- Recorded in session history as `override_skip` event
- Appears as `[OVERRIDE]` in the completion checklist

#### reset-enforcement

Clears all accumulated skip counters, resetting enforcement to its initial state.

```bash
node .claude/scripts/session-checkpoint.mjs reset-enforcement \
  --rationale "Resuming from interrupted session with stale counters"
```

- Requires `--rationale` flag
- Counts toward the per-session override cap (3 total, shared with `override-skip`)
- Recorded in session history as `reset_enforcement` event

#### set-enforcement-level

Changes the enforcement level for the current session.

```bash
node .claude/scripts/session-checkpoint.mjs set-enforcement-level warn-only
```

- Valid values: `off`, `warn-only`, `graduated`
- Does NOT count toward the override cap
- Does NOT reset skip counters (accumulated warnings persist)
- Recorded in session history as `enforcement_level_change` event

#### Override Cap

A maximum of 3 overrides per session is enforced (shared between `override-skip` and `reset-enforcement`). After 3 overrides, both commands exit with code 1 and the message instructs the agent to escalate to the human.

### Integrity Protection

The enforcement counter uses a XOR-based checksum (`_counter_checksum` field in session.json) to detect out-of-band edits to the counter value. If the checksum does not match:

1. A warning is emitted to stderr
2. Enforcement degrades to `warn-only` mode
3. The checksum is re-synced to the current counter value

This prevents agents from manually editing `session.json` to reset enforcement counters without using the audited `reset-enforcement` command.

### Completion Checklist

When `complete-work` is called on a non-exempt workflow, a completion checklist is generated and printed to stderr. The checklist verifies that all mandatory dispatches occurred during the session.

#### Checked Items

For each workflow type, the checklist verifies:

- **Challenger dispatches**: One per required stage (workflow-specific)
- **Code reviewer**: At least one `code-reviewer` dispatch
- **Security reviewer**: At least one `security-reviewer` dispatch
- **Completion verifier**: At least one `completion-verifier` dispatch
- **Documenter**: At least one `documenter` dispatch

#### Status Values

| Status          | Symbol       | Meaning                                       |
| --------------- | ------------ | --------------------------------------------- |
| `completed`     | `[x]`        | Dispatch found in session history             |
| `missing`       | `[ ]`        | No dispatch found (graduated/warn-only modes) |
| `overridden`    | `[OVERRIDE]` | Phase was overridden via `override-skip`      |
| `informational` | `[i]`        | Not dispatched, but enforcement is `off`      |

The checklist is advisory -- it does not block `complete-work`. It is recorded in session history as a `completion_checklist` event with full item details, enforcement level, override count, and enforcement counter values. This provides a permanent audit trail.

---

## Coercive Layer

The coercive layer operates via Claude Code hooks (PreToolUse and Stop) that physically block tool execution. Unlike the cooperative layer, no agent participation is required -- the hooks read session.json dispatch history as the source of truth.

### PreToolUse Gate Enforcement

**Hook**: `workflow-gate-enforcement.mjs` (PreToolUse, matcher: `Agent`)

Blocks dispatch of enforced subagent types when workflow prerequisites are not recorded in session.json.

#### Enforcement Table

| Blocked Subagent      | Prerequisites                                                                     |
| --------------------- | --------------------------------------------------------------------------------- |
| `implementer`         | `interface-investigator` + `challenger` (pre-implementation or pre-orchestration) |
| `test-writer`         | `implementer` dispatched                                                          |
| `code-reviewer`       | `challenger` (pre-review) + `unifier` dispatched                                  |
| `security-reviewer`   | `convergence.code_review.clean_pass_count >= 2`                                   |
| `documenter`          | `convergence.security_review.clean_pass_count >= 2`                               |
| `completion-verifier` | `documenter` dispatched                                                           |

Non-enforced subagent types (explore, spec-author, atomizer, etc.) pass through without prerequisite checks.

#### Blocking Mechanism

When prerequisites are not met, the hook writes a structured error to stderr and exits with code 2. The error message identifies:

- The blocked subagent type
- Missing prerequisites (dispatch or convergence)
- Override instructions (create `gate-override.json` with session-scoped entry)
- Current session ID

### PreToolUse Write Protection

**Hook**: `workflow-file-protection.mjs` (PreToolUse, matcher: `Write`)

Blocks agent writes to enforcement files and session state. Only human terminal writes (or trusted CLI scripts) are permitted.

**Protected Files**:

- `.claude/coordination/gate-override.json`
- `.claude/coordination/gate-enforcement-disabled`
- `.claude/context/session.json`

The `session.json` write protection ensures all session state modifications go through `session-checkpoint.mjs` as the sole trusted writer. Agents must use CLI subcommands (`record-pass`, `update-convergence`, `transition-phase`, etc.) instead of direct file writes.

**Key Property**: This hook does NOT check the kill switch. Write protection remains active even when `gate-enforcement-disabled` exists, preventing agents from self-bypassing enforcement.

### Stop Enforcement

**Hook**: `workflow-stop-enforcement.mjs` (Stop)

Blocks session completion when mandatory dispatches have not occurred for spec-based workflows.

**Mandatory Dispatches**: `code-reviewer`, `security-reviewer`, `completion-verifier`, `documenter` (any status satisfies -- presence check only).

**Blocking Mechanism**: stdout JSON `{"decision": "block", "reason": "..."}` -- NOT stderr + exit 2 (Stop hooks use a different protocol than PreToolUse hooks).

**Re-Entry Prevention**: Creates `.claude/coordination/stop-hook-active` sentinel BEFORE blocking. On next fire, if sentinel exists, exits 0 and deletes sentinel. This prevents infinite block loops.

### Kill Switch

Creating `.claude/coordination/gate-enforcement-disabled` (human terminal only) disables gate enforcement and stop enforcement. Write protection remains active.

The kill switch is checked FIRST in both gate enforcement and stop enforcement hooks, before any other logic. When active, the hook exits 0 immediately with a warning message to stderr.

### Human Override

Creating `.claude/coordination/gate-override.json` with session-scoped entries allows bypassing specific gates.

#### Override Format

```json
{
  "overrides": [
    {
      "gate": "investigation",
      "session_id": "<current-session-id>",
      "timestamp": "2026-03-18T12:00:00.000Z",
      "rationale": "Investigation completed in prior session"
    }
  ]
}
```

#### Valid Gate Names

| Gate Name                     | Blocks                    |
| ----------------------------- | ------------------------- |
| `investigation`               | `implementer`             |
| `challenge_pre_impl`          | `implementer` (oneoff)    |
| `challenge_pre_orchestration` | `implementer` (orch.)     |
| `implementer_dispatch`        | `test-writer`             |
| `challenge_pre_review`        | `code-reviewer`           |
| `unifier_dispatch`            | `code-reviewer`           |
| `code_review_convergence`     | `security-reviewer`       |
| `security_review_convergence` | `documenter`              |
| `documenter_dispatch`         | `completion-verifier`     |
| `stop_mandatory_dispatches`   | Session completion (Stop) |

Overrides are session-scoped (must match the current stdin-provided `session_id`). If multiple overrides match, the most recent by timestamp is used. Malformed override files are retried once (50ms delay), then fail-open for the override check.

### Fail-Open Policy

All structural errors result in fail-open (exit 0):

- Missing `session.json`
- Malformed JSON in `session.json`
- Missing `active_work` field
- Missing workflow type
- Script errors (top-level try/catch)
- Malformed stdin input

**Fail-Closed Exception**: Missing convergence fields (`convergence.code_review.clean_pass_count`, `convergence.security_review.clean_pass_count`) default to 0. This blocks downstream dispatch until convergence is explicitly recorded.

---

## Evidence-Based Convergence

The convergence loop protocol requires 2 consecutive clean passes before agents can advance past investigation, challenger, and other convergence gates. Previously, the `clean_pass_count` value was self-reported by agents. The evidence-based system replaces this with verifiable pass evidence records and derived counting.

### How It Works

1. A convergence check agent (e.g., `interface-investigator`) completes and returns findings
2. The `convergence-pass-recorder` SubagentStop hook fires, extracts findings metadata, and records structured pass evidence via `session-checkpoint.mjs record-pass`
3. The orchestrating agent calls `session-checkpoint.mjs update-convergence <gate_name>` (no count argument)
4. `update-convergence` reads the evidence array, counts consecutive clean hook-sourced passes from the tail, and sets `clean_pass_count` to the derived value
5. The gate enforcement hook reads `clean_pass_count` and optionally verifies evidence integrity

### Pass Evidence Records

Each convergence pass is recorded as a structured evidence record in `session.convergence_evidence.<gate>.passes[]`:

```json
{
  "pass_number": 1,
  "timestamp": "2026-04-02T14:30:00.000Z",
  "agent_type": "interface-investigator",
  "findings_count": 3,
  "findings_hash": "a1b2c3d4...",
  "clean": false,
  "record_source": "hook",
  "auto_decision_batch_id": "batch-001",
  "auto_decision_complete": true
}
```

Records are append-only. No command may modify or delete existing entries. Duplicate `pass_number` values are rejected.

### Trust-Tiered Recording

| Record Source       | Stored in Evidence | Counts for `clean_pass_count` | Purpose                 |
| ------------------- | ------------------ | ----------------------------- | ----------------------- |
| `"hook"`            | Yes                | Yes                           | Trusted, automated      |
| `"manual"`          | Yes                | No                            | Audit trail only        |
| `"manual_fallback"` | Yes                | No                            | Hook extraction failure |

Only hook-sourced clean passes count toward the coercive gate threshold. Manual passes provide an audit trail but do not unblock dispatch.

### CLI Commands

#### record-pass

Appends a pass evidence record to the convergence evidence array.

```bash
node .claude/scripts/session-checkpoint.mjs record-pass <gate_name> \
  --findings-count <N> \
  --findings-hash <hex-string> \
  --clean <true|false> \
  --agent-type <agent-type-string> \
  [--source <hook|manual>] \
  [--auto-decision-batch-id <batch-id>] \
  [--auto-decision-complete <true|false>]
```

**Arguments**:

| Argument                   | Required | Description                                            |
| -------------------------- | -------- | ------------------------------------------------------ |
| `gate_name`                | Yes      | One of `VALID_CONVERGENCE_GATES` (6 gates)             |
| `--findings-count`         | No       | Non-negative integer or `null`                         |
| `--findings-hash`          | No       | 64-character hex SHA-256 string or `null`              |
| `--clean`                  | Yes      | Boolean (`true` or `false`)                            |
| `--agent-type`             | Yes      | Convergence agent type string                          |
| `--source`                 | No       | `"hook"` (default), `"manual"`, or `"manual_fallback"` |
| `--auto-decision-batch-id` | No       | Links to auto-decision engine invocation               |
| `--auto-decision-complete` | No       | `false` marks the pass as dirty (incomplete batch)     |

**Exit codes**: `0` on success, `1` on validation error or duplicate `pass_number`.

#### update-convergence (modified API)

Derives `clean_pass_count` from the evidence array. No longer accepts a count argument.

```bash
node .claude/scripts/session-checkpoint.mjs update-convergence <gate_name>
```

**Behavior**:

- Reads `convergence_evidence.<gate>.passes[]`
- Counts consecutive clean passes with `record_source: "hook"` from the tail
- Sets `convergence.<gate>.clean_pass_count` to the derived value
- Emits a warning if >50% of passes are manual-sourced

**Breaking change**: Passing a numeric second argument (e.g., `update-convergence investigation 2`) is rejected with an error explaining the new evidence-based API.

### Canonical Findings Hash

Finding IDs are hashed deterministically: sort lexicographically, JSON.stringify the sorted array, then SHA-256 the UTF-8 encoding. This allows verification that two passes examined the same set of findings.

```javascript
import { computeFindingsHash } from '.claude/scripts/lib/findings-hash.mjs';

const hash = computeFindingsHash(['f-002', 'f-001', 'f-003']);
// SHA-256 of '["f-001","f-002","f-003"]'
```

### Session JSON Lockfile

All writes to `session.json` are serialized through a lockfile at `.claude/context/session.json.lock`.

**Lockfile format**:

```json
{
  "pid": 12345,
  "created_at": "2026-04-02T14:30:00.000Z"
}
```

**Acquisition behavior**:

| Scenario                       | Behavior                                               |
| ------------------------------ | ------------------------------------------------------ |
| Lock does not exist            | Create with PID + timestamp                            |
| Lock exists, age < 30 seconds  | Wait 100ms, retry once                                 |
| Lock exists, age >= 30 seconds | Force-acquire (stale lock), log warning with PID + age |
| Retry fails (hook context)     | Skip write (fail-open)                                 |
| Retry fails (CLI context)      | Abort with error (fail-closed)                         |

All session.json writes use atomic rename (write to temp file, rename to target). If the rename fails, corruption recovery creates a fresh session with all convergence counts reset to 0.

### Backward Compatibility

```
Is convergence_evidence present in session.json?
  YES --> Use evidence-based counting (new behavior)
  NO  --> Is clean_pass_count present?
    YES --> Fall back to trust-based counting (legacy behavior)
    NO  --> Default to 0 (fail-closed)
```

Sessions created before this change continue to work without modification. Evidence recording starts on the first new convergence loop after deployment.

### Evidence Integrity Verification

The gate enforcement hook (`workflow-gate-enforcement.mjs`) performs optional integrity verification when evidence arrays are present:

- Sequential `pass_number` values with no gaps
- Sequential timestamps (no time-travel)
- Array length matches highest `pass_number`
- Timing plausibility (minimum 10 seconds between passes)

All integrity issues produce advisory warnings only. The hook never blocks dispatch based on integrity alone -- it falls back to count-only verification on any anomaly or script error (fail-open).

---

## Session State Fields

### Cooperative Layer Fields

Enforcement adds these fields to `phase_checkpoint` in `session.json`:

| Field                 | Type   | Purpose                                                     |
| --------------------- | ------ | ----------------------------------------------------------- |
| `phase_skip_warnings` | Object | Map of predecessor key to skip count                        |
| `enforcement_counter` | Number | Monotonic counter of all enforcement events                 |
| `_counter_checksum`   | Number | XOR checksum for counter integrity verification             |
| `enforcement_level`   | String | Current enforcement level (`off`, `warn-only`, `graduated`) |
| `override_count`      | Number | Number of overrides used this session (cap: 3)              |

### Coercive Layer Fields

The coercive layer reads (but does not write) these session.json fields:

| Field                                          | Purpose                                            |
| ---------------------------------------------- | -------------------------------------------------- |
| `active_work.workflow`                         | Determines enforcement rules (workflow type)       |
| `subagent_tasks.in_flight`                     | Dispatch history (in-flight tasks)                 |
| `subagent_tasks.completed_this_session`        | Dispatch history (completed tasks)                 |
| `convergence.code_review.clean_pass_count`     | Code review convergence tracking                   |
| `convergence.security_review.clean_pass_count` | Security review convergence tracking               |
| `convergence_evidence.<gate>.passes[]`         | Pass evidence arrays (evidence-based verification) |

---

## Troubleshooting

### Transition blocked unexpectedly (cooperative layer)

A transition is blocked when a mandatory predecessor was skipped twice (graduated mode). Check which predecessor is missing:

```bash
node .claude/scripts/session-checkpoint.mjs get-status
```

Then either complete the skipped phase or use `override-skip`.

### Dispatch blocked by gate enforcement (coercive layer)

The stderr BLOCKED message identifies which prerequisites are missing. Either:

1. Complete the missing prerequisite dispatch
2. Create a human override in `.claude/coordination/gate-override.json`
3. Activate the kill switch (`.claude/coordination/gate-enforcement-disabled`)

### Session completion blocked (coercive layer)

The Stop hook blocks when mandatory dispatches are missing. The block reason identifies which subagent types have not been dispatched. Either:

1. Dispatch the missing subagent types
2. Create a stop-gate override in `.claude/coordination/gate-override.json` with gate `stop_mandatory_dispatches`
3. Activate the kill switch

### Enforcement degraded to warn-only

This occurs when the integrity check detects a mismatch between `enforcement_counter` and `_counter_checksum`. Someone (or something) edited `session.json` directly. The system self-heals by re-syncing the checksum, but enforcement stays at `warn-only` for the remainder of the session.

### Override cap reached (cooperative layer)

After 3 overrides, `override-skip` and `reset-enforcement` are blocked. Escalate to the human operator. The 3-override cap is a session-level limit and resets when new work is started via `start-work`.

### Evidence integrity warnings

Advisory warnings about pass_number gaps, non-sequential timestamps, or suspicious timing indicate potential issues with evidence recording but do not block dispatch. Common causes:

- **Stale lockfile recovery**: A crashed process left a lockfile, resulting in a missed recording
- **Manual fallback**: The SubagentStop hook could not extract findings metadata, so the pass was recorded as `manual_fallback` (does not count toward convergence)
- **Rapid retries**: Two passes within 10 seconds trigger a timing plausibility warning

If >50% of a gate's passes are manual-sourced, `update-convergence` emits a warning indicating the SubagentStop hook may not be functioning correctly.

### update-convergence rejects count argument

The `update-convergence` command no longer accepts a numeric count argument. The `clean_pass_count` is derived from the evidence array. Use the new API:

```bash
# Old API (rejected):
node .claude/scripts/session-checkpoint.mjs update-convergence investigation 2

# New API:
node .claude/scripts/session-checkpoint.mjs update-convergence investigation
```

To record a pass, use `record-pass` first, then call `update-convergence` to derive the count.

---

## See Also

- [HOOKS.md](HOOKS.md) - Full hook system documentation with detailed behavior for each hook
- CLAUDE.md, "Workflow Enforcement" section - Prose-level enforcement rules
- `.claude/memory-bank/tech.context.md` - Phase list and validation hooks reference

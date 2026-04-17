---
title: Workflow Enforcement Architecture
last_reviewed: 2026-04-17
---

# Workflow Enforcement Architecture

Workflow enforcement operates in two layers. The **cooperative layer** (DAG-based phase transitions via `session-checkpoint.mjs`) enables agents to self-advance through workflow stages with warnings for violations. The **coercive layer** (PreToolUse/Stop hooks) physically blocks tool execution when prerequisites are not met, bypassing cooperative participation.

This document describes the full enforcement architecture including predecessor graphs, override mechanisms, evidence-based convergence, and failure modes.

---

## Enforcement Layers

### Cooperative Layer

Handled by `session-checkpoint.mjs`. DAG-based phase transitions validate predecessors and emit warnings/blocks based on enforcement level.

**Transition commands**:

```bash
node .claude/scripts/session-checkpoint.mjs transition-phase <phase>
node .claude/scripts/session-checkpoint.mjs override-skip <phase> <rationale>
node .claude/scripts/session-checkpoint.mjs reset-enforcement
```

**Enforcement levels**:

- `off`: No enforcement; all transitions allowed (informational checklist only)
- `warn-only`: Log warnings for skipped mandatory stages but allow transitions
- `graduated`: Block transitions that skip mandatory predecessors; require explicit override

### Coercive Layer

Handled by PreToolUse and Stop hooks. Blocks execution regardless of cooperative state.

| Hook                                            | Trigger                                         | Purpose                                                                          |
| ----------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `.claude/scripts/workflow-gate-enforcement.mjs` | PreToolUse Agent                                | Block dispatch of enforced subagent types when prerequisites not met             |
| `.claude/scripts/workflow-file-protection.mjs`  | PreToolUse Write                                | Block agent writes to gate-override.json, kill switch, session.json, session.log |
| `.claude/scripts/workflow-stop-enforcement.mjs` | Stop                                            | Block session completion when mandatory dispatches missing                       |
| SubagentStop convergence reminder               | `.claude/scripts/convergence-gate-reminder.mjs` | Advisory reminder to update convergence gates                                    |
| SubagentStop convergence pass recorder          | `.claude/scripts/convergence-pass-recorder.mjs` | Automated pass evidence recording for convergence gates                          |

### Shared DAG Module

Single source of truth for predecessor graphs, enforcement tables, and query functions: `.claude/scripts/lib/workflow-dag.mjs`. Consumed by both cooperative and coercive layers.

---

## DAG Predecessor Graph

The DAG defines valid phase transitions. Each phase declares its valid predecessors and mandatory prerequisites.

### Phase List (16)

`prd_gathering`, `spec_authoring`, `atomizing`, `enforcing`, `investigating`, `awaiting_approval` (backwards compat), `auto_approval`, `challenging`, `implementing`, `testing`, `verifying`, `reviewing`, `completion_verifying`, `documenting`, `journaling`, `complete`

### Mandatory Predecessors (by phase)

| Phase                  | Mandatory Predecessor                                       |
| ---------------------- | ----------------------------------------------------------- |
| `implementing`         | `challenging` (pre-implementation) + `investigating`        |
| `reviewing`            | `unifier` dispatch + `challenging` (pre-review)             |
| `security_reviewing`   | `convergence.code_review.clean_pass_count >= 2`             |
| `documenting`          | `convergence.security_review.clean_pass_count >= 2`         |
| `completion_verifying` | `documenter` dispatch                                       |
| `complete`             | `completion_verifier` dispatched + all mandatory dispatches |

Phases not listed have no mandatory predecessors beyond the standard DAG edges (they always pass predecessor validation).

### Enforcement Levels at Transition

| Level       | On violation                                 | Override allowed |
| ----------- | -------------------------------------------- | ---------------- |
| `off`       | Transition succeeds silently                 | N/A              |
| `warn-only` | Transition succeeds with stderr warning      | N/A              |
| `graduated` | Transition blocked with stderr BLOCK message | Yes              |

---

## Override Mechanism

When graduated enforcement blocks a transition or dispatch, agents may bypass specific phases or gates.

### Cooperative Override

```bash
node .claude/scripts/session-checkpoint.mjs override-skip <phase> "<rationale>"
```

Records an `override` event in session history with rationale and phase. Cap: 3 overrides per session (resets on `start-work`).

### Coercive Override

Write to `.claude/coordination/gate-override.json`:

```json
{
  "gate": "implementer",
  "session_id": "<session-id>",
  "timestamp": "<ISO 8601>",
  "rationale": "Override rationale (min 10 chars)"
}
```

Per-gate rationales. Once written, the gate enforcement hook exits 0 on match. The override file itself is FULL_BLOCK-protected -- only human terminal writes or trusted CLI scripts can create it.

### Kill Switch

```bash
touch .claude/coordination/gate-enforcement-disabled
```

Disables gate enforcement and stop enforcement entirely. Write protection remains active (agents cannot self-bypass enforcement by creating overrides).

---

## Coercive Enforcement: Subagent Dispatch

### Enforcement Table

`.claude/scripts/workflow-gate-enforcement.mjs` blocks the following subagent dispatches when prerequisites are not met:

| Blocked Subagent      | Prerequisite                                                                      |
| --------------------- | --------------------------------------------------------------------------------- |
| `implementer`         | `interface-investigator` + `challenger` (pre-implementation or pre-orchestration) |
| `test-writer`         | `implementer` dispatched                                                          |
| `code-reviewer`       | `challenger` (pre-review) + `unifier` dispatched                                  |
| `security-reviewer`   | `convergence.code_review.clean_pass_count >= 2`                                   |
| `documenter`          | `convergence.security_review.clean_pass_count >= 2`                               |
| `completion-verifier` | `documenter` dispatched                                                           |

### Block Message Format

When dispatch is blocked, the hook writes to stderr and exits 2:

```
BLOCKED: <subagent-type> dispatch requires:
  - Missing prerequisites (dispatch or convergence)

Override: create .claude/coordination/gate-override.json with:
  { "gate": "<subagent-type>", "session_id": "<current-session>", "timestamp": "<ISO>", "rationale": "<rationale>" }

Or run recommended convergence check first:
  - <skill-command-from-skill-map>
```

### Skill Map

Maps gate names to recommended skill commands in the help message:

| Gate Name                         | Recommended Skill   |
| --------------------------------- | ------------------- |
| `investigation_convergence`       | `/investigate`      |
| `challenger_convergence`          | `/challenge`        |
| `unifier_convergence`             | `/unify`            |
| `code_review_convergence`         | `security-reviewer` |
| `security_review_convergence`     | `documenter`        |
| `completion_verifier_convergence` | `documenter`        |

---

## Coercive Enforcement: Session Completion

`.claude/scripts/workflow-stop-enforcement.mjs` blocks session completion when:

- Mandatory dispatches are missing (`code-reviewer`, `security-reviewer`, `completion-verifier`, `documenter`, `e2e-test-writer`)
- Manifest status obligations are unsatisfied (when `currentPhase === 'complete'`)
- Deployment detected without post-deploy verification

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
2. The `convergence-pass-recorder` SubagentStop hook fires, runs the 4-tier extraction pipeline over `last_assistant_message`, and records structured pass evidence by calling the exported `recordPass()` function in `session-checkpoint.mjs` via module import (CLI `--source hook` is rejected -- see [--source hook Rejection](#--source-hook-cli-rejection) below)
3. The orchestrating agent calls `session-checkpoint.mjs update-convergence <gate_name>` (no count argument)
4. `update-convergence` reads the evidence array, counts consecutive clean hook-sourced passes from the tail with streak-reset semantics, and sets `clean_pass_count` to the derived value
5. The gate enforcement hook reads `clean_pass_count` and optionally verifies evidence integrity

### 4-Tier Extraction Pipeline

The recorder runs four extractors against the agent response, first-match-wins. The tier that matched is reported in the diagnostic log's `extraction_paths_tried` field.

| Tier | Path name        | Detection                                                                                  | Classification                         |
| ---- | ---------------- | ------------------------------------------------------------------------------------------ | -------------------------------------- |
| 1    | `severity`       | Severity regex (`critical:`, `high:`, etc.) or JSON `findings-summary` code block          | CLEAN or DIRTY based on gate threshold |
| 2    | `finding_list`   | Bulleted / numbered / bare-indent finding-ID lists (prefix allow-list) or heading cues     | DIRTY with finding-count               |
| 3    | `severity_prose` | Line-anchored severity-word prose with negation guard (fenced code + blockquotes stripped) | DIRTY                                  |
| 4    | `success_marker` | Normalized last non-empty line matches `no issues found`, `all checks passed`, etc.        | CLEAN                                  |

**Tier 1 fall-through**: If tier 1 finds severity patterns but all counts are zero, the recorder falls through to tier 2 (does not short-circuit as CLEAN). This prevents "Critical: 0, High: 0" from looking like a clean pass when follow-on prose or lists describe actual findings.

**Gate threshold**: `code_review` clears on 0 High+ findings; all other gates clear on 0 Medium+ findings.

**No match** (all 4 tiers miss): recorded as `source: 'parse_failed'`, streak-breaking. See [Source Enum](#source-enum) and [Circuit Breaker](#circuit-breaker-degraded-mode) below.

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

### Source Enum

`record_source` takes one of five values. Only `hook` + `clean: true` contributes to `clean_pass_count`.

| Record Source     | Writer             | Counts for `clean_pass_count` | Streak behavior | Purpose                                         |
| ----------------- | ------------------ | ----------------------------- | --------------- | ----------------------------------------------- |
| `hook`            | Module-import only | Yes (when `clean: true`)      | Extends streak  | Trusted, automated SubagentStop path            |
| `manual`          | CLI                | No                            | Streak-breaking | Operator audit entry                            |
| `manual_fallback` | Module or CLI      | No                            | Streak-breaking | Fail-closed after session.log write failure     |
| `parse_failed`    | Module or CLI      | No                            | Streak-breaking | All 4 extractor paths missed                    |
| `hook_manual`     | CLI only           | No                            | Streak-breaking | Operator emergency remediation for a hook entry |

Any non-`hook-clean` entry -- including `hook` with `clean: false` -- resets the streak during tail-walk.

### Tail-Walk Streak-Reset Semantics

`session-checkpoint.mjs countConsecutiveCleanFromTail()` derives `clean_pass_count` from the evidence array:

1. Walk `session.convergence_evidence.<gate>.passes[]` from the tail forward
2. Count consecutive entries where `record_source === 'hook'` AND `clean === true`
3. Any other entry resets the count (streak-break)
4. Walk bounded to the **last 200 entries** (legacy-pollution defense)
5. On bound-hit without a streak-starting hook-clean entry, emit `CONVERGENCE_TAIL_WALK_BOUNDED` to stderr with the gate name

The 200-entry bound prevents unbounded scans on sessions with large evidence arrays (legacy pollution from before streak-reset). When a bounded walk cannot find a streak start, operators are signalled to inspect the gate's evidence history.

### --source hook CLI Rejection

The CLI `record-pass` command rejects `--source hook` unconditionally and exits with code 2 before any state mutation:

```
SOURCE_HOOK_FORBIDDEN_VIA_CLI: hook-sourced passes may only be recorded
via in-process module import by convergence-pass-recorder.mjs.
Use --source hook_manual for operator remediation.
```

This makes the `source: 'hook'` invariant counterfeit-proof: any such entry in the evidence array must have come from the in-process `recordPass()` module call by `convergence-pass-recorder.mjs`. Rejection is unconditional (no env-var bypass). Operators performing emergency remediation must use `--source hook_manual` instead, which records the pass but does not count toward convergence.

### CLI Commands

#### record-pass

Appends a pass evidence record to the convergence evidence array.

```bash
node .claude/scripts/session-checkpoint.mjs record-pass <gate_name> \
  --findings-count <N> \
  --findings-hash <hex-string> \
  --clean <true|false> \
  --agent-type <agent-type-string> \
  [--source <manual|manual_fallback|parse_failed|hook_manual>] \
  [--auto-decision-batch-id <batch-id>] \
  [--auto-decision-complete <true|false>]
```

**Arguments**:

| Argument                   | Required | Description                                                                     |
| -------------------------- | -------- | ------------------------------------------------------------------------------- |
| `gate_name`                | Yes      | One of `VALID_CONVERGENCE_GATES` (6 gates)                                      |
| `--findings-count`         | No       | Non-negative integer or `null`                                                  |
| `--findings-hash`          | No       | 64-character hex SHA-256 string or `null`                                       |
| `--clean`                  | Yes      | Boolean (`true` or `false`)                                                     |
| `--agent-type`             | Yes      | Agent type string (defaults to `cli-operator` for operator-remediation sources) |
| `--source`                 | No       | `manual` (default), `manual_fallback`, `parse_failed`, or `hook_manual`         |
| `--auto-decision-batch-id` | No       | Links to auto-decision engine invocation                                        |
| `--auto-decision-complete` | No       | `false` marks the pass as dirty (incomplete batch)                              |

**Source restriction**: `--source hook` is rejected with exit code 2. Use the exported `recordPass()` function via module import for hook-sourced writes.

**Exit codes**: `0` on success; `1` on validation error, duplicate `pass_number`, or atomic-write failure; `2` on `--source hook` (forbidden via CLI).

#### update-convergence (modified API)

Derives `clean_pass_count` from the evidence array. No longer accepts a count argument.

```bash
node .claude/scripts/session-checkpoint.mjs update-convergence <gate_name>
```

**Behavior**:

- Reads `convergence_evidence.<gate>.passes[]`
- Counts consecutive `hook`+`clean:true` passes from the tail with streak-reset semantics (any other source breaks the streak)
- Walk bounded to last 200 entries; emits `CONVERGENCE_TAIL_WALK_BOUNDED` on bound-hit without a streak start
- Sets `convergence.<gate>.clean_pass_count` to the derived value
- Emits a warning if >50% of passes are manual-sourced

**Breaking change**: Passing a numeric second argument (e.g., `update-convergence investigation 2`) is rejected with an error explaining the new evidence-based API.

#### update-circuit-breaker

Atomically updates per-gate circuit-breaker state in `session.json.convergence_log_failures.<gate>`. Called by `convergence-pass-recorder.mjs` when session.log writes fail or succeed.

```bash
node .claude/scripts/session-checkpoint.mjs update-circuit-breaker \
  --gate <gate_name> --event <failure|success>
```

**Arguments**:

| Argument  | Required | Description                                |
| --------- | -------- | ------------------------------------------ |
| `--gate`  | Yes      | One of `VALID_CONVERGENCE_GATES`           |
| `--event` | Yes      | `failure` (increment) or `success` (reset) |

**Behavior on `--event failure`**:

- Increments `consecutive_count`
- Stamps `last_failure_at` with current ISO 8601 timestamp
- At `consecutive_count >= 3`, sets `degraded_mode: true` and stamps `entered_degraded_at`

**Behavior on `--event success`**:

- Resets `consecutive_count` to 0
- Clears `degraded_mode` (sets to `false`)
- Clears `entered_degraded_at` (sets to `null`)

**Exit codes**: `0` on success; `1` on atomic-write failure; `2` on invalid `--gate` or `--event`.

### Circuit Breaker (Degraded Mode)

The recorder uses a per-gate circuit breaker to prevent runaway writes to `.claude/context/session.log` when filesystem writes repeatedly fail.

**State shape** (`session.convergence_log_failures.<gate>`):

```json
{
  "consecutive_count": 2,
  "last_failure_at": "2026-04-17T04:30:00.000Z",
  "degraded_mode": false,
  "entered_degraded_at": null
}
```

**Threshold**: `consecutive_count >= 3` flips `degraded_mode` to `true`.

**Normal mode** (`degraded_mode: false`):

- parse_failed cases append a metadata-only entry to session.log and record `source: 'parse_failed'`
- Log-write retry fails (after one 100ms backoff): emit `SESSION_LOG_WRITE_FAIL` stderr, record `source: 'manual_fallback'`, invoke `update-circuit-breaker --event failure`
- Successful log write issues `update-circuit-breaker --event success` (resets state)

**Degraded mode** (`degraded_mode: true`):

- parse_failed cases skip the session.log write entirely
- Emit diagnostic to stderr only (`[convergence-pass-recorder] DEGRADED_MODE: gate=<name> ...`)
- Still record `source: 'parse_failed'` (convergence counts remain safe -- source is streak-breaking either way)
- Exits degraded mode when the next successful session.log write issues `update-circuit-breaker --event success`

**Security boundary**: The session.log diagnostic file is FULL_BLOCK-protected. Direct writes via the Edit/Write tools are blocked by `workflow-file-protection.mjs`. Writes from the in-repo `convergence-pass-recorder.mjs` use `fs.appendFileSync` directly, which is intentionally outside the hook's vantage (it observes only Claude tool-call stdin JSON). Log files are created with mode `0600` and re-chmoded on invocation if drift is detected.

### Canonical Findings Hash

Finding IDs are hashed deterministically: sort lexicographically, JSON.stringify the sorted array, then SHA-256 the UTF-8 encoding. This allows verification that two passes examined the same set of findings.

```javascript
import { computeFindingsHash } from '.claude/scripts/lib/findings-hash.mjs';

const hash = computeFindingsHash(['f-002', 'f-001', 'f-003']);
// SHA-256 of '["f-001","f-002","f-003"]'
```

### Module-Import API

`session-checkpoint.mjs` exports `recordPass()` for in-process writes:

```javascript
import { recordPass } from '.claude/scripts/session-checkpoint.mjs';

await recordPass({
  source: 'hook', // or manual | manual_fallback | parse_failed | hook_manual
  gate: 'investigation', // one of VALID_CONVERGENCE_GATES
  clean: true, // boolean (required)
  findingCount: 0, // optional
  findingsHash: '<64-hex>', // optional
  agentType: 'interface-investigator',
  agentId: '<uuid>', // optional
});
```

`recordPass()` is the sole permitted writer for `source: 'hook'` entries. It performs the same enum + gate + atomic-write validation as the CLI and throws on invalid input or write failure.

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

| Field                                          | Purpose                                                 |
| ---------------------------------------------- | ------------------------------------------------------- |
| `active_work.workflow`                         | Determines enforcement rules (workflow type)            |
| `subagent_tasks.in_flight`                     | Dispatch history (in-flight tasks)                      |
| `subagent_tasks.completed_this_session`        | Dispatch history (completed tasks)                      |
| `convergence.code_review.clean_pass_count`     | Code review convergence tracking                        |
| `convergence.security_review.clean_pass_count` | Security review convergence tracking                    |
| `convergence_evidence.<gate>.passes[]`         | Pass evidence arrays (evidence-based verification)      |
| `convergence_log_failures.<gate>`              | Per-gate circuit-breaker state for session.log failures |

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

### CONVERGENCE_TAIL_WALK_BOUNDED warning

Emitted by `countConsecutiveCleanFromTail()` when the evidence array has >= 200 entries and none of the last 200 are hook-clean. Indicates probable legacy pollution from before the streak-reset fix (2026-04-16) or extended parse-failure streaks. Inspect the gate's evidence history:

```bash
node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('.claude/context/session.json')).convergence_evidence['<gate>'].passes.slice(-10), null, 2))"
```

### Circuit breaker in degraded mode

When `session.convergence_log_failures.<gate>.degraded_mode` is `true`, the recorder suppresses session.log writes for that gate and emits diagnostics to stderr only. Convergence counts remain safe (parse_failed is streak-breaking in either mode). To exit degraded mode, investigate the underlying session.log write failure (commonly permissions or disk space) and reset by recording a successful pass, which invokes `update-circuit-breaker --event success`.

### update-convergence rejects count argument

The `update-convergence` command no longer accepts a numeric count argument. The `clean_pass_count` is derived from the evidence array. Use the new API:

```bash
# Old API (rejected):
node .claude/scripts/session-checkpoint.mjs update-convergence investigation 2

# New API:
node .claude/scripts/session-checkpoint.mjs update-convergence investigation
```

To record a pass, use `record-pass` first, then call `update-convergence` to derive the count.

### record-pass --source hook rejected

`--source hook` is forbidden via the CLI (exit code 2, `SOURCE_HOOK_FORBIDDEN_VIA_CLI` stderr message). Only the in-process `convergence-pass-recorder.mjs` hook may record `source: 'hook'` entries via the exported `recordPass()` module function. For operator remediation of a hook entry, use `--source hook_manual` instead (audit-only, does not count toward convergence).

---

## See Also

- [HOOKS.md](HOOKS.md) - Full hook system documentation with detailed behavior for each hook
- CLAUDE.md, "Workflow Enforcement" section - Prose-level enforcement rules
- `.claude/memory-bank/tech.context.md` - Phase list and validation hooks reference

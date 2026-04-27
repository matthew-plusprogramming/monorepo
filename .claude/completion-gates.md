# Completion Gates Configuration

This file defines project-specific completion verification gates for the metaclaude-assistant project. These gates are loaded by the `completion-verifier` agent after universal gates have been evaluated.

## Gate Entry Schema

Each gate definition uses structured markdown with these fields:

| Field             | Required | Type                                       | Description                                         |
| ----------------- | -------- | ------------------------------------------ | --------------------------------------------------- |
| **description**   | Yes      | string                                     | Human-readable explanation of what this gate checks |
| **category**      | Yes      | `blocking` or `advisory`                   | Whether gate failures block commit                  |
| **verification**  | Yes      | object                                     | How to verify (see verification types below)        |
| **fix_action**    | Yes      | string                                     | What the fix agent should do if gate fails          |
| **applicability** | Yes      | `when_files_match:` glob or array of globs | Which modified files trigger this gate (OR logic)   |

### Verification Types

- **file-check**: Verify file existence (or non-existence with `negate: true`) at `target` path
- **content-pattern**: Run grep/ripgrep `pattern` against files matching `target` glob; `negate: true` inverts
- **script**: Execute `script` from `.claude/scripts/` with `args`; exit 0 = pass, non-zero = fail

### Category Semantics

- **blocking**: Verification errors treated as failures; blocks commit
- **advisory**: Verification errors treated as warnings; findings surfaced at Low severity; does not block commit

### Applicability Rules

- Single glob string or array of globs (OR logic)
- Matched against modified file paths
- Negation patterns (e.g., `!*.test.ts`) are NOT supported
- Gate is applicable when any modified file matches any provided pattern

---

## Project-Specific Gates

### registry-hash-verify

- **description**: Verify that registry hashes are up to date after modifying tracked artifacts
- **category**: blocking
- **verification**:
  - **type**: script
  - **script**: compute-hashes.mjs
  - **args**: [--verify]
- **fix_action**: Run `node .claude/scripts/compute-hashes.mjs --update` to recompute hashes, then verify the registry diff is correct
- **applicability**: when_files_match: [".claude/agents/*.md", ".claude/skills/*/SKILL.md", ".claude/templates/*.md", ".claude/scripts/*.mjs", ".claude/memory-bank/**/*.md"]

### bundle-inclusion-verify

- **description**: Verify that new artifacts are registered in metaclaude-registry.json and included in appropriate bundles
- **category**: blocking
- **verification**:
  - **type**: script
  - **script**: verify-bundles.mjs
  - **args**: []
- **fix_action**: Register new artifacts in `.claude/metaclaude-registry.json` with version, hash, and path. Add to the appropriate bundle includes array (minimal, core-workflow, or full-workflow). Run `node .claude/scripts/compute-hashes.mjs --update` to compute hashes.
- **applicability**: when_files_match: [".claude/agents/*.md", ".claude/skills/*/SKILL.md", ".claude/templates/*.md", ".claude/scripts/*.mjs"]

### pipeline-efficiency-hash-chain-verify

- **description**: Verify the pipeline-efficiency audit-log hash chain (genesis anchor + rotation chain). Implements REQ-014 / NFR-HASH-CHAIN-VERIFY: `verify-audit-chain.mjs --include-rotations` MUST pass before completion-verifier advances. On `CHAIN_BROKEN` merge is blocked. On `GENESIS_ANCHOR_INVALID` or `GENESIS_SIGNATURE_INVALID` the gate fails with the structured error code surfaced via the script's stderr JSON envelope.
- **category**: blocking
- **verification**:
  - **type**: script
  - **script**: completion-verifier-hooks.mjs
  - **args**: [verify-hash-chain]
- **fix_action**: Read the stderr JSON envelope emitted by `verify-audit-chain.mjs`; match on `error_code` — `CHAIN_BROKEN`: identify the broken sequence number (`broken_seq`) and rotate via signed commit (see spec.md §Flow 5); `GENESIS_ANCHOR_INVALID`: restore genesis anchor at `.claude/audit/pipeline-efficiency-genesis.json` via signed commit; `GENESIS_SIGNATURE_INVALID`: move genesis to `.claude/audit/pipeline-efficiency-genesis-quarantine.json` and re-genesis via valid signing key (EDGE-020).
- **applicability**: when_files_match: [".claude/audit/pipeline-efficiency-genesis.json", ".claude/audit/pipeline-efficiency-changes.log", ".claude/scripts/pipeline-efficiency-audit-log.mjs", ".claude/scripts/verify-audit-chain.mjs", ".claude/scripts/pipeline-efficiency-coercive-flip-preflight.mjs", ".claude/config/pipeline-efficiency-enforcement.json"]

### pipeline-efficiency-3-way-baseline-gate

- **description**: Verify 3-workstream baseline presence for pipeline-efficiency coercive advance. Implements REQ-017 / EC-9: all three canonical baselines (`pipeline-efficiency-ws{1,2,3}-baseline.json`) must exist, be schema-valid, and satisfy the REQ-011 sufficiency predicate before a coercive flip is accepted. During the ws-1 solo ship, `BASELINES_INCOMPLETE` is treated as ADVISORY-ONLY and does NOT block merge (ws-2/ws-3 baselines not yet published); all other structured rejections remain blocking.
- **category**: blocking
- **verification**:
  - **type**: script
  - **script**: completion-verifier-hooks.mjs
  - **args**: [verify-baseline-gate]
- **fix_action**: Inspect the wrapper's stderr — `ADVISORY verify-baseline-gate BASELINES_INCOMPLETE`: expected during ws-1 solo ship; no action required until ws-2/ws-3 ship. `REJECTED verify-baseline-gate SENTINEL_ACTIVE`: remove kill-switch sentinel via signed commit. `BASELINE_SCHEMA_INVALID`: republish the offending baseline with a valid payload per `.claude/lib/schemas/baseline.schema.mjs`. `BASELINE_INSUFFICIENT`: extend the measurement window or raise sample_count per REQ-011. `BASELINE_RACE_ABORT`: re-run after the concurrent baseline writer completes.
- **applicability**: when_files_match: [".claude/metrics/pipeline-efficiency-ws*-baseline.json", ".claude/scripts/pipeline-efficiency-coercive-flip-preflight.mjs", ".claude/scripts/pipeline-efficiency-audit-log.mjs", ".claude/config/pipeline-efficiency-enforcement.json", ".claude/coordination/pipeline-efficiency-disabled"]

### worktree-env-parity-verify

- **description**: Verify session-pinned worktree parity before merge. Implements REQ-007 / AC9.1 (sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-009): the completion-verifier gate asserts that `CLAUDE_PROJECT_DIR` still canonicalizes to `session.active_work.project_dir_pin` at pre-merge time, so a drifted session cannot land its commit. On `WORKTREE_PATH_VIOLATION` the wrapper emits an audit entry via the shared `logWorktreeViolation` helper (event_class `worktree_path_violation`, consumer `completion-verifier`) and exits 2 — blocking merge. Legacy sessions with no captured pin pass silently.
- **category**: blocking
- **verification**:
  - **type**: script
  - **script**: completion-verifier-hooks.mjs
  - **args**: [verify-worktree-env-parity]
- **fix_action**: Inspect the wrapper's stderr — `REJECTED verify-worktree-env-parity WORKTREE_PATH_VIOLATION {reason: ...}`: reason `env-mutation` means `CLAUDE_PROJECT_DIR` was swapped mid-session; restore the original pinned root or rotate legitimately via `node .claude/scripts/session-checkpoint.mjs rotate-worktree <new-root>`. Reason `symlink-component`: resolve the symlink explicitly (operator must pass a canonical path). Reason `path-escape`: write-target resolves outside the pinned worktree — confirm the intended file path is inside the worktree root.
- **applicability**: when_files_match: [".claude/scripts/session-checkpoint.mjs", ".claude/scripts/lib/worktree-canon.mjs", ".claude/scripts/lib/worktree-canon-audit.mjs", ".claude/scripts/lib/worktree-enforcement.mjs", ".claude/scripts/workflow-gate-enforcement.mjs", ".claude/scripts/workflow-stop-enforcement.mjs", ".claude/scripts/workflow-file-protection.mjs", ".claude/scripts/completion-verifier-hooks.mjs", ".claude/agents/completion-verifier.md"]

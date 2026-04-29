---
_source_modules: ['pipeline-efficiency-ws3-orchestrator-hygiene']
---

# Worktree-Canon Operator Guide

Operator reference for the NFR-WORKTREE-CANON contract shipped in `sg-pipeline-efficiency-ws3-orchestrator-hygiene` (REQ-007). Closes SEC H2 (symlink escape / mid-session `CLAUDE_PROJECT_DIR` mutation attack on the ws-1 hook surface). The contract establishes a canonical worktree pin at session start, validates every file-touching access against the pin, and rejects unauthorized env mutation with a structured error.

## The Worktree Pin

A single canonicalized path string stored on `session.active_work.project_dir_pin`. Captured once, at session start, via `worktree-canon.capturePin(CLAUDE_PROJECT_DIR)`. Every subsequent file-touching operation inside the session validates its target path against this pin.

### When the Pin Is Captured

`session-checkpoint.mjs start-work` calls `capturePin(process.env.CLAUDE_PROJECT_DIR)`:

1. `canonicalize()` resolves the path via `fs.realpath`.
2. Any symlink in an intermediate component triggers `WORKTREE_PATH_VIOLATION` reason `symlink-component` — the operator must resolve the symlink explicitly before retry.
3. The resolved canonical path is stored atomically on `session.active_work.project_dir_pin`.
4. `autoDetectCaseFS()` probes the filesystem once (create temp file at lowercased name, stat uppercased — same inode implies case-insensitive FS) and caches the result on `session.active_work.case_insensitive_fs`. Darwin HFS+/APFS registers `true`; Linux ext4 registers `false`.

One pin per session. Legitimate pin mutation requires explicit operator action via `rotate-worktree` (see below).

### What the Pin Protects

Two attack surfaces:

1. **Path escape** — a file-touching agent or hook attempts to read or write outside the worktree root via `..` segments or absolute paths pointing elsewhere.
2. **Env-mutation** — an attacker modifies `CLAUDE_PROJECT_DIR` mid-session to point at a different worktree, spoofing the hook/agent into operating on an unintended repo.

Before ws-3, ws-1's hook surface read `process.env.CLAUDE_PROJECT_DIR` on every invocation without re-validation. An attacker controlling the env could silently redirect hook logic. NFR-WORKTREE-CANON closes this by pinning the canonical root at `start-work` and enforcing parity on every consumer read.

## Violation Reasons (4 Closed Enum)

Every violation emits a structured error with a `reason` drawn from a closed enum. The shape is identical across all four reasons.

### Error Shape

```json
{
  "code": "WORKTREE_PATH_VIOLATION",
  "reason": "symlink-component" | "path-escape" | "env-mutation" | "case-fs-mismatch",
  "attempted_path": "string (pre-canonicalization)",
  "pinned_root": "string (session.active_work.project_dir_pin)",
  "exit_code": 2
}
```

Consumers surface this error to the operator via stderr; the session aborts with exit 2. Every violation also appends an audit entry under event_class `worktree_path_violation` (NFR-5 item e) to `.claude/audit/pipeline-efficiency-changes.log` before the error surfaces.

### Reason Table

| `reason`            | Triggered by                                                                                           | Typical root cause                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `symlink-component` | `canonicalize()` finds any intermediate component is a symlink (including `CLAUDE_PROJECT_DIR` itself) | Operator set `CLAUDE_PROJECT_DIR` to a symlink path (e.g., `~/repos` is a symlink to `/Volumes/SSD/repos`). Resolve explicitly. |
| `path-escape`       | `validateAgainstPin()` canonical target is neither `pin` nor `pin + "/"`-prefixed                      | Agent or hook attempting to write outside the worktree root (e.g., `/tmp/out.json` when pin is `/Users/me/repo`).               |
| `env-mutation`      | `enforceEnvParity()` current `CLAUDE_PROJECT_DIR` canonicalizes differently from `project_dir_pin`     | `CLAUDE_PROJECT_DIR` changed mid-session without calling `rotate-worktree`. Attacker spoof or shell-script mutation.            |
| `case-fs-mismatch`  | Case-folded comparison on Darwin (auto-detected; Linux ext4 uses exact compare) fails the pin check    | Duplicate-cased filesystem entries or case-flip in the pin vs. env path on HFS+/APFS.                                           |

`symlink-component` and `path-escape` are emitted by `canonicalize()` + `validateAgainstPin()` respectively; `env-mutation` and `case-fs-mismatch` are emitted by `enforceEnvParity()`.

## The 7 Consumer Wiring

`enforceEnvParity(pin)` (or `canonicalize(target)` + `validateAgainstPin(target, pin)`) is wired into 7 consumers. 3 are ws-1 hook retrofits (closed SEC H2 via as-021); 4 are ws-3 native consumers (as-005 through as-010).

### ws-1 Hook Retrofit — Closes SEC H2

Retrofitted in `as-021-ws1-hook-consumer-canon-upgrade.md`. Each live hook invokes `enforceEnvParity(pin)` at hook entry, before any downstream logic runs. Canon-lock grep markers sit within ±3 lines of every env/cwd read for AC21.4 compliance.

| #   | Consumer                                          | Call site                        | Purpose                                                                               |
| --- | ------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | `.claude/scripts/workflow-gate-enforcement.mjs`   | `enforceEnvParity(pin)` at entry | Reject mid-session env-swap before gate-enforcement logic runs.                       |
| 2   | `.claude/scripts/workflow-stop-enforcement.mjs`   | `enforceEnvParity(pin)` at entry | Reject mid-session env-swap before stop-hook completion checks.                       |
| 3   | `.claude/scripts/validate-convergence-fields.mjs` | `enforceEnvParity(pin)` at entry | Reject env-swap before manifest-field validation; prefers `CLAUDE_PROJECT_DIR` env.   |

### ws-3 Native Consumers (4 Consumers)

Shipped in as-005 through as-010. Cover the file-write surface, phase-transition DAG, facilitator rotation, and pre-merge completion-verifier.

| #   | Consumer                                                                                                                  | Call site                                                                                   | Purpose                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 4   | `.claude/scripts/workflow-file-protection.mjs`                                                                            | `canonicalize(target)` + `validateAgainstPin(target, pin)` before FULL_BLOCK basename check | Reject path-escape + symlink-component on every protected-file write. |
| 5   | `.claude/scripts/lib/workflow-dag.mjs` phase-transition validators                                                        | `enforceEnvParity(pin)` at each phase transition                                            | Reject env-mutation at every DAG edge.                                |
| 6   | `.claude/agents/completion-verifier.md` (pre-merge)                                                                       | `enforceEnvParity(pin)` before merge evaluation                                             | Prevent merging under a spoofed worktree.                             |
| 7   | File-touching agent dispatches (prd-writer, spec-author, atomizer, implementer, test-writer, e2e-test-writer, documenter) | `validateAgainstPin(target, pin)` before every file write                                   | Per-agent write-path escape-guard.                                    |

`session-checkpoint.mjs start-work` is NOT an "enforcement consumer" in the 7-count — it is the producer that captures the pin. `session-checkpoint.mjs rotate-worktree` is the legitimate-rotation writer (see next section).

## Library Surface

Host module: `.claude/scripts/lib/worktree-canon.mjs`.

| Export                       | Signature                          | Purpose                                                                                                                                                            |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `canonicalize(path)`         | `(string) → string`                | `fs.realpath`-resolve; reject if any path component is a symlink.                                                                                                  |
| `validateAgainstPin(p, pin)` | `(string, string) → void` (throws) | Reject when canonicalized target escapes the pinned root (must be `pin` or `pin + "/"`-prefixed).                                                                  |
| `autoDetectCaseFS()`         | `() → boolean`                     | Probe once per session — create temp file at lowercased name, stat uppercased; same inode ⇒ case-insensitive. Cached on `session.active_work.case_insensitive_fs`. |
| `capturePin(envRoot)`        | `(string) → string`                | Called at `session-checkpoint.mjs start-work`; canonicalizes + stores as `session.active_work.project_dir_pin`.                                                    |
| `enforceEnvParity(pin)`      | `(string) → void` (throws)         | Reject when current `CLAUDE_PROJECT_DIR` canonicalizes differently from `pin` (mid-session env-mutation).                                                          |
| `WORKTREE_PATH_VIOLATION`    | const                              | Error-code constant; value `"WORKTREE_PATH_VIOLATION"`.                                                                                                            |

ws-1 hook retrofits call `enforceEnvParity` via a thin delegate at `.claude/scripts/lib/worktree-enforcement.mjs` that preserves a legacy-session guard (pre-as-006 sessions without a pin degrade gracefully).

## Legitimate Rotation: `rotate-worktree`

Operators MUST NOT modify `CLAUDE_PROJECT_DIR` directly mid-session — that path is `env-mutation` and will be rejected with exit 2. Legitimate worktree rotation (e.g., disk migration, moving the repo, switching between parallel worktree branches) uses the `rotate-worktree` CLI which atomically re-pins.

```bash
node .claude/scripts/session-checkpoint.mjs rotate-worktree <new-root> \
  --rationale "worktree relocation: moved repo to faster SSD"
```

Behavior:

1. Canonicalize `<new-root>` via `canonicalize()`.
2. Symlink-reject intermediate components (same rules as `capturePin`).
3. Atomically replace `session.active_work.project_dir_pin` with the new canonical path.
4. Re-run `autoDetectCaseFS()` (new mount point may have different FS semantics).
5. Append an audit entry (event_class `sentinel_lifecycle` or session-override class — verify against current schema).

Exit codes:

| Exit | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| `0`  | Rotation accepted; pin updated atomically.                                 |
| `1`  | Invocation error (missing `<new-root>` arg, missing rationale).            |
| `2`  | `WORKTREE_PATH_VIOLATION` (`symlink-component` on new root; or I/O error). |

No other mid-session env change is accepted. The session fails with `env-mutation` on every consumer read until `rotate-worktree` is invoked or the session is restarted with a consistent env.

## Session-State Fields

| Field                                     | Written at                                             | Consumers                                                                              |
| ----------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `session.active_work.project_dir_pin`     | `session-checkpoint.mjs start-work` (via `capturePin`) | All 7 consumers — single pin per session; rotation re-pins atomically.                 |
| `session.active_work.case_insensitive_fs` | `start-work` (via `autoDetectCaseFS`)                  | `validateAgainstPin` — selects case-folded vs. exact comparison based on FS detection. |

These fields are owned by `session-checkpoint.mjs` exclusively. Agents MUST NOT write them directly; the FULL_BLOCK write protection in `workflow-file-protection.mjs` enforces this.

## SEC H2 Closure Note

SEC H2 was a security-review finding against the ws-1 hook surface: hooks read `process.env.CLAUDE_PROJECT_DIR` on every invocation without re-validation, so an attacker controlling the env could silently redirect hook logic to a different worktree (symlink escape / mid-session env-swap).

The closure pathway:

1. **ws-3 as-005** shipped `.claude/scripts/lib/worktree-canon.mjs` with the 6-export library surface.
2. **ws-3 as-006** wired `capturePin` into `session-checkpoint.mjs start-work`.
3. **ws-3 as-007 through as-010** wired the 4 ws-3 native consumers (file-protection, DAG validators, completion-verifier, file-touching agent dispatches).
4. **ws-3 as-021** (circular-dependency resolution finding inv-merge-order-6c3d4e) retrofitted the 4 ws-1 hooks after ws-1 merged, demoting the NFR-WORKTREE-CANON reference in ws-1 as-008/as-009 to a deferred consumer obligation and closing SEC H2 in the ws-3 merge commit.

All four rejection paths (`symlink-component`, `path-escape`, `env-mutation`, `case-fs-mismatch`) produce identical-shape structured errors and audit entries, giving operators forensic visibility. Completion-verifier CVG-004 (Pass 1) flagged residual ws-1 hook surface gap; as-021 closed it in Pass 2.

## Worktree Pin vs. Kill-Switch

The worktree pin and the kill-switch sentinel interact via git-tree visibility. The kill-switch sentinel at `.claude/coordination/pipeline-efficiency-disabled` is git-tracked on `main`. If an operator creates the sentinel on `main` during an active worktree-branch session:

- The worktree branch does NOT see the sentinel unless the operator rebases.
- `worktree_path_violation` audit appends emitted by consumers on the worktree branch continue to land in the worktree's audit log (not main's).
- Effective kill REQUIRES rebase propagation to the worktree branch.

This visibility constraint is documented in `PIPELINE-EFFICIENCY-OPERATOR-RUNBOOK.md § Kill-Switch Sentinel` and the ws-3 spec § Sentinel Visibility Note.

## Troubleshooting

### "WORKTREE_PATH_VIOLATION: symlink-component" at session start

`CLAUDE_PROJECT_DIR` contains a symlink component. Resolve explicitly:

```bash
# Inspect the env
echo $CLAUDE_PROJECT_DIR

# Resolve each component
realpath $CLAUDE_PROJECT_DIR

# Re-export with the resolved path
export CLAUDE_PROJECT_DIR="$(realpath $CLAUDE_PROJECT_DIR)"
```

Then restart the session.

### "WORKTREE_PATH_VIOLATION: env-mutation" mid-session

Mid-session `CLAUDE_PROJECT_DIR` change not via `rotate-worktree`. Two options:

1. Revert the env change and continue the session: `export CLAUDE_PROJECT_DIR="<original-pinned-root>"`.
2. Legitimately rotate: `node .claude/scripts/session-checkpoint.mjs rotate-worktree <new-root> --rationale "..."`.

### "WORKTREE_PATH_VIOLATION: path-escape" on file write

An agent or hook attempted to write outside the pinned root. Inspect the audit log entry to identify which consumer emitted the violation:

```bash
jq 'select(.event_class == "worktree_path_violation") | .payload' \
  .claude/audit/pipeline-efficiency-changes.log | tail -5
```

Typical fix: the agent's target path construction is buggy; file an issue and retry after fix.

### "WORKTREE_PATH_VIOLATION: case-fs-mismatch" on Darwin

The pin and current env path differ only in case (e.g., `/Users/Me/repo` vs. `/Users/me/repo`). Darwin HFS+/APFS treats these as equivalent; the pin check is case-folded. If the mismatch persists, the FS detection may have misfired — inspect `session.active_work.case_insensitive_fs` and restart the session to re-probe.

## Cross-References

| Primitive                    | Related hook / script                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library                      | `.claude/scripts/lib/worktree-canon.mjs` (single source of truth)                                                                                    |
| ws-1 hook retrofit delegate  | `.claude/scripts/lib/worktree-enforcement.mjs` (legacy-session guard wrapper)                                                                        |
| Session-state pin            | `.claude/scripts/session-checkpoint.mjs` `start-work` / `rotate-worktree`                                                                            |
| Audit emission               | `.claude/scripts/pipeline-efficiency-audit-log.mjs` (event_class `worktree_path_violation` — NFR-5 item e)                                           |
| Hook-entry parity checks     | `.claude/scripts/workflow-gate-enforcement.mjs`, `workflow-stop-enforcement.mjs`, `validate-convergence-fields.mjs`                                |
| Path-escape / symlink reject | `.claude/scripts/workflow-file-protection.mjs`                                                                                                       |
| DAG phase transitions        | `.claude/scripts/lib/workflow-dag.mjs`                                                                                                               |

## See Also

- `PIPELINE-EFFICIENCY-OPERATOR-RUNBOOK.md § Worktree-Canon Pin` — operator quick reference
- `HOOKS.md § Worktree-canon integration points` — hook-relevant consumer summary
- `AUDIT-LOG-INSPECTION.md § worktree_path_violation Event Class` — forensic procedures
- `WORKTREE-CANON.md § Library Surface` — current contract surface
- `WORKTREE-CANON.md § The 7 Consumer Wiring` — consumer wiring and SEC H2 closure
- `WORKTREE-CANON.md § Violation Reasons` — current failure taxonomy

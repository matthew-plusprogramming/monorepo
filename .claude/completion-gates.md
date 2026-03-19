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

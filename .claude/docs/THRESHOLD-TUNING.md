---
_source_modules: ['pipeline-efficiency-ws1-convergence-pruning']
---

# Per-Gate Threshold Tuning Guide

How to adjust per-gate convergence thresholds in the `PerGateThresholdTable` and satisfy the BIZ-002 minimum-pruning-floor justification workflow.

## Canonical Source

Single source of truth: `.claude/scripts/lib/per-gate-threshold-table.mjs`.

Exported as `PerGateThresholdTable` (frozen at module load). Zod-validated at import; invalid entries throw before any consumer can read. See `.claude/scripts/lib/schemas/per-gate-threshold-table.schema.mjs`.

Per-gate rationale: `.claude/prds/pipeline-efficiency/threshold-decisions.md` (authored by operator; referenced by `minimum-pruning-floor.mjs`).

## Shipped Thresholds

| Gate                  | `required_clean_passes` | `attestation_mode` | `hash_input_manifest`                                        | Relaxed |
| --------------------- | ----------------------- | ------------------ | ------------------------------------------------------------ | ------- |
| `unifier`             | 1                       | `content-hash`     | `.claude/specs/groups/<id>/{spec.md,requirements.md,manifest.json}` | YES     |
| `completion-verifier` | 1                       | `content-hash`     | `manifest.json`, registry content, trace files               | YES     |
| `code-review`         | 2                       | `content-hash`     | `git-diff:<branch-base>..HEAD` descriptor                    | No      |
| `security`            | 2                       | `content-hash`     | `git-diff:<branch-base>..HEAD` descriptor                    | No      |
| `investigation`       | 2                       | `none`             | N/A                                                          | N/A     |
| `challenger-pre-impl` | 2                       | `none`             | N/A                                                          | N/A     |

## Attestation Modes

- **`content-hash`**: Gate MAY converge at `1 clean pass + content-hash match` when the gate's `hash_input_manifest` is byte-identical between Pass N and Pass N-1. Falls back to consecutive counting on hash mismatch (EC-7).
- **`none`**: Pass counting alone. Attestation not safe because distinct findings per pass observed in evidence runs (investigation, challenger substages). Rationale field required.

## Tuning Workflow

### 1. Identify target gate

Open `.claude/scripts/lib/per-gate-threshold-table.mjs`. Locate the gate entry in `RAW_TABLE` (lines 111-150).

### 2. Decide new values

Permissible transitions:

- `(2, content-hash)` → `(1, content-hash)`: relax (requires baseline evidence)
- `(1, content-hash)` → `(2, content-hash)`: tighten (no justification needed)
- `(*, none)` → `(*, content-hash)`: not safe without new evidence the gate's inputs are stable
- `(*, none)` → adjust `required_clean_passes`: permitted with rationale update

Prohibited: setting `attestation_mode: "none"` without populating `rationale` (schema throws).

### 3. Update the table entry

Example: relax `code-review` to `(1, content-hash)`.

```javascript
'code-review': {
  required_clean_passes: 1,
  attestation_mode: 'content-hash',
  hash_input_manifest: [...GIT_DIFF_HASH_INPUT_MANIFEST],
},
```

### 4. Update rationale in threshold-decisions.md

Required for every change. Append to `.claude/prds/pipeline-efficiency/threshold-decisions.md`:

```markdown
### `code-review` — `(1, content-hash)` — RELAXED

**Decision**: Relax to 1 clean pass plus content-hash attestation.

**Rationale**: <explain why the gate's inputs fully determine findings>

**Evidence references**:

- `.claude/metrics/pipeline-efficiency-code-review-baseline.json` — sample_count: N, Medium+ 2nd-pass rate: X%
- Historical runs: <spec-group IDs>

**Risk controls**:

- EC-7 fallback: content-hash mismatch forces second pass
- Reverse-governance SLA (REQ-015)
```

### 5. Run the validator

```bash
node .claude/scripts/validate-minimum-pruning-floor.mjs
```

Confirms at least one of `{unifier, code-review, security, completion-verifier}` is relaxed, OR `threshold-decisions.md` documents ≥10% Medium+ 2nd-pass rate for ALL four gates (BIZ-002 zero-relax justification).

### 6. Commit

```bash
git add .claude/scripts/lib/per-gate-threshold-table.mjs \
        .claude/prds/pipeline-efficiency/threshold-decisions.md
git commit -S -m "tune: <gate> to (N, attestation)"
```

Unsigned commits rejected for the threshold table (enforcement-file protection).

## BIZ-002 Minimum-Pruning Floor

At least ONE of `{unifier, code-review, security, completion-verifier}` MUST be configured at `(required_clean_passes: 1, attestation_mode: "content-hash")`.

Zero-relax justification allowed ONLY when `threshold-decisions.md` contains per-gate baseline evidence for ALL four gates showing `Medium+ finding rate ≥ 10% on 2nd pass`. Evidence structure:

```markdown
### `<gate>` — `(2, content-hash)` — ZERO-RELAX JUSTIFICATION

**Medium+ 2nd-pass rate**: <N>% (threshold: ≥10%)
**Sample size**: <N> workstreams / <D> days
**Baseline file**: `.claude/metrics/pipeline-efficiency-<gate>-baseline.json`
**Measurement window**: <ISO start>..<ISO end>
```

Validator enforces presence of all four entries when no gate is relaxed. Missing entry produces a floor violation that blocks completion.

## Hash-Input Manifest Format

Entries in `hash_input_manifest` are logical descriptors expanded at attestation time:

- Literal paths: `.claude/specs/groups/<id>/spec.md`, `.claude/specs/groups/<id>/requirements.md`, `.claude/specs/groups/<id>/manifest.json`
- Glob descriptors: `.claude/specs/groups/<id>/slices/*.md`
- Synthetic descriptors: `git-diff:<branch-base>..HEAD`, `registry content`, `trace files`

Manifest expansion lives in `.claude/scripts/lib/hash-input-manifest.mjs`. `HashInputError` (missing file, git failure, unresolved placeholder) is trapped at `recordPass()` time to a no-op: missing content_hash falls back to consecutive counting.

## Rollback

Tightening is always safe (revert to `2, content-hash` or `2, none`). No baseline evidence required.

Emergency tighten: set `required_clean_passes: 3` to force extra passes while investigating a false-positive spike. Remember to revert once baselines recover.

## See Also

- `PIPELINE-EFFICIENCY-OPERATOR-RUNBOOK.md` — enforcement-flag + kill-switch procedures
- `.claude/prds/pipeline-efficiency/threshold-decisions.md` — per-gate rationale record
- `.claude/scripts/lib/per-gate-threshold-table.mjs` — canonical table source
- `.claude/scripts/validate-minimum-pruning-floor.mjs` — BIZ-002 validator CLI
- `CLAUDE.md` §Convergence Gates — per-gate threshold semantics

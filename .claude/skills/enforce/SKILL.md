---
name: enforce
description: Validate atomic specs meet atomicity criteria
allowed-tools: Read, Glob, Task, Bash
user-invocable: true
---

# /enforce Skill

## Required Context

Before beginning work, read these files for project-specific guidelines:

- `.claude/memory-bank/best-practices/spec-authoring.md`

## Purpose

Validate that atomic specs are at the right level of granularity—not too coarse (needs splitting) and not too granular (needs merging). Also verifies complete requirements coverage.

## Usage

```
/enforce                      # Validate current spec group
/enforce <spec-group-id>      # Validate specific spec group
/enforce --strict             # Treat warnings as failures
```

## Prerequisites

Before running `/enforce`:

1. Spec group must exist with `manifest.json`
2. `requirements.md` must exist
3. `atomic/` directory must contain atomic specs (from `/atomize`)

## Process

1. **Locate spec group**
   - If no ID provided, look for active spec group
   - Validate required files exist

2. **Run minimum-pruning floor validator (REQ-001, BIZ-002)**

   Execute the floor validator before dispatching atomicity-enforcer. This
   asserts at least one of `{unifier, code-review, security, completion-verifier}`
   is configured at `(required_clean_passes: 1, attestation_mode: "content-hash")`
   in `PerGateThresholdTable` unless
   `.claude/prds/pipeline-efficiency/threshold-decisions.md` documents
   per-gate baseline evidence (>=10% Medium+ 2nd-pass rate) for all four
   gates.

   ```bash
   node .claude/scripts/validate-minimum-pruning-floor.mjs --json
   ```

   Exit codes:
   - `0` — floor satisfied; proceed to step 3.
   - `1` — `MINIMUM_PRUNING_FLOOR_VIOLATION`. FAIL enforcement; emit the
     structured gate-by-gate summary from the validator in the enforcement
     report's `## Pre-Enforcement Blockers` section and STOP. Do not
     dispatch atomicity-enforcer until the floor is satisfied.
   - `2` — unexpected error (unreadable decisions file, module import
     failure). Surface to user; investigate before retrying.

3. **Run atomic-filename convention validator (REQ-008, as-013)**

   Execute the filename-convention validator before dispatching the
   atomicity-enforcer agent. This asserts every filename under
   `<spec-group-dir>/atomic/*.md` matches one of the three canonical forms
   declared by MasterSpec Contract Registry §Atomic-Spec Filename
   Convention (`as-NNN.md`, `as-NNN-<slug>.md`, `<ws-id>-as-NNN-<slug>.md`)
   and that every `(workstream_id, atomic-id)` tuple is unique within the
   spec group.

   ```bash
   node .claude/scripts/validate-atomic-filenames.mjs <spec-group-dir> --json
   ```

   Exit codes:
   - `0` — all filenames canonical; IDs unique (AC13.1, AC13.2 accept
     case, AC13.3 no duplicates). Proceed to step 4.
   - `1` — `ATOMIC_FILENAME_VIOLATION`. FAIL enforcement; emit the
     structured per-file summary from the validator in the enforcement
     report's `## Pre-Enforcement Blockers` section and STOP. Do not
     dispatch atomicity-enforcer until the violation is remediated
     (rename offending files to a canonical form; resolve duplicates).
   - `2` — unexpected error (missing spec-group directory, unreadable
     `atomic/` subtree, bad CLI usage). Surface to user; investigate
     before retrying.

   All three canonical forms (plain / slug / legacy ws-prefixed) are
   accepted without warning per Investigation Pass 1 amendment
   inv-atomic-id-7f91e3. The validator routes every filename through
   `parseAtomicFilename` from `.claude/scripts/lib/atomic-id-schema.mjs`
   (as-011) so the accepted-form set stays in a single source of truth.

4. **Dispatch atomicity-enforcer agent**

   ```
   Task: atomicity-enforcer
   Prompt: Validate atomic specs in <spec-group-path>
   Mode: standard | strict
   ```

5. **Generate enforcement report**
   - Agent creates `enforcement-report.md` in spec group
   - Updates `manifest.json` with enforcement status

6. **Report to user**
   - Overall status (PASSING, WARNINGS, FAILING)
   - Summary of issues
   - Next steps

## Validation Criteria

### TOO_COARSE (needs splitting)

- Contains multiple distinct behaviors
- Would require multiple test suites
- Cannot partially roll back
- Reviewer needs sibling context

### TOO_GRANULAR (needs merging)

- Cannot test in isolation
- Cannot deploy meaningfully alone
- Describes code fragment, not behavior
- No standalone user value

### JUST_RIGHT (passing)

- Single testable behavior
- Deployable as standalone PR
- Reviewable without siblings
- Reversible without breaking others

### Coverage

- Every REQ-XXX must appear in at least one atomic spec

## Output

### PASSING

```
Enforcement passed for sg-logout-feature ✓

All 5 atomic specs meet atomicity criteria
Requirements coverage: 100% (4/4)

Spec group ready for user review.
Run /approve or review atomic specs in:
  .claude/specs/groups/sg-logout-feature/atomic/
```

### WARNINGS

```
Enforcement completed with warnings for sg-logout-feature

Status: WARNINGS (2 issues)

Passing: 4/5 atomic specs
Warnings:
  - as-003: Atomicity justification could be stronger

Requirements coverage: 100%

Options:
  1. Proceed to implementation (warnings are advisory)
  2. Run /atomize --refine to address warnings
  3. Run /enforce --strict to enforce stricter standards
```

### FAILING

```
Enforcement failed for sg-logout-feature ✗

Status: FAILING (3 issues)

Issues:
  - as-002: TOO_COARSE — Contains logout AND session cleanup
    → Recommend: Split into as-002a (logout), as-002b (cleanup)

  - as-005: TOO_GRANULAR — Cannot test without as-004
    → Recommend: Merge with as-004

  - MISSING_COVERAGE: REQ-003 not covered by any atomic spec
    → Recommend: Create new spec or expand existing

Next step: Run /atomize --refine to address issues
```

## Strict Mode

With `--strict`:

- All WARNINGS become FAILING
- Used before implementation to ensure maximum atomicity discipline
- Recommended for complex or high-risk features

## Integration with /atomize

The `/atomize --auto-enforce` flag creates a loop:

```
/atomize
    ↓
/enforce (automatic)
    ↓
If FAILING → /atomize --refine → /enforce
    ↓
Repeat until PASSING or max iterations
```

## State Transitions

After `/enforce`:

**If PASSING:**

- `manifest.json`:
  - `atomic_specs.enforcement_status`: "passing"
  - `atomic_specs.last_enforced`: <timestamp>
- Spec group ready for `review_state` → APPROVED

**If WARNINGS:**

- `manifest.json`:
  - `atomic_specs.enforcement_status`: "warnings"
- User decides whether to proceed or refine

**If FAILING:**

- `manifest.json`:
  - `atomic_specs.enforcement_status`: "failing"
- Must run `/atomize --refine` before implementation

## Edge Cases

### No Atomic Specs

```
Error: No atomic specs found in spec group
Run /atomize first to decompose spec.md
```

### Requirements Changed

```
Warning: requirements.md modified since last atomization
Coverage check may be inaccurate
Consider re-running /atomize
```

### Circular Dependencies Detected

```
Error: Circular dependency detected
  as-002 depends on as-003
  as-003 depends on as-002

This indicates specs are not truly atomic.
Run /atomize --refine to restructure.
```

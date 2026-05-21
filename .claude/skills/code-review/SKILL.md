---
name: code-review
description: Review implementation for code quality with style/naming, test-quality, adversarial, and holistic passes. Runs before security review. READ-ONLY - reports issues but does not fix them.
allowed-tools: Read, Glob, Grep
user-invocable: true
---

# Code Review Skill

## Purpose

Review the completed implementation for quality issues before security review.
The review is read-only and tied to one approved `spec.md`.

**Key input**: `.claude/specs/groups/<spec-group-id>/spec.md`

## Usage

```bash
/code-review <spec-group-id>
```

## Prerequisites

Before dispatch:

1. Spec group exists.
2. `/unify` has passed or produced a reviewable partial result.
3. Changed files and validation evidence are available.
4. Tests relevant to the spec have run or failures are documented.

If prerequisites are missing, stop and run `/unify` or complete the missing
validation first.

## Required Review Specialties

Every code-review report must include these four sections:

| `review_specialty` | Focus |
| ------------------ | ----- |
| `style_naming` | Redundancy, conventions, DRY, naming, API shape, local maintainability |
| `test_quality` | Assertion strength, vacuous truth, tautology, weak snapshots, isolation, determinism |
| `adversarial` | How this could pass incorrectly, false positives, happy-path bias, unproven invariants |
| `holistic` | Whole-change coherence, duplicate consolidation, severity normalization, final judgment |

Every finding must include `review_specialty`.

## Process

1. Load `manifest.json`, `spec.md`, unifier output, changed-file list, and reviewer-focus metadata when present.
2. If a dispatch retry needs prior context, read `.claude/coordination/review-dispatch-prompt-<dispatch-id>.json`.
3. Build review focus from reviewer-focus metadata, the spec's risk areas, contracts, edge cases, and validation evidence.
4. Review changed files against the four specialties.
5. Check tests for meaningful AC coverage and failure modes.
6. Normalize duplicate findings and severity.
7. Return pass/fail recommendation with concrete file references.

## Finding Format

Each finding should include:

- `severity`: `critical`, `high`, `medium`, or `low`
- `review_specialty`
- `file`
- `line`
- `issue`
- `impact`
- `recommendation`

## Output

Return:

- `status`: `pass`, `fail`, or `partial`
- `finding_count_by_severity`
- `top_blockers`
- `findings`
- `residual_risk`

After a clean pass, update convergence:

```bash
node .claude/scripts/session-checkpoint.mjs update-convergence code_review
```

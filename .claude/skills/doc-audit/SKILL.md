---
name: doc-audit
description: Documentation audit skill for diagnosing documentation health across all doc directories. Supports quick scan and deep audit levels with variable scope.
agent: doc-auditor
user-invocable: true
allowed-tools: Read, Glob, Grep
---

# Documentation Audit Skill

## Purpose

Perform read-only diagnostic audits of documentation across all known documentation directories. Identifies staleness, broken references, coverage gaps, inconsistencies, and structural quality issues. Produces machine-parseable JSON reports that feed into the remediation convergence loop via the documenter agent.

## Usage

```
/doc-audit                                    # Full codebase quick scan
/doc-audit --scope full --level deep          # Full codebase deep audit
/doc-audit --scope feature --paths <files>    # Feature-scoped audit
/doc-audit --scope multi --spec-group <id>    # Multi-feature audit by spec group
```

## Parameters

| Parameter    | Type     | Required | Default | Description                                                                                   |
| ------------ | -------- | -------- | ------- | --------------------------------------------------------------------------------------------- |
| `scope`      | string   | Yes      | `full`  | Audit scope: `feature`, `multi`, or `full`                                                    |
| `level`      | string   | No       | `quick` | Audit depth: `quick` (staleness, refs, paths) or `deep` (+ accuracy, coverage, consolidation) |
| `paths`      | string[] | No       | --      | Targeted file list (must be within known doc directories)                                     |
| `spec_group` | string   | No       | --      | Spec group ID for feature-scoped audits                                                       |
| `exclude`    | string[] | No       | --      | Paths to skip (must be within known doc directories)                                          |

## Known Documentation Directories

All paths must resolve within these canonical directories:

- `.claude/docs/` (includes `.claude/docs/structured/` via recursive glob)
- `.claude/memory-bank/`
- `docs/`
- `.claude/prds/`

## Audit Levels

### Quick Scan

Fast health check completing within 60 seconds for ~25 files:

- Git-correlated staleness detection (via pre-computed results)
- Broken cross-reference checks
- File path validity verification
- Broken external link syntax detection
- Orphan document detection

### Deep Audit

Comprehensive analysis including all quick scan checks plus:

- Code sample accuracy (file paths in code blocks resolve)
- CLI command validity (commands match package.json scripts)
- Coverage gap analysis (API surface vs documentation)
- Consolidation candidate identification (heading/keyword overlap)
- Terminology consistency (cross-doc term usage)
- Semantic staleness (described systems still exist)
- Automation candidate identification (docs generatable from code)
- Schema compliance (structured YAML docs vs schema)

## Pre-Flight Challenge

Before beginning audit work, address these operational feasibility questions:

1. Is git CLI available for staleness detection? (If not, staleness checks will be skipped with warnings)
2. Does `trace.config.json` exist for doc-to-source mapping? (If not, falls back to naming conventions)
3. Are the known documentation directories populated? (Empty dirs produce informational findings, not errors)
4. Is `.claude/audit-reports/` directory available for report persistence?

## Execution Flow

### Step 1: Pre-Computation (Orchestrator)

The orchestrating agent runs `doc-audit-checks.mjs` before dispatching the auditor:

```bash
node .claude/scripts/doc-audit-checks.mjs --scope <scope> --level <level> [--paths <paths>]
```

This produces `.claude/audit-reports/.audit-precomputed.json` with git-correlated staleness and other shell-dependent results.

### Step 2: Auditor Dispatch

The doc-auditor agent is dispatched with pre-computed results and performs read-only analysis (cross-refs, structural quality, coverage gaps).

### Step 3: Report Generation

The auditor produces a structured JSON report persisted to:

```
.claude/audit-reports/<scope>-<timestamp>.json
```

### Step 4: Remediation (if applicable)

Auto-remediable findings enter the convergence loop:

1. Batch max 10 findings (Critical first, then High, then by staleness age)
2. Dispatch to documenter with `contract-documenter-remediation-input` shape
3. Re-check updated docs + cross-referenced files
4. Exit after 2 consecutive clean passes or max 5 iterations

## Three Workflow Integration Points

### 1. PRD-Time Contextual Audit

During PRD discovery, the PRD writer can request a contextual audit:

- Runs quick scan on docs relevant to the feature under discussion
- Produces filtered summary per `contract-prd-audit-handoff`:
  - `scope`, `relevant_findings`, `summary`, `stale_docs`, `missing_coverage`
- PRD writer receives this summary as context input, not the full report

### 2. Post-Documenter Audit

After the documenter generates new documentation:

- Deep audit automatically scoped to newly generated docs
- Findings feed into convergence loop (2 clean passes, max 5 iterations)
- Workflow-embedded: preempts periodic audits on overlapping files

### 3. Periodic Comprehensive Audit

On-demand codebase-wide audit at requested depth:

- Operator invokes `/doc-audit` directly
- Checks coordination sentinels to skip files with active convergence loops
- Common cadences: weekly, per-sprint, monthly (operator discretion)

## Trigger Priority

Workflow-embedded audits (post-documenter) preempt periodic audits on overlapping files. Coordination sentinel files at `.claude/coordination/audit-active-<file-hash>` track active remediation.

## Report Format

Reports follow the `contract-audit-report` schema (JSON). See the spec for full schema definition.

## Constraints

- Auditor is strictly read-only (zero writes to doc files)
- Reports contain no raw source code (file paths and metadata only)
- Auditor findings never block workflow progression (completion-verifier is authoritative)
- Security-domain docs always escalate to human regardless of finding type
- Maximum 10 findings per remediation batch
- Convergence: 2 consecutive clean passes, max 5 iterations

## Error Handling

### Missing Git History

Staleness detection skipped for affected files with warning. Other checks continue.

### Empty Documentation Directory

Reported as informational finding ("no docs found in [path]"), not an error.

### Malformed Documents

Partial results produced with clear warnings. Never fails entirely.

## Examples

### Quick Scan (Full Codebase)

```
/doc-audit --scope full --level quick
```

Produces: `.claude/audit-reports/full-2026-04-08T12:00:00Z.json`

### Deep Audit (Feature Scope)

```
/doc-audit --scope feature --level deep --paths .claude/docs/HOOKS.md .claude/docs/structured/architecture.yaml
```

### Baseline Measurement

```
/doc-audit --scope full --level deep
```

Establishes the "before" snapshot for improvement metrics.

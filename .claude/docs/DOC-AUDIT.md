# Documentation Audit System

Read-only diagnostic auditing for documentation health across all known documentation directories. Detects staleness, broken references, coverage gaps, and structural quality issues. Produces machine-parseable JSON reports that drive automated remediation.

---

## Overview

The doc-audit system consists of:

- **Agent**: `doc-auditor` -- read-only diagnostic agent (tools: Read, Glob, Grep only)
- **Skill**: `/doc-audit` -- user-invocable command for on-demand audits
- **Pre-computation script**: `doc-audit-checks.mjs` -- git-correlated staleness and shell-dependent checks
- **Report schema**: `audit-report.schema.json` -- JSON schema for structured findings
- **Remediation**: `documenter` agent (amended with remediation input mode) fixes findings

The auditor never modifies documentation files. The completion-verifier remains the workflow gate; the auditor is the diagnostic layer that feeds into remediation.

---

## Quick Start

```bash
# Full codebase quick scan (default)
/doc-audit

# Full codebase deep audit
/doc-audit --scope full --level deep

# Feature-scoped audit
/doc-audit --scope feature --paths .claude/docs/HOOKS.md,.claude/docs/TRACES.md

# Spec-group-scoped audit
/doc-audit --scope multi --spec-group sg-current-work
```

---

## Known Documentation Directories

All audit paths must resolve within these canonical directories:

| Directory              | Contents                                    |
| ---------------------- | ------------------------------------------- |
| `.claude/docs/`        | System docs, structured YAML docs, diagrams |
| `.claude/memory-bank/` | Persistent project knowledge                |
| `docs/`                | User-facing documentation                   |
| `.claude/prds/`        | PRD files                                   |

---

## Audit Levels

### Quick Scan

Fast health check (~60 seconds for ~25 files):

- Git-correlated staleness detection
- Broken cross-reference checks (internal doc links)
- File path validity verification (paths referenced in docs exist)
- Broken external link syntax detection
- Orphan document detection (docs not referenced by any other doc)

### Deep Audit

All quick scan checks plus:

- Code sample accuracy (file paths in code blocks resolve)
- CLI command validity (commands match `package.json` scripts)
- Coverage gap analysis (API surface vs documentation)
- Consolidation candidate identification (docs with heading/keyword overlap >= 50%)
- Terminology consistency (cross-doc term usage)
- Semantic staleness (described systems still exist)
- Automation candidate identification (docs generatable from code/schemas/traces)
- Schema compliance (structured YAML docs against schema)

---

## Scope Options

| Scope     | Description                        | Typical Use                    |
| --------- | ---------------------------------- | ------------------------------ |
| `feature` | Targeted audit of specific paths   | Post-implementation spot check |
| `multi`   | Audit docs related to a spec group | Post-documenter verification   |
| `full`    | All docs in all known directories  | Periodic comprehensive audit   |

### Parameters

| Parameter    | Type     | Required | Default | Description                                   |
| ------------ | -------- | -------- | ------- | --------------------------------------------- |
| `scope`      | string   | Yes      | `full`  | `feature`, `multi`, or `full`                 |
| `level`      | string   | No       | `quick` | `quick` or `deep`                             |
| `paths`      | string[] | No       | --      | Targeted file list (within known directories) |
| `spec_group` | string   | No       | --      | Spec group ID for multi-feature audits        |
| `exclude`    | string[] | No       | --      | Paths to skip (within known directories)      |

---

## Three-State Document Lifecycle

Each document has an `_audit_state` in YAML frontmatter (defaults to `active` if absent).

```
active <-----> stale -------> archived
   ^                              |
   |______(manual only)___________|
```

### State Transitions

| From       | To         | Trigger                                                  |
| ---------- | ---------- | -------------------------------------------------------- |
| `active`   | `stale`    | Source changed after doc was last updated                |
| `active`   | `archived` | Described system no longer exists                        |
| `stale`    | `active`   | Doc updated to match current source                      |
| `stale`    | `archived` | 2 consecutive audit runs still stale, or 60-day fallback |
| `archived` | `active`   | Manual only (not automated)                              |

### Frontmatter Fields

```yaml
---
_audit_state: active # active | stale | archived
_last_audited: 2026-04-05T12:00:00Z
_source_modules: [hooks, workflow-dag]
_staleness_reason: ''
---
```

---

## Audit Report Format

Reports are persisted to `.claude/audit-reports/<scope>-<timestamp>.json` and conform to `audit-report.schema.json`.

### Report Structure

```json
{
  "report_id": "report-2026-04-05T12:00:00Z",
  "timestamp": "2026-04-05T12:00:00Z",
  "scope": "full",
  "level": "deep",
  "doc_count": 25,
  "findings": [],
  "summary": {
    "total_findings": 3,
    "by_severity": { "critical": 0, "high": 1, "medium": 2, "low": 0 },
    "by_type": {
      "stale": 1,
      "missing": 1,
      "redundant": 0,
      "inconsistent": 1,
      "structural": 0
    }
  }
}
```

### Finding Structure

Each finding has a typed ID (`<TYPE>-<NNN>` format):

```json
{
  "finding_id": "STALE-001",
  "type": "stale",
  "severity": "High",
  "file_path": ".claude/docs/HOOKS.md",
  "description": "Document not updated since source module changed",
  "evidence": "doc last modified 2026-01-15, source last modified 2026-03-20",
  "suggested_action": "Update HOOKS.md to reflect current hook registration logic",
  "auto_remediable": true,
  "related_source": [".claude/scripts/lib/workflow-dag.mjs"]
}
```

### Finding Types

| Type           | Description                                     |
| -------------- | ----------------------------------------------- |
| `stale`        | Doc content outdated relative to source         |
| `missing`      | Coverage gap -- undocumented API or feature     |
| `redundant`    | Consolidation candidate -- overlapping docs     |
| `inconsistent` | Terminology or cross-reference mismatch         |
| `structural`   | Broken links, orphan docs, malformed references |

### Severity Levels

| Severity     | Criteria                                                      |
| ------------ | ------------------------------------------------------------- |
| **Critical** | Doc describes a deleted system (immediate archival)           |
| **High**     | Source modified significantly after doc; broken critical refs |
| **Medium**   | Minor staleness; terminology inconsistency; coverage gaps     |
| **Low**      | Style suggestions; orphan docs; automation candidates         |

---

## Remediation Workflow

Auto-remediable findings enter a convergence loop with the documenter agent.

### Convergence Loop

1. Auditor produces findings report
2. Findings batched (max 10 per iteration, Critical first, then High, then by staleness age)
3. Documenter receives batch per `contract-documenter-remediation-input`
4. Documenter applies fixes and updates lifecycle frontmatter
5. Auditor re-checks updated docs and cross-referenced files
6. Loop exits after 2 consecutive clean passes (zero Critical/High findings) or max 5 iterations

### Remediation Actions by Finding Type

| Finding Type  | Documenter Action                                 |
| ------------- | ------------------------------------------------- |
| `stale`       | Update document to reflect current source state   |
| `broken_path` | Fix broken file path references                   |
| `accuracy`    | Correct inaccurate code samples or API references |
| `structural`  | Fix broken cross-references, add missing See Also |
| `coverage`    | Escalation only -- requires human scoping         |

### Security-Domain Escalation

Documents in security domains always escalate to human regardless of finding type:

- Docs with paths containing "security" or "auth"
- Docs with headings containing: security, authentication, authorization, encryption, access control, data protection

---

## Workflow Integration Points

The doc-audit system integrates at three workflow points.

### 1. PRD-Time Contextual Audit

During PRD discovery, the PRD writer can request a contextual audit of docs relevant to the feature under discussion. The auditor produces a filtered summary (`contract-prd-audit-handoff`) containing only relevant findings, stale docs, and missing coverage -- not the full report.

### 2. Post-Documenter Audit

After the documenter generates new docs, a deep audit is automatically scoped to the newly generated files. Findings feed into the remediation convergence loop. This preempts periodic audits on overlapping files.

### 3. Periodic Comprehensive Audit

On-demand codebase-wide audit invoked directly via `/doc-audit`. Checks coordination sentinels to skip files with active convergence loops. Common cadences: weekly, per-sprint, or monthly.

### Trigger Priority

Workflow-embedded audits (post-documenter) preempt periodic audits on overlapping files. Coordination sentinel files at `.claude/coordination/audit-active-<file-hash>` track active remediation.

---

## Execution Flow

### Pre-Computation (Orchestrator)

The orchestrating agent runs `doc-audit-checks.mjs` before dispatching the auditor:

```bash
node .claude/scripts/doc-audit-checks.mjs --scope full --level quick
node .claude/scripts/doc-audit-checks.mjs --scope feature --level deep --paths .claude/docs/HOOKS.md
```

This produces `.claude/audit-reports/.audit-precomputed.json` containing git-correlated staleness results, accuracy checks (deep level only), and warnings for files with missing data.

### Doc-to-Source Mapping

The system resolves each doc's source relationship using three methods in priority order:

1. **Explicit frontmatter**: `_source_modules` field in YAML frontmatter (highest priority)
2. **Trace config matching**: Doc path matched against module globs in `trace.config.json`
3. **Naming convention**: Derived from doc filename patterns (e.g., `HOOKS.md` -> `.claude/scripts/lib/hooks.mjs`)

If no method resolves, the doc is classified as orphan (age-based heuristics only).

---

## Data Minimization

Audit reports contain no raw source code. Evidence fields use metadata only (timestamps, file paths). Git metadata is limited to timestamps and changed file paths -- no author emails, commit messages, or diffs.

---

## Error Handling

| Condition               | Behavior                                                        |
| ----------------------- | --------------------------------------------------------------- |
| Git not available       | Staleness detection skipped with warning; other checks continue |
| Empty doc directory     | Informational finding ("no docs found"), not an error           |
| Malformed documents     | Partial results with clear warnings; never fails entirely       |
| Path outside known dirs | Rejected at scope validation                                    |

---

## See Also

- `.claude/agents/doc-auditor.md` -- Agent definition
- `.claude/skills/doc-audit/SKILL.md` -- Skill definition with full parameter reference
- `.claude/scripts/doc-audit-checks.mjs` -- Pre-computation script
- `.claude/specs/schema/audit-report.schema.json` -- JSON schema for report validation
- `.claude/agents/documenter.md` -- Documenter agent (remediation input mode)
- `.claude/docs/STRUCTURED-DOCS.md` -- Structured documentation system

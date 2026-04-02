# Self-Answer Protocol

Before escalating any question to the human, consult the four-tier assumption hierarchy in order. Self-resolve when evidence exists; escalate when it does not.

## Four-Tier Assumption Hierarchy

| Tier | Name      | Source                                           | Snippet Required | Precedence |
| ---- | --------- | ------------------------------------------------ | ---------------- | ---------- |
| 1    | code      | Symbol exists, test proves it, schema defines it | Yes (1 line)     | Highest    |
| 2    | spec      | Spec/PRD explicit statement                      | Yes (1 line)     |            |
| 3    | memory    | Memory-bank, traces                              | No               |            |
| 4    | reasoning | Logical inference within domain                  | No               | Lowest     |

Consult tiers in order (1 through 4). Use the answer from the highest-available tier.

## SELF-RESOLVED Format

When a source tier provides an answer, use the structured inline format:

**Tier 1-2** (snippet required):

```
SELF-RESOLVED(<tier>): <description> -- evidence: "<snippet>" @ <file>:<line>
```

**Tier 3-4** (no snippet):

```
SELF-RESOLVED(<tier>): <description>
```

Where `<tier>` is one of: `code`, `spec`, `memory`, `reasoning`.

## Escalation Boundary

**Always escalate** (never self-resolve) when:

1. **Observable behavior + reasoning only**: The question involves observable behavior (exit codes, output format, file writes, API responses, error messages, user-visible changes, stdout, stderr, return values, HTTP status) AND only tier 4 evidence exists.
2. **Cross-tier conflict**: Code says X but spec says Y. Cite both sources.
3. **Out of domain**: Question falls outside your declared Acceptable Assumption Domains.
4. **No answer found**: All four tiers consulted, none answers. Include a research trail.

Observable behavior keywords: `exit code`, `output format`, `file write`, `api response`, `error message`, `user visible`, `stdout`, `stderr`, `return value`, `http status`.

## Reasoning-Tier Soft Cap

When reasoning-tier (tier 4) self-resolutions exceed 30% of total self-resolutions in a single dispatch, emit: `RESEARCH-DEPTH-WARNING: <pct>% reasoning-tier (<count>/<total> self-resolutions)`.

## TODO(assumption) Reconciliation

- **Source consulted and answer found** -> Use `SELF-RESOLVED(<tier>)` with appropriate format.
- **No source provides an answer** -> Use `TODO(assumption): <description> [confidence: high|medium|low]` (genuinely unresolvable).

`TODO(assumption)` is reserved for cases where no tier provides evidence. If you can cite a source, use `SELF-RESOLVED` instead.

## Per-Agent Assumption Domains

Each agent declares its Acceptable Assumption Domains in its definition file (`.claude/agents/*.md`). Self-resolution via reasoning tier (tier 4) is only permitted within these declared domains. Questions outside your domain must be escalated.

## Audit Trail

All self-resolutions are written to `.claude/audit/self-resolutions.jsonl` via the shared `writeAuditEntry()` function from `self-resolution-audit.mjs`. Agents must not construct JSONL lines directly.

## Return Payload

Populate the `self_resolutions` sideband field in your return payload alongside `status`, `summary`, `blockers`, `artifacts`. Cap at 10 entries (retain highest-tier). Include `research_depth_warning` when reasoning > 30%.

## Baseline Measurement

Before protocol rollout, count escalations over 2-3 spec lifecycles to establish a quantified baseline. After rollout, compare escalation rates to measure protocol effectiveness. Track: total escalations per dispatch, escalation categories (answerable vs genuinely ambiguous), and time spent on human responses.

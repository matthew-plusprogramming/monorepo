---
name: route
description: Analyze task complexity and route to appropriate workflow. Defaults to oneoff-spec (specs are cheap, bugs are expensive). Use oneoff-vibe only for truly trivial changes or explicit user override. Use orchestrator for large multi-workstream efforts. Use journal-only for non-spec work that needs documentation.
user-invocable: true
allowed-tools: Read, Glob, Grep
---

# Route Skill

## Required Context

Before beginning work, read these files for project-specific guidelines:

- `.claude/memory-bank/best-practices/subagent-design.md`

## Purpose

Analyze the user request and determine the appropriate workflow path based on task complexity, scope, and estimated effort.

## Risk-Tier Gate Model

Route MUST emit `risk_tier`, `required_gates`, and `skipped_gates`. Stop-hook dispatch enforcement consumes `risk_tier`; `required_gates` stays in the route output to avoid duplicating derived policy in session state.

| Risk tier | Use when request touches | Target required gates |
| --- | --- | --- |
| `trust-bearing` | auth, permissions, credentials, filesystem/path/worktree safety, hooks, session state, registry/hash/sync/audit, deployment, CI, workflow enforcement | investigation, challenge, implementation, tests, e2e-if-relevant, unify, code-review, security-review, completion-verification |
| `user-visible` | UI/API/user-facing behavior | investigation, implementation, tests, e2e-if-relevant, targeted-review |
| `shared-library` | shared modules, frameworks, middleware, schemas, parsers, utilities | investigation, implementation, tests, code-review |
| `local-feature` | isolated implementation behavior | implementation, tests, targeted-review |
| `docs-prompt-metadata` | docs, prompts, agents, skills, templates, manifests, metadata | targeted-validation, policy-review-if-policy-bearing, hashes-verify-if-registered |
| `mechanical-cleanup` | typo, formatting, rename, dead-code, version bump | static-validation, affected-tests, hashes-verify-if-registered |

## Complexity Heuristics

> **Default to specs.** Use oneoff-spec unless the task is truly trivial OR the user explicitly requests to skip specs.

### Trivial (oneoff-vibe)

Route to quick execution **only when**:

**Truly trivial changes** (all must apply):

- Single-line or few-character fix (typo, off-by-one, missing semicolon)
- Zero ambiguity about what to change
- No behavioral impact beyond the obvious fix
- No tests needed or test change is equally trivial

**Examples of truly trivial**:

- Fix typo in README: "teh" → "the"
- Fix obvious syntax error
- Update version number in config
- Add missing import that's causing a build error
- Comment clarification

**User explicitly requests vibe**:

- User says: "just do it", "vibe", "skip the spec", "don't need a spec", "quick fix"
- Honor the request but note in rationale

**NOT trivial (use oneoff-spec instead)**:

- Bug fix requiring investigation
- "Simple" feature additions (even small ones have edge cases)
- Documentation updates with new content (not just typo fixes)
- Configuration changes affecting behavior
- Any change where you'd want to verify acceptance criteria

### Standard (oneoff-spec / Spec Group) — THE DEFAULT

Route to spec group workflow for **most tasks**:

- Any feature addition, enhancement, or new functionality
- Bug fixes (even "simple" ones benefit from AC definition)
- Refactoring with defined goals
- Documentation with new content
- API changes
- UI changes
- **Needs spec group**: requirements.md, spec.md
- **Spec location**: `.claude/specs/groups/<spec-group-id>/`
- **Why default**: Specs create accountability, testability, and prevent scope creep

### Large (orchestrator / MasterSpec)

> **Raised bar**: Orchestrator has high fixed overhead. Use it only above
> roughly 10 atomic specs with genuine multi-domain decomposition. Below that
> bar, oneoff-spec is the right tool.

Route to multi-workstream orchestration with git worktrees **ONLY when ALL THREE of the following are true**:

1. **10+ anticipated atomic specs** (raised from the prior "5+ files" criterion). If you cannot plausibly enumerate ≥10 atomic units of work, do not route to orchestrator.
2. **Genuine multi-domain integration** — the request meets **≥2 distinct criteria** from:
   - 3+ services (e.g., websocket server + auth + database schema)
   - Distinct test surfaces (unit, integration, e2e across independently-testable boundaries)
   - Independent contracts (wire protocols, shared schemas, API contracts with separate owners)
   - Cross-runtime boundaries (browser + server, Node + browser, multi-runtime)
   - Independently-releasable components (multi-package, separately-shippable workstreams)
3. **Tight parallelization benefit** — the work decomposes cleanly into independent workstreams with minimal cross-coupling. Sequential dependencies between most workstreams indicate orchestrator is the wrong tool.

If the request clears ALL THREE conditions, orchestrator is warranted. `/route` MUST then emit a `multi_domain_justification` field (see §Step 5) enumerating the specific criteria met with evidence anchors. See `.claude/docs/ROUTING.md` for the canonical criterion list.

**Fallback rule**: When fewer than 2 multi-domain criteria can be named with evidence, route to `oneoff-spec` with a rationale note — do NOT fake a second criterion to clear the bar.

**Supplementary signals** (necessary but NOT sufficient — these alone do NOT warrant orchestrator under the raised bar):

- 5+ files impacted across multiple layers
- Estimated effort: 4+ hours
- Cross-cutting concerns (contracts, interfaces, shared state)
- Requires parallel execution by multiple subagents

When only these signals are present without the three required conditions, default to `oneoff-spec`.

**Orchestrator mechanics** (unchanged):

- **Needs MasterSpec with workstream spec groups**: Each workstream gets its own spec group with atomic specs
- **Spec structure**: `.claude/specs/groups/<master-spec-group-id>/` with workstream subdirectories
- **Parallel execution**: Workstreams execute in isolated git worktrees
- **Dependency orchestration**: Facilitator manages merge order based on dependencies
- **MANDATORY**: Run `/investigate` before implementation to surface cross-workstream inconsistencies (env vars, API contracts, data shapes, deployment assumptions)

### Refactor (refactor workflow)

Route to refactor workflow for code quality improvements:

- Explicit refactoring requests ("refactor this", "clean up", "improve code quality")
- Tech debt reduction tasks
- Pattern migration requests ("migrate from X to Y pattern")
- Code consolidation or deduplication
- Architecture improvements without feature changes
- **Key constraint**: Behavior must be preserved (no feature changes)
- **Needs**: Clear scope definition, before/after patterns, test verification
- **Uses**: `/refactor` skill with Refactorer subagent
- **Validation**: Tests must pass before and after (behavior preservation proof)

**Refactor triggers** (route to refactor when ANY apply):

- User says: "refactor", "clean up", "improve code quality", "reduce tech debt"
- User says: "migrate to <pattern>", "consolidate", "deduplicate"
- Request focuses on code structure without changing behavior
- Request mentions: "maintainability", "readability", "consistency"

**NOT refactor** (route to oneoff-spec instead):

- "Refactor and add feature X" → oneoff-spec (behavior changes)
- "Clean up and fix this bug" → oneoff-spec (behavior changes)
- Unclear if behavior should change → oneoff-spec (spec clarifies intent)

### Journal-Only (non-spec documentation)

Route to journal-only workflow for work that doesn't need a full spec but should be documented:

**When to use journal-only**:

- Quick investigation that produced findings worth documenting
- Bug fix outside of spec work (hotfix, emergency patch)
- Ad-hoc decision that should be recorded for future reference
- Exploration that uncovered architectural insights
- One-off configuration change with rationale worth preserving

**Journal-only triggers** (route to journal-only when ANY apply):

- Work is complete but findings should be preserved
- Decision was made that future developers should know about
- Investigation uncovered non-obvious behavior or gotchas
- User says: "document this", "record this decision", "log this finding"
- Bug was fixed but root cause analysis is valuable

**Journal types**:

- **Investigation journal**: Findings from exploration, debugging, research
- **Decision record**: Architectural or design decision with rationale (uses `.claude/templates/decision-record.template.md`)
- **Hotfix journal**: Emergency fix documentation with root cause

**NOT journal-only** (route to spec workflow instead):

- Work that needs formal acceptance criteria → oneoff-spec
- Feature development (even small) → oneoff-spec
- Planned refactoring → refactor
- Work that needs review gates → oneoff-spec

**Key distinction**: Journal-only is for **documenting completed work**, not planning future work. If you need to plan and verify, use a spec.

## Routing Process

### Step 0: Check for Incomplete Work

Before analyzing a new request, check for existing incomplete work that can be resumed.

**Check for active work**:

```bash
# Check if session.json exists with active work
cat .claude/context/session.json 2>/dev/null | node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
if (data.active_work) {
  console.log(JSON.stringify(data.active_work, null, 2));
  process.exit(0);
}
process.exit(1);
"
```

**If active_work exists and is not null**, display a resume prompt:

```markdown
## Found Incomplete Work

**Objective**: [objective from session.json]
**Spec Group**: [spec_group_id]
**Phase**: [current_phase] ([progress summary])
**Last Updated**: [updated_at]

Would you like to resume this work? [Y/n]
```

**If user confirms (Y, yes, or empty/default)**:

1. Skip normal routing
2. Load the spec group manifest:
   ```bash
   cat .claude/specs/groups/<spec_group_id>/manifest.json
   ```
3. Continue from the current phase based on `current_phase` value:
   - `prd_gathering` → Continue PRD gathering with `/prd`
   - `spec_authoring` → Continue spec authoring with `/spec`
   - `atomizing` → Continue atomization with `/atomize`
   - `enforcing` → Continue enforcement with `/enforce`
   - `investigating` → Continue investigation with `/investigate`
   - `awaiting_approval` → Legacy phase (backwards compat); treat as auto_approval
   - `auto_approval` → Investigation and challenger convergence complete; proceed to implementation
   - `implementing` → Resume implementation with `/implement`, starting from next pending atomic spec
   - `testing` → Resume test writing with `/test`
   - `verifying` → Run unify validation with `/unify`
   - `reviewing` → Continue code review with `/code-review` or security review with `/security`
4. Output the appropriate next action based on phase

**If user declines (n, no, or "work on something else")**:

1. Archive the incomplete work:
   ```bash
   node .claude/scripts/session-checkpoint.mjs archive-incomplete
   ```
2. Proceed with normal routing (Step 1 onwards)

**Check for handoff documents**:

After the session.json check (regardless of its result), also check for handoff documents in `context/archive/`:

```bash
# List handoff documents, most recently modified first (silently skip if directory missing)
ls -t .claude/context/archive/*.md 2>/dev/null
```

**If handoff documents exist**, display them alongside the session.json resume prompt:

```markdown
## Handoff Context Available

**Most Recent**: [filename]
**Title**: [first `# Handoff:` heading line from the file]
**Path**: `.claude/context/archive/[filename]`

[If additional handoff docs exist:]
Other handoff documents:

- [filename2]
- [filename3]

Read the handoff document for full context before resuming work.
```

To extract the title from the most recent handoff document:

```bash
# Get the title line from the most recent handoff doc
head -30 "$(ls -t .claude/context/archive/*.md 2>/dev/null | head -1)" 2>/dev/null | grep "^# Handoff:"
```

**If no handoff documents exist or the directory is missing**, silently skip this check (no error, no message).

### Step 1: Load Context

If the user references an existing spec group:

```bash
# Check for active spec group
ls .claude/specs/groups/<spec-group-id>/manifest.json 2>/dev/null
```

Load the spec group and continue from its current state based on `review_state` and `work_state`.

### Step 1b: Read Architectural Trace (if available)

Read `.claude/traces/high-level.md` for module landscape context before analyzing scope. This is permitted under the Pre-Computed Summary Exception -- trace files are automation-generated summaries, not source code.

```bash
# Read high-level trace if it exists (graceful degradation if not)
cat .claude/traces/high-level.md 2>/dev/null
```

If the file exists, use the module landscape, dependency graph, and export summaries to inform:

- Which modules are affected by the user's request
- Cross-module dependency relationships that affect scope estimation
- Available exports that may be relevant to the task

If the file does not exist, proceed without trace context -- no error or warning needed.

### Step 1c: Trace-Informed Impact Analysis

After reading `high-level.md`, perform structured impact analysis using `high-level.json` for precise dependency data.

**1. Read and validate `high-level.json`**:

Use the Read tool to load `.claude/traces/high-level.json` directly (NOT via Bash/CLI -- Route does not have Bash access).

**2. Validate trace integrity before consumption**:

Before using trace data for routing decisions, verify that the `generatedBy` and `lastGenerated` fields are present and plausible:

- `generatedBy` must be a non-empty string
- `lastGenerated` must be a valid ISO 8601 timestamp, not in the future, and not unreasonably old (> 1 year)

If validation fails, proceed without trace data (conservative fallback). Do NOT block routing.

**3. Parse module dependencies**:

The `high-level.json` `modules` array contains flat string arrays for `dependencies` and `dependents`:

```json
{
  "modules": [
    {
      "id": "scripts-lib",
      "name": "Shared Libraries",
      "dependencies": [],
      "dependents": ["docs-scripts", "trace-scripts"]
    }
  ]
}
```

**4. Identify affected modules**:

Map the user's request (file paths, keywords, module names) to modules in `high-level.json`:

- Match file paths against module `fileGlobs` (from `trace.config.json`) or module names
- For each affected module, note its `dependencies` and `dependents`
- Count total affected modules (direct + transitive dependents up to depth 2)

**5. Use module count for workflow complexity**:

| Affected Modules                    | Suggested Workflow                  |
| ----------------------------------- | ----------------------------------- |
| 1 module, simple change             | oneoff-vibe (if truly trivial)      |
| 1-2 modules                         | oneoff-spec                         |
| 3+ modules or deep dependency chain | oneoff-spec (consider orchestrator) |
| 4+ modules across multiple layers   | orchestrator                        |

**6. (Optional) Deeper analysis via low-level traces**:

For deeper impact analysis, read the affected module's low-level trace JSON at `.claude/traces/low-level/<module-id>.json` to examine:

- Specific exports that might be affected
- Downstream callers (from `calls[]` arrays)
- Cross-module function references

This is pure file reading (Read tool) -- no Bash/CLI execution needed.

### Step 2: Analyze Scope

Use Glob and Grep to understand impact:

```bash
# Find relevant files
glob "**/*.ts" | grep -i "<keyword>"

# Understand current architecture
grep -r "class <Name>" --include="*.ts"
```

### Step 3: Apply Heuristics

Count impacted files and assess complexity:

- **File count**: How many files need changes?
- **Coupling**: Are changes isolated or cross-cutting?
- **Unknowns**: How many open questions exist?
- **Testing**: What test coverage is needed?

### Step 4: Analyze Delegation Opportunities

**Delegation is the default.** Before making a routing decision, analyze whether the task can be decomposed into independent subtasks for parallel subagent execution:

**Always delegate when**:

- Task has 2+ independent components that can run in parallel
- Exploration/research is needed before implementation
- Multiple files need changes that don't depend on each other
- Code review, security review, or testing can run in parallel

**Delegation analysis checklist**:

1. Can parts of this work run independently? → Dispatch parallel subagents
2. Is exploration needed first? → Dispatch Explore subagent before deciding scope
3. Are there isolated concerns? → Dispatch specialized subagents (impl, test, review)
4. Would main-context benefit from delegation? → Always yes for non-trivial tasks

**Do NOT delegate only when**:

- Single-file typo/config fix (oneoff-vibe)
- Task requires tight coordination that subagents can't provide
- User explicitly requests direct execution

### Step 5: Make Routing Decision

Produce a routing decision with delegation plan:

```yaml
workflow: oneoff-vibe | oneoff-spec | orchestrator | refactor | journal-only
risk_tier: trust-bearing | user-visible | shared-library | local-feature | docs-prompt-metadata | mechanical-cleanup
runtime_validation_required: true | false
runtime_validation_surface: plugin | mcp | connector | browser-extension | dynamic-tool-body | plugin-loader | other | null
runtime_validation_rationale: <required when runtime_validation_required=true>
rationale: <Brief explanation of why this workflow was chosen>
estimated_scope: small | medium | large
estimated_files: <N>
required_gates:
  - <gate-name>
skipped_gates:
  - <gate-name>: <why not required for this risk tier>
# REQUIRED when workflow=orchestrator; FORBIDDEN otherwise.
# Enumerate ≥2 distinct multi-domain criteria with evidence anchors. If fewer
# than 2 criteria can be named with evidence, fall back to oneoff-spec (do NOT
# fake a second criterion to clear the bar). Canonical criterion list lives in
# .claude/docs/ROUTING.md.
multi_domain_justification: # Orchestrator-only (omit for other workflows)
  - criterion: <one of: "3+ services" | "distinct test surfaces" | "independent contracts" | "cross-runtime boundaries" | "independently-releasable components">
    evidence: <one-line anchor, e.g., "websocket-server + auth + notification-service">
  - criterion: <second distinct criterion>
    evidence: <its one-line anchor>
decomposition:
  human_provided: true | false # Did the human provide explicit task breakdown?
  atomizer_needed: true | false # Only for orchestrator workflows. Always false for oneoff-spec.
  # When human_provided is true: skip /atomize, use the provided structure directly
  # When atomizer_needed is true (orchestrator only): run /atomize after spec authoring
delegation:
  parallel_subtasks:
    - <subtask 1>: <subagent type>
    - <subtask 2>: <subagent type>
  sequential_dependencies:
    - <subtask that must complete first>
  exploration_needed: true | false
  investigation_required: true | false # MANDATORY true for orchestrator AND oneoff-spec
workstreams:
  - <workstream 1> (for orchestrator only)
  - <workstream 2>
investigation_scope: <spec-group-id | master-spec-id | null>
trace_context: # Include when trace data is available
  affected_modules:
    - <module-id>: <brief description of impact>
  recommended_trace_reads:
    - .claude/traces/low-level/<module-id>.json # for each affected module
  dependency_depth: <N> # number of transitive dependency levels
next_action: <Suggested next step>
```

**Record the decision (MANDATORY)**: After producing the decision block above, the main-agent MUST persist the decision to `session.json.active_work.route_decisions[]` via the sole-writer CLI:

```bash
# Non-orchestrator workflows:
node .claude/scripts/session-checkpoint.mjs record-route-decision <workflow> "<rationale>" --risk-tier <risk_tier>

# Orchestrator workflow (justification required):
node .claude/scripts/session-checkpoint.mjs record-route-decision orchestrator "<rationale>" --risk-tier <risk_tier> \
  --multi-domain-justification '[{"criterion":"3+ services","evidence":"..."},{"criterion":"cross-runtime boundaries","evidence":"..."}]'
```

This append-only log is consumed by `.claude/scripts/metrics/pipeline-efficiency-routing-thresholds-collect.mjs` to measure routing distribution. `--risk-tier` also writes `active_work.risk_tier` for Stop-hook dispatch requirements. Rationale is truncated to 120 chars. Invoke **after** the decision block and **before** any phase transition (e.g., `start-work`).

**Orchestrator fallback enforcement**: If `/route` cannot name ≥2 criteria with evidence for a would-be orchestrator recommendation, emit `workflow: oneoff-spec` instead, with a rationale note explaining the insufficient warrant. Do NOT emit `workflow: orchestrator` without the `multi_domain_justification` field — the CLI rejects that shape with `ROUTE_DECISION_JUSTIFICATION_REQUIRED`.

**Dispatch prompt enrichment**:

When dispatching subagents (implementer, test-writer, etc.), include trace context in the dispatch prompt:

- **Module impact summary**: List the modules affected and their dependency relationships
- **Recommended trace reads**: Specify which low-level traces the subagent should read before editing files (e.g., "Before editing `trace-utils.mjs`, read `.claude/traces/low-level/scripts-lib.json` for the module's export surface and call graph")
- **Cross-module dependencies**: Note which modules depend on the ones being changed, so the subagent can assess blast radius

**Example dispatch prompt enrichment**:

```
Trace Context:
  Affected modules: scripts-lib (direct), trace-scripts (dependent), docs-scripts (dependent)
  Read these traces before implementation:
    - .claude/traces/low-level/scripts-lib.json (primary module)
    - .claude/traces/low-level/trace-scripts.json (downstream dependent)
  Dependency depth: 2 (scripts-lib -> trace-scripts -> script-tests)
```

If trace data is unavailable or integrity validation failed, omit the `trace_context` section entirely and proceed without it. Trace enrichment is additive -- never block dispatch on missing traces.

**Decomposition rules**:

- For **oneoff-spec**: `atomizer_needed` is always `false`. Specs go directly to approval without atomization.
- For **orchestrator**: If the user provides explicit task breakdown → `human_provided: true`, `atomizer_needed: false`. If scope is ambiguous → `human_provided: false`, `atomizer_needed: true`.
- When `atomizer_needed: true` (orchestrator only), run `/atomize` + `/enforce` after spec authoring.
- The atomizer is reserved for **orchestrator workflows with ambiguous scope**. For oneoff-spec, the spec itself is the atomic unit — no decomposition needed.

**Investigation rules**:

- `orchestrator`: Investigation is MANDATORY before implementation (mode: `standard`)
- `oneoff-spec`: Investigation is MANDATORY before implementation (mode: `single-spec`). Dispatches interface-investigator with `mode: "single-spec"` which constrains to Category 7 (intra-spec consistency), env/dependency validation, and external integration surface checks. Completes in one pass.
- `oneoff-vibe`, `refactor`, `journal-only`: Investigation typically not needed

### Step 6: Initialize Active Work

**For non-trivial workflows (oneoff-spec, orchestrator, refactor)**, initialize active work tracking:

```bash
# Start work tracking for spec-based workflows (positional form)
# <spec_group_id> is generated during routing (e.g., "logout-button-20260121")
# <workflow> is the routing decision (oneoff-spec, orchestrator)
# <objective> is a brief description of the user's request
node .claude/scripts/session-checkpoint.mjs start-work <spec_group_id> <workflow> "<objective>"
```

This enables resume detection (Step 0) if the session is interrupted.

**Example**:

```bash
node .claude/scripts/session-checkpoint.mjs start-work "logout-button-20260121" "oneoff-spec" "Add logout button to the user dashboard"
```

### Exempt workflows (oneoff-vibe, refactor, journal-only)

All exempt workflows still require positive active-work registration via the
`--exempt-workflow` flag-only form:

```bash
# Vibe-mode, refactor, and journal-only workflows use the flag-only form.
# No positional args required — spec_group_id is auto-generated ("vibe-<ISO>")
# and the objective is derived from the user prompt.
node .claude/scripts/session-checkpoint.mjs start-work --exempt-workflow oneoff-vibe
node .claude/scripts/session-checkpoint.mjs start-work --exempt-workflow refactor
node .claude/scripts/session-checkpoint.mjs start-work --exempt-workflow journal-only
```

The positive assertion lets `workflow-gate-enforcement.mjs` and
`workflow-stop-enforcement.mjs` distinguish an intentional exempt session from
missing active-work state.

Environment contract:

- `CLAUDE_USER_PROMPT` (optional) — first line truncated to 120 chars becomes the auto-generated objective. Fallback: "ad-hoc vibe-mode task".
- `workflow_set_by` is set to `"route-skill"` automatically when the flag form is used.

Inherit semantics: if the session already has `active_work.workflow === W` and
`W ∈ EXEMPT_WORKFLOWS`, the call is a no-op and exits 0 with a
`work_started_already_active` audit entry. Downgrade from a non-exempt workflow
is rejected; use `complete-work` first.

## Edge Cases

### Ambiguous Complexity

When uncertain about task size:

- **Default to oneoff-spec** — specs are cheap, debugging without specs is expensive
- If task seems trivial but has any ambiguity → oneoff-spec
- Can escalate to orchestrator if spec reveals hidden complexity
- Better to "over-spec" a simple task than "under-spec" a complex one

### User Override

If user explicitly requests a workflow:

- "Just do it", "vibe", "quick fix", "skip spec" → oneoff-vibe (honor request, note in rationale)
- "Write a full spec first" → oneoff-spec or orchestrator
- User preference always wins, but default assumption is: user wants quality (specs)

### In-Flight Orchestrator Work

The raised orchestrator bar applies only to new `/route` invocations. Existing
orchestrator spec groups retain their workflow and continue without
re-evaluation.

Rule:

- If `.claude/specs/groups/<spec-group-id>/manifest.json` records `workflow: orchestrator`, that spec group continues under its existing workflow. No migration, no re-routing, no reclassification.
- Subsequent `/route` invocations apply the new heuristic and the raised bar; in-flight spec groups are not reclassified.
- The persistent `workflow` field in manifest.json is authoritative for in-flight work; it is not re-evaluated against the raised bar.
- Migration scope: the heuristic applies to new /route invocations only; existing orchestrator spec groups remain on the old heuristic until they complete.

In practice: if the operator resumes work on an existing orchestrator spec group, `/route` should detect the existing manifest (per §Existing Spec Group below) and continue from its current phase without applying the raised bar to the already-assigned workflow.

See `.claude/docs/ROUTING.md` §Migration Guidance for the full backwards-compatibility rationale.

### Existing Spec Group

If `.claude/specs/groups/<spec-group-id>/manifest.json` exists:

- Check `review_state` and `work_state` fields in manifest
- **review_state**:
  - `DRAFT` → Continue spec authoring or atomization
  - `REVIEWED` → Awaiting user approval
  - `APPROVED` → Route to implementation
- **work_state**:
  - `PLAN_READY` → Ready for implementation
  - `IMPLEMENTING` → Continue implementation
  - `VERIFYING` → Run unify validation
  - `READY_TO_MERGE` → Proceed to code review, security review

## Output Format

Always output a clear routing decision:

```markdown
## Routing Decision

**Workflow**: oneoff-spec
**Risk Tier**: user-visible
**Required Gates**: investigation, implementation, tests, e2e-if-relevant, targeted-review
**Skipped Gates**: security-review (not trust-bearing), completion-verification (not required by target gate plan)

**Rationale**: This task adds a user-visible dashboard loading state with clear UI behavior and testable acceptance criteria. It does not touch auth, filesystem safety, registry/sync, hooks, or deployment.

**Estimated Scope**: medium

**Estimated Files**: 3 (component, styles, tests)

**Next Action**: Use `/prd` skill to clarify loading behavior, then create TaskSpec.
```

For refactor workflows, include behavior preservation note:

```markdown
## Routing Decision

**Workflow**: refactor
**Risk Tier**: shared-library
**Required Gates**: investigation, implementation, tests, code-review

**Rationale**: Explicit refactoring request to migrate to repository pattern. No behavior changes - code reorganization only.

**Estimated Scope**: medium

**Estimated Files**: 4 (service, repository, interface, tests)

**Behavior Preservation**: Tests must pass before and after refactoring.

**Next Action**: Use `/refactor` skill to define scope and patterns.
```

For journal-only workflows, specify the journal type:

```markdown
## Routing Decision

**Workflow**: journal-only
**Risk Tier**: docs-prompt-metadata
**Required Gates**: targeted-validation

**Rationale**: Investigation into memory leak is complete. Findings (root cause in event listener cleanup) should be documented for future reference.

**Journal Type**: investigation

**Next Action**: Create investigation journal documenting the findings and resolution.
```

## Integration with Other Skills

After routing:

- **oneoff-vibe**: Proceed directly to implementation (exempt from completion verification gates)
- **oneoff-spec**: `/prd` → `/spec` → `/investigate` (mode: single-spec) → user approval → `/challenge` (pre-implementation) → `/implement` + `/test` + `/e2e-test` unless opted out → `/unify` → reviews/completion/docs/manual as required by current enforcement and the emitted risk-tier gate plan
- **orchestrator**: `/prd` → `/spec` MasterSpec/workstreams → per-workstream `/atomize` + `/enforce` → `/investigate` → user approval → `/challenge` (pre-orchestration) → facilitator parallel execution → `/unify` → reviews/completion/docs/manual as required by current enforcement and the emitted risk-tier gate plan
- **refactor**: Use `/refactor` skill → Define scope and patterns → Run tests (baseline) → Execute refactoring → Run tests (verification) → `/code-review` → `/security` (if applicable)
- **journal-only**: Create appropriate journal entry → For decisions: use decision-record template at `.claude/templates/decision-record.template.md` → For investigations: document findings, root cause, resolution → For hotfixes: document fix, root cause, prevention measures → Store in `.claude/journal/entries/` directory

### Default E2E Dispatch

The `e2e-test-writer` subagent is dispatched by default for all spec-based workflows (oneoff-spec and orchestrator). Specs opt out by setting `e2e_skip: true` with a valid `e2e_skip_rationale` in frontmatter. The stop hook enforces this: sessions cannot complete without an `e2e-test-writer` dispatch unless the spec has a valid opt-out.

### Runtime Manual-Test Dispatch

Set `runtime_validation_required: true` when the request touches runtime-loaded
plugin behavior: plugins, MCP tools, connectors, browser extensions, plugin
loaders, dynamic tool/body resolution, or similar boot/invocation surfaces. The
spec frontmatter must include `runtime_validation_surface` and
`runtime_validation_rationale`. The Stop hook then requires `/manual-test` with a
structured passing result before terminal completion. For other specs, keep the
marker absent or false and `/manual-test` remains advisory.

### Investigation Checkpoint

The `/investigate` skill surfaces inconsistencies that would otherwise become runtime bugs:

- **Env var naming**: GIT_SSH_KEY_PATH vs GIT_SSH_KEY_BASE64 conflicts
- **API contracts**: Hardcoded URLs vs discovery patterns, path inconsistencies
- **Data shapes**: Field naming conventions, required vs optional mismatches
- **Deployment assumptions**: CDK vs Terraform, SSM vs .env conflicts
- **Missing fields**: Template completeness across workstreams

Investigation is MANDATORY before implementation for both orchestrator and oneoff-spec workflows. For orchestrator, use `mode: "standard"` (full cross-spec). For oneoff-spec, use `mode: "single-spec"` (Category 7 + env/dep validation + external surfaces, one pass). The `investigation_scope` for oneoff-spec defaults to the spec group ID.

## Examples

Canonical quick examples:

- Typo in README → `oneoff-vibe`, `mechanical-cleanup`, no delegation.
- Loading spinner on submit button → `oneoff-spec`, `user-visible`, implementer + test-writer.
- Real-time notifications across WebSocket/frontend/DB/auth → `orchestrator`, `trust-bearing`, workstreams + full gate plan.

> Additional edge-case examples (orchestrator-with-findings, exploration-first, user-vibe-override, refactor, refactor-with-feature, journal-only, not-journal-only) live in `./EXAMPLES.md`.

---
name: route
description: Analyze task complexity and route to the appropriate workflow. Use oneoff-vibe for truly trivial work, clear bounded low-risk edits, or explicit user override. Default to oneoff-spec for behavior, policy, integration, verification risk, and large work. Use journal-only for non-spec work that needs documentation.
user-invocable: true
allowed-tools: Read, Glob, Grep
---

# Route Skill

## Required Context

Before beginning work, read these files for project-specific guidelines:

- `.claude/memory-bank/best-practices/subagent-design.md`
- `.claude/docs/ROUTING.md`

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

> **Lower vibe barrier for low-risk work.** Use oneoff-vibe when the request is clear, bounded, and low-risk. Use oneoff-spec when the request needs acceptance criteria, has meaningful behavior/policy risk, or leaves open questions.

### Lightweight (oneoff-vibe)

Route to quick execution when any of these apply:

**Truly trivial changes** (all must apply):

- Single-line or few-character fix (typo, off-by-one, missing semicolon)
- Zero ambiguity about what to change
- No behavioral impact beyond the obvious fix
- No tests needed or test change is equally trivial

**Bounded low-risk edits** (all must apply):

- Clear requested outcome with no unresolved product, design, security, or architecture decision
- Small scope, typically 1-3 files and one concern
- No trust-bearing surface: auth, permissions, credentials, hooks, session state, registry/hash/sync/audit, filesystem/worktree safety, deployment, or CI
- No public API contract, schema, cross-runtime integration, or shared-library behavior change
- Validation is direct and targeted: static check, affected test, diff inspection, or docs/prompt review

**Examples of truly trivial**:

- Fix typo in README: "teh" → "the"
- Fix obvious syntax error
- Update version number in config
- Add missing import that's causing a build error
- Comment clarification

**Examples of bounded low-risk**:

- Tighten README wording or fix a broken docs link
- Adjust non-policy prompt wording or agent instructions for clarity
- Rename an internal label in one local fixture
- Add or remove a temporary debug log at the user's request
- Update a small test fixture where expected behavior is unchanged

**User explicitly requests vibe**:

- User says: "just do it", "vibe", "skip the spec", "don't need a spec", "quick fix"
- Honor the request but note in rationale

**NOT trivial (use oneoff-spec instead)**:

- Bug fix requiring investigation
- "Simple" feature additions (even small ones have edge cases)
- Documentation or prompt updates that change policy, workflow obligations, or operator behavior
- Configuration changes affecting behavior
- Any change where you'd want to verify acceptance criteria

### Standard (oneoff-spec / Spec Group) — THE DEFAULT

Route to spec group workflow for **most tasks, including large ones**:

- Any feature addition, enhancement, or new functionality
- Bug fixes (even "simple" ones benefit from AC definition)
- Refactoring with defined goals
- Documentation with new content
- API changes
- UI changes
- Large or integration-heavy efforts that need contracts, dependency ordering, or parallel subagent execution
- **Needs spec group**: requirements.md, spec.md
- **Spec location**: `.claude/specs/groups/<spec-group-id>/`
- **Why default**: Specs create accountability, testability, and prevent scope creep

### Large (oneoff-spec with stronger planning)

Use `oneoff-spec`, not a separate coordination workflow, for large efforts.
The spec should carry the coordination load directly with clear task slices,
contracts, dependencies, test surfaces, and merge/order notes.

Large-scope signals:

- 5+ files impacted across multiple layers
- Estimated effort: 4+ hours
- Cross-cutting concerns (contracts, interfaces, shared state)
- Requires parallel execution by multiple subagents
- 3+ services or cross-runtime boundaries
- Distinct test surfaces or independently releasable components

For these cases, emit `workflow: oneoff-spec`, `estimated_scope: large`, and
include a concrete delegation plan. If the request has independent slices,
use parallel subagents under the one spec rather than a separate decomposition step.

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
   - `investigating` → Continue investigation with `/investigate`
   - `awaiting_approval` → Legacy phase (backwards compat); treat as auto_approval
   - `auto_approval` → Investigation and challenger convergence complete; proceed to implementation
   - `implementing` → Resume implementation with `/implement`, starting from the next incomplete task or spec slice
   - `testing` → Resume test writing with `/test`
   - `verifying` → Run unify validation with `/unify`
   - `reviewing` → Continue code review with `/code-review` or security review with `/security`
4. Output the appropriate next action based on phase

**If user declines (n, no, or "work on something else")**:

1. Do **not** archive the existing work unless the operator explicitly wants to
   abandon it.
2. For unrelated work that should progress concurrently, create a lightweight
   git worktree and continue routing from inside that worktree. This gives the
   new foreground task its own worktree-local `session.json`, `active_work`, and
   hooks.
3. For a same-checkout focus change where only one foreground task will run,
   use `switch-work <work_id>` for an existing stored work item or positional
   `start-work ... --switch-from-current` for a new spec workflow.

Archive only when the operator explicitly wants to abandon the current work:

```bash
node .claude/scripts/session-checkpoint.mjs archive-incomplete
```

**Concurrent foreground worktree pattern**:

```bash
repo_root="$(git rev-parse --show-toplevel)"
repo_name="$(basename "$repo_root")"
slug="<short-task-slug>"
git worktree add "../${repo_name}-${slug}" -b "work/${slug}"
cd "../${repo_name}-${slug}"
wt_root="$(git rev-parse --show-toplevel)"
cd "$wt_root"
export CLAUDE_PROJECT_DIR="$wt_root"
test -f .claude/scripts/session-checkpoint.mjs
```

After this point, every checkpoint command in the new task MUST use the
worktree-local relative path:

```bash
node .claude/scripts/session-checkpoint.mjs <operation> ...
```

Do not call an absolute `session-checkpoint.mjs` path from another checkout and
do not leave `CLAUDE_PROJECT_DIR` pointing at the parent worktree.

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

- Single-file typo/config fix or bounded low-risk edit (oneoff-vibe)
- Task requires tight coordination that subagents can't provide
- User explicitly requests direct execution

### Step 5: Make Routing Decision

Produce a routing decision with delegation plan:

```yaml
workflow: oneoff-vibe | oneoff-spec | refactor | journal-only
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
decomposition:
  human_provided: true | false # Did the human provide explicit task breakdown?
  spec_slices:
    - <independent slice or work package inside the one spec>
delegation:
  parallel_subtasks:
    - <subtask 1>: <subagent type>
    - <subtask 2>: <subagent type>
  sequential_dependencies:
    - <subtask that must complete first>
  exploration_needed: true | false
  investigation_required: true | false # MANDATORY true for oneoff-spec
investigation_scope: <spec-group-id | null>
next_action: <Suggested next step>
```

**Record the decision (MANDATORY)**: After producing the decision block above, first initialize or switch to the target active work item in Step 6, then persist the decision to `session.json.active_work.route_decisions[]` via the sole-writer CLI:

```bash
node .claude/scripts/session-checkpoint.mjs record-route-decision <workflow> "<rationale>" --risk-tier <risk_tier>
```

This append-only log is consumed by `.claude/scripts/metrics/pipeline-efficiency-routing-thresholds-collect.mjs` to measure routing distribution. `--risk-tier` also writes `active_work.risk_tier` for Stop-hook dispatch requirements. Rationale is truncated to 120 chars. Invoke **after** `start-work`/`switch-work` has selected the target active work item and **before** later phase transitions.

**Decomposition rules**:

- For **oneoff-spec**: use `spec_slices` in the route output when the work can be parallelized. The spec itself remains the single contract.
- When the user provides explicit task breakdown, preserve it directly in `spec_slices` and the delegation plan.
- Do not run separate decomposition or atomicity-validation steps for new work. Keep decomposition as lightweight spec structure, not separate files.

**Investigation rules**:

- `oneoff-spec`: Investigation is MANDATORY before implementation (mode: `single-spec`). Dispatches interface-investigator with `mode: "single-spec"` which constrains to Category 7 (intra-spec consistency), env/dependency validation, and external integration surface checks. Completes in one pass.
- `oneoff-vibe`, `refactor`, `journal-only`: Investigation typically not needed

### Step 6: Initialize Active Work

**For non-trivial workflows (oneoff-spec, refactor)**, initialize active work tracking:

```bash
# Start work tracking for spec-based workflows (positional form)
# <spec_group_id> is generated during routing (e.g., "logout-button-20260121")
# <workflow> is the routing decision (usually oneoff-spec)
# <objective> is a brief description of the user's request
node .claude/scripts/session-checkpoint.mjs start-work <spec_group_id> <workflow> "<objective>"
```

If another work item is already active in this checkout and the new work should
run concurrently, first create a lightweight worktree using the Step 0 pattern,
then run `start-work` from that worktree root.

For a same-checkout focus change where only one foreground task will run,
preserve the current spec workflow and switch focus atomically:

```bash
node .claude/scripts/session-checkpoint.mjs start-work <spec_group_id> <workflow> "<objective>" --switch-from-current
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

If another work item is already active and exempt work should run concurrently,
create a lightweight git worktree first, then run the flag-only command from the
new worktree root. Do not archive the original work to make room.

The positive assertion lets `workflow-gate-enforcement.mjs` and
`workflow-stop-enforcement.mjs` distinguish an intentional exempt session from
missing active-work state.

Environment contract:

- `CLAUDE_USER_PROMPT` (optional) — first line truncated to 120 chars becomes the auto-generated objective. Fallback: "ad-hoc vibe-mode task".
- `workflow_set_by` is set to `"route-skill"` automatically when the flag form is used.

Inherit semantics: if the session already has `active_work.workflow === W` and
`W ∈ EXEMPT_WORKFLOWS`, the call is a no-op and exits 0 with a
`work_started_already_active` audit entry. Starting exempt work while a
different workflow is active should use a separate lightweight worktree unless
the operator is intentionally ending or switching the current checkout's focus.

## Edge Cases

### Ambiguous Complexity

When uncertain about task size:

- **Use oneoff-vibe for clear bounded low-risk tasks** — avoid spec ceremony when the scope and validation are obvious
- If task seems lightweight but has ambiguity, behavior risk, or policy risk → oneoff-spec
- If spec reveals hidden complexity, keep the workflow as oneoff-spec and enrich the spec/delegation plan
- Better to "over-spec" a risky task than "under-spec" a complex one

### User Override

If user explicitly requests a workflow:

- "Just do it", "vibe", "quick fix", "skip spec" → oneoff-vibe (honor request, note in rationale)
- "Write a full spec first" → oneoff-spec
- User preference always wins, but default assumption is: user wants quality (specs)

### Existing Spec Group

If `.claude/specs/groups/<spec-group-id>/manifest.json` exists:

- Check `review_state` and `work_state` fields in manifest
- **review_state**:
  - `DRAFT` → Continue spec authoring
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
- **refactor**: Use `/refactor` skill → Define scope and patterns → Run tests (baseline) → Execute refactoring → Run tests (verification) → `/code-review` → `/security` (if applicable)
- **journal-only**: Create appropriate journal entry → For decisions: use decision-record template at `.claude/templates/decision-record.template.md` → For investigations: document findings, root cause, resolution → For hotfixes: document fix, root cause, prevention measures → Store in `.claude/journal/entries/` directory

### Default E2E Dispatch

The `e2e-test-writer` subagent is dispatched by default for oneoff-spec. Specs opt out by setting `e2e_skip: true` with a valid `e2e_skip_rationale` in frontmatter. The stop hook enforces this: sessions cannot complete without an `e2e-test-writer` dispatch unless the spec has a valid opt-out.

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
- **Missing fields**: Template completeness across related spec slices

Investigation is MANDATORY before implementation for oneoff-spec workflows. Use `mode: "single-spec"` (Category 7 + env/dep validation + external surfaces, one pass). The `investigation_scope` defaults to the spec group ID.

## Examples

Canonical quick examples:

- Typo in README → `oneoff-vibe`, `mechanical-cleanup`, no delegation.
- Loading spinner on submit button → `oneoff-spec`, `user-visible`, implementer + test-writer.
- Real-time notifications across WebSocket/frontend/DB/auth → `oneoff-spec`, `trust-bearing`, spec slices + full gate plan.

> Additional edge-case examples live in `./EXAMPLES.md`.

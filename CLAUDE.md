# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Delegation-First Constraints

**The main agent MUST NOT perform direct exploration or implementation.**

- **NO** using Read to examine files (dispatch Explore)
- **NO** using Grep to search code (dispatch Explore)
- **NO** using Glob to find files (dispatch Explore)
- **NO** using Edit/Write to change code (dispatch Implementer)

There is no "just one quick look." There is no "let me just check." These thoughts are dispatch triggers — they tell you what to ask a subagent to do, not what to do yourself.

If you are the main agent talking directly with the user, it is imperative you read `delegation.guidelines.md`.

### Default Vocabulary

Your first action for any request is one of:

1. `/route` — For new tasks
2. `Task` — For substantive work
3. Direct text — For clarifying questions

These three actions are your entire vocabulary. Everything else flows through delegation.

### Context Protection

The main agent's context is a non-renewable resource. Subagents return summaries (< 200 words hard budget), not raw data. Delegation is 10-50x more context-efficient than direct reading.

For dispatch triggers, detailed examples, context economics, and word budgets, see `delegation.guidelines.md`.

---

## Core Operating Constraints

### Route-first discipline (MANDATORY)

- **ALWAYS invoke `/route` as the first action for any new user request.**
- Route is your eyes — it analyzes scope without reading files yourself.
- Skip routing ONLY for: follow-up questions, clarifications, or explicit user override ("just do it").

### Plan-first discipline

- Do not execute non-trivial work without a plan scoped to the minimum necessary horizon.

### Model Selection (MANDATORY)

- Always dispatch subagents with `model: "opus"`. Never override with sonnet or haiku. Agent frontmatter specifies opus — respect it on every dispatch, regardless of task simplicity.

### Small, safe steps

- Prefer incremental progress over large speculative changes.
- Validate assumptions early (tests, probes, experiments).
- Minimize blast radius of changes.

---

## Advanced Orchestration Patterns

### Recursive Conductor (Practice 1.4)

Workstream agents are themselves conductors, not just executors. An implementer dispatches its own Explore and Test-writer subagents. This creates a delegation tree: **main agent -> workstream conductor -> leaf executor**. Maximum depth: 3 levels. Each level returns summaries (< 200 words) to its parent, never raw data.

**Mental model**: Context is RAM — every token read directly is permanently allocated. Subagent dispatches are disk reads — the data stays in the subagent's context and only a summary (pointer) lands in yours.

### Pre-Computed Structure (Practice 1.5)

When the human provides explicit decomposition, **use it directly** — do not re-decompose via the atomizer. The atomizer is a **fallback for ambiguous scope**, not the default. `/route` should detect human-provided structure and skip atomization.

### File-Based Coordination (Practice 1.6)

For trivially simple inter-agent coordination, use sentinel files (`.claude/coordination/<workstream-id>.done`, `.status`) instead of subagent dispatch. Polling costs ~10 tokens vs. ~150 for an explore dispatch.

This is a **deliberate exception** to delegation-first. The rule: if the check is a single `ls` or file read under 10 lines, do it directly. If it requires investigation, delegate.

### Error Escalation Protocol

Every subagent return must include: `status` (success | partial | failed), `summary` (< 200 words), `blockers` (list), `artifacts` (files modified).

**Escalation rules**: `success` -> proceed. `partial` -> review, retry incomplete portion or escalate. `failed` -> retry **once** silently; after 1 failed retry, escalate to human with full context.

At recursive depth > 1, the intermediate conductor must surface sub-subagent failures in its own return — never swallow them.

### Convergence Loop Protocol

Quality gates are not single-pass. Each gate runs in an iterative loop: **check -> fix -> recheck** until the gate converges or the iteration cap is reached.

**Loop mechanics:**

1. Dispatch the check agent (e.g., `code-reviewer`)
2. If clean: increment `clean_pass_count`. If issues found: reset `clean_pass_count` to 0, dispatch fix agent with findings as input
3. After fix, re-dispatch check agent (back to step 1)
4. **Converge** when `clean_pass_count >= 2` (two consecutive clean passes)
5. **Escalate** to user when `iteration_count >= 5`

**Applicable gates:**

| Gate                    | Check Agent              | Fix Agent                      | Convergence         |
| ----------------------- | ------------------------ | ------------------------------ | ------------------- |
| Interface Investigation | `interface-investigator` | `spec-author` (spec amendment) | 2 consecutive clean |
| Unifier Validation      | `unifier`                | `implementer` or `test-writer` | 2 consecutive clean |
| Code Review             | `code-reviewer`          | `implementer`                  | 2 consecutive clean |
| Security Review         | `security-reviewer`      | `implementer`                  | 2 consecutive clean |

**Why 2 consecutive passes:** A single clean pass may be coincidental — the fix addressed issue X but introduced issue Y. Two consecutive clean passes confirm stability.

**Fix agent input contract:** The fix agent receives the prior check's findings directly — it does not re-discover issues.

**Escalation** (when `iteration_count >= 5`): Report `CONVERGENCE FAILURE` with gate name, recurring issues, last fix attempted, and recommendation (manual intervention / scope reduction / spec amendment).

**Loop state** (owned by orchestrating agent, not subagents): `{ gate, iteration_count, clean_pass_count, max_iterations: 5, required_clean_passes: 2, findings_history: [] }`

---

## Persistence & State Guarantees

- Long-lived plans, decisions, or discoveries must be persisted externally. Do not rely on conversation history as durable memory.
- At any stopping point, ensure an external artifact captures: current objective, completed work, current phase, next steps, and unresolved questions. This artifact must be sufficient to resume work after context reset.

---

## Memory-Bank System

The memory-bank provides persistent project knowledge that survives across sessions.

### Directory Structure

```
.claude/memory-bank/
├── project.brief.md        # Project overview, purpose, success criteria
├── tech.context.md         # Architecture, subagents, workflows, key locations
├── delegation.guidelines.md # Conductor philosophy, tool diet, context economics
├── testing.guidelines.md   # Testing boundaries, mocking rules, AAA conventions
└── best-practices/
    ├── code-quality.md     # Error handling, DI, validation patterns
    ├── contract-first.md   # Contract-first development practices
    ├── ears-format.md      # EARS format for security requirements
    ├── skill-event-emission.md # Skill lifecycle event patterns
    ├── software-principles.md # Core software engineering principles
    ├── spec-authoring.md   # How to write good specs
    ├── subagent-design.md  # How to design effective subagents
    └── typescript.md       # TypeScript best practices
```

### Retrieval Policy

Load memory-bank files based on task context:

| File                                     | Load Trigger               | Consumers                      |
| ---------------------------------------- | -------------------------- | ------------------------------ |
| `project.brief.md`                       | Session start (always)     | Main agent                     |
| `tech.context.md`                        | Implementation routed      | Implementer, Spec-author       |
| `testing.guidelines.md`                  | Test work dispatched       | Test-writer, Implementer       |
| `best-practices/code-quality.md`         | Implementation routed      | Implementer, Code-reviewer     |
| `best-practices/spec-authoring.md`       | Spec work dispatched       | Spec-author, Atomizer          |
| `best-practices/ears-format.md`          | Security requirements work | Security-reviewer, Spec-author |
| `best-practices/contract-first.md`       | Implementation routed      | Implementer, Code-reviewer     |
| `best-practices/skill-event-emission.md` | Skill development          | Skill authors                  |
| `best-practices/software-principles.md`  | Implementation routed      | Implementer, Code-reviewer     |
| `best-practices/typescript.md`           | TypeScript work dispatched | Implementer, Code-reviewer     |

### Usage & Maintenance

- **Main agent**: Reference `delegation.guidelines.md` when uncertain about tool usage
- **Subagents**: Receive relevant memory-bank content in dispatch prompts
- **New contributors**: Start with `project.brief.md` for orientation
- **Updates**: Review content against actual state, then commit with `docs(memory-bank): update <filename>`
- **Do not duplicate**: Memory-bank summarizes; CLAUDE.md is authoritative for constraints

---

## Operational Feedback Loop

### Promotion Path

```
Session discovery -> Journal entry -> Memory-bank (after validation) -> CLAUDE.md (after 3+ confirmed uses)
```

- **Journal**: Immediate capture, unvalidated. Store in `.claude/journal/entries/`.
- **Memory-bank**: Validated pattern, available to subagents via dispatch prompts.
- **CLAUDE.md**: Proven practice, loaded into every session's base context.

CLAUDE.md is amended through specs, not ad-hoc edits. Memory-bank is amended through journal-driven discovery.

### Journal-Driven Discovery

When an agent discovers a pattern, workaround, or insight not captured in CLAUDE.md or memory-bank:

1. Document the finding in a journal entry (`.claude/journal/entries/`)
2. Include: what was discovered, why it matters, evidence from the session
3. At session end, the operator reviews journal entries

---

## Output Contract (Always Required)

Every response must include:

1. **Intent** — What is being done right now and why.
2. **Next actions** — Concrete, ordered steps that move the work forward.
3. **Open items** — Blocking questions, assumptions, or risks.
4. **State updates** — What was persisted, updated, or needs persistence next.

---

## Skills & Subagents System

### Workflow Routing (MANDATORY FIRST STEP)

**Every new user request MUST begin with `/route`** (except follow-ups and clarifications). Route determines: (1) workflow (oneoff-vibe | oneoff-spec | orchestrator), (2) delegation plan, (3) exploration needs.

- **Small tasks (oneoff-vibe)**: Delegate to single subagent
- **Medium tasks (oneoff-spec)**: TaskSpec + parallel delegation (implement + test)
- **Large tasks (orchestrator)**: MasterSpec + full parallel workstream delegation

### Core Skills

| Skill           | Purpose                                                      | When to Use                                        |
| --------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| `/route`        | Analyze task complexity and route to workflow                | Start of any new task                              |
| `/pm`           | Interview user to gather requirements                        | Before spec authoring                              |
| `/spec`         | Author specifications (TaskSpec, WorkstreamSpec, MasterSpec) | After requirements gathering                       |
| `/atomize`      | Decompose high-level specs into atomic specs                 | After spec authoring                               |
| `/enforce`      | Validate atomic specs meet atomicity criteria                | After atomization                                  |
| `/investigate`  | Surface cross-spec inconsistencies                           | Before implementation when specs have dependencies |
| `/implement`    | Implement from approved specs                                | After spec approval                                |
| `/test`         | Write tests for acceptance criteria                          | Parallel with implementation or after              |
| `/unify`        | Validate spec-impl-test alignment                            | After implementation and tests complete            |
| `/code-review`  | Code quality and best practices review                       | After convergence, before security                 |
| `/security`     | Security review of implementation                            | After code review, before merge                    |
| `/docs`         | Generate documentation from implementation                   | After security review                              |
| `/refactor`     | Code quality improvements                                    | Tech debt sprints, post-merge cleanup              |
| `/orchestrate`  | Coordinate multi-workstream projects                         | For large tasks with 3+ workstreams                |
| `/browser-test` | Browser-based UI testing                                     | For UI features, after security review             |
| `/prd`          | Create, sync, manage PRDs in git repository                  | Drafting new PRDs or syncing external ones         |

See `tech.context.md` for the full subagent list, directory structure, branch naming convention, and spec-is-contract principle.

PostToolUse hooks enforce type checking, linting, JSON/spec validation automatically. See `.claude/docs/HOOKS.md`.

### Iteration Cycles

#### Small Task (oneoff-vibe)

```
Request -> Route -> Delegate to subagent -> Synthesize -> Commit
```

#### Medium Task (oneoff-spec)

```
Request -> Route -> PM Interview -> [Optional: PRD Draft] -> Spec -> Atomize -> Enforce ->
  [If dependencies: Investigate (loop)] -> Approve ->
  [Parallel: Implement + Test] -> Integration Verify -> Unify (loop) -> Code Review (loop) -> Security (loop) ->
  [If UI: Browser Test] -> [If public API: Docs] -> [If PRD: PRD Push] -> Commit
```

#### Large Task (orchestrator)

```
Request -> Route -> PM Interview -> [Optional: PRD Draft] -> ProblemBrief ->
  [Parallel: WorkstreamSpecs] -> MasterSpec ->
  Investigate (MANDATORY for multi-workstream) -> Resolve Decisions ->
  Approve -> /orchestrate (allocates worktrees, dispatches facilitator) ->
  [Parallel per workstream: Implement + Test] -> Integration Verify ->
  Unify (loop) -> Code Review (loop) -> Security (loop) -> Browser Test -> Docs -> [If PRD: PRD Push] -> Commit
```

**Investigation Checkpoint**: For orchestrator workflows, `/investigate` is MANDATORY before implementation. It surfaces cross-workstream inconsistencies (env vars, API contracts, deployment assumptions) that would otherwise become runtime bugs.

### Parallel Execution

- Multiple `spec-author` subagents for workstreams
- `implementer` and `test-writer` run in parallel
- `code-reviewer` and `security-reviewer` run in parallel
- Main agent handles integration and synthesis

### Independent Verification (Practice 2.4)

When `implementer` and `test-writer` run in parallel, the test-writer **must not see the implementation**. The test-writer receives only the **spec** (acceptance criteria, task list, evidence table) — never implementation file paths or code. This ensures tests verify the _contract_, not the _implementation_. If the test-writer needs interface/type information, provide it from the spec's evidence table or contract definitions.

### Assumption Tracking (Practice 1.10)

When multiple agents implement in parallel, each agent's `TODO(assumption)` comments create a distributed assumption graph. After parallel implementation and before the review gate, the orchestrator MUST scan modified files for `TODO(assumption)` markers, group by topic, and flag conflicts (two agents assumed different values for the same integration point). A single agent's assumption is a local decision; multiple agents' assumptions about the same topic are a distributed consensus problem.

### Convergence Gates

Before merge, all gates must pass. Each gate marked with **(loop)** runs under the Convergence Loop Protocol — requiring 2 consecutive clean passes:

- Spec complete and approved
- All ACs implemented
- All tests passing (100% AC coverage)
- Unifier validation passed **(loop)**
- Code review passed (no High/Critical issues) **(loop)**
- Security review passed **(loop)**
- Browser tests passed (if UI)
- Documentation generated (if public API)

### Integration Verification Gate (Practice 4.5)

After parallel implementation and before code review, an integration verification gate checks cross-boundary wiring: (1) route registration — frontend-referenced endpoints exist in backend, (2) event name alignment — SSE/WebSocket names match between publisher and consumer, (3) config function consistency — all references to the same service use the same config function, (4) assumption conflict detection — no two agents made contradictory assumptions (Practice 1.10). This gate sits between implementation and code review in the workflow.

---

## Contract-First Development

Agents must prove symbols exist before referencing them (Evidence-Before-Edit). Schema defines truth — types are generated, not hand-written. For full practices including wire protocol contracts, boundary ownership, and contract stratification, see `best-practices/contract-first.md`. For code quality standards (error handling, DI, validation patterns), see `best-practices/code-quality.md`.

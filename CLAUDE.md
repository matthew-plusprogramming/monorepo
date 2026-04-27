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

If you are the main agent talking directly with the user, it is imperative you read `.claude/memory-bank/delegation.guidelines.md`.

### Default Vocabulary

Your first action for any request is one of:

1. `/route` — For new tasks
2. `Task` — For substantive work
3. Direct text — For clarifying questions

These three actions are your entire vocabulary. Everything else flows through delegation.

### Context Protection

The main agent's context is a non-renewable resource. Subagents return structured summaries and artifact pointers, not raw data. Delegation is 10-50x more context-efficient than direct reading.

For dispatch triggers, detailed examples, and context economics, see `.claude/memory-bank/delegation.guidelines.md`.

### Trace Context

Use `.claude/traces/high-level.md` when routing or dispatching work that touches `.claude/scripts`; it is optional orientation, not a session-start gate. Subagents may read relevant low-level `.json` or `.summary.json` sidecars when they need module/export context. Do not read `.calls.json` directly; use `.claude/scripts/trace-query.mjs` for call-graph detail. Trace data is advisory, so verify critical assumptions against source before irreversible decisions. If traces are absent or stale, proceed with normal source analysis.

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

Workstream agents are themselves conductors, not just executors. An implementer dispatches its own Explore and Test-writer subagents. This creates a delegation tree: **main agent -> workstream conductor -> leaf executor**. Maximum depth: 3 levels. Each level returns structured summaries and artifact pointers to its parent, never raw data.

**Mental model**: Context is RAM — every token read directly is permanently allocated. Subagent dispatches are disk reads — the data stays in the subagent's context and only a summary (pointer) lands in yours.

### Pre-Computed Structure (Practice 1.5)

When the human provides explicit decomposition, **use it directly** — do not re-decompose via the atomizer. The atomizer is a **fallback for ambiguous scope**, not the default. `/route` should detect human-provided structure and skip atomization.

### File-Based Coordination (Practice 1.6)

For trivially simple inter-agent coordination, use sentinel files (`.claude/coordination/<workstream-id>.done`, `.status`) instead of subagent dispatch.

This is a **deliberate exception** to delegation-first. The rule: if the check is a single `ls` or a tiny status-file read, do it directly. If it requires investigation, delegate.

### Error Escalation Protocol

Every subagent return must include: `status` (success | partial | failed), `summary`, `blockers` (list), `artifacts` (files modified).

**Escalation rules**: `success` -> proceed. `partial` -> review, retry incomplete portion or escalate. `failed` -> retry **once** silently; after 1 failed retry, escalate to human with full context.

At recursive depth > 1, the intermediate conductor must surface sub-subagent failures in its own return — never swallow them.

### Convergence Loop Protocol

Quality gates run iteratively: **check → fix → recheck** until 2 consecutive clean passes or 5 iterations (escalate after 5 with `CONVERGENCE FAILURE` report).

**Applicable gates**: `investigation`, `challenger`, `unifier`, `code_review`, `security_review`, `completion_verifier`.

**Recording convergence**: After each clean pass, record via:

```
node .claude/scripts/session-checkpoint.mjs update-convergence <gate_name>
```

Do NOT write to `session.json` manually. Each gate skill (`/investigate`, `/challenge`, `/unify`, `/code-review`, `/security`) and the `completion-verifier` agent document their own check agent, fix agent, and loop mechanics. Coercive enforcement (`workflow-gate-enforcement.mjs`) blocks downstream dispatches when `clean_pass_count < 2`.

### Autonomous Convergence

The workflow from spec authoring to implementation is fully autonomous for the common case (zero escalations). The `awaiting_approval` phase has been replaced by convergence-based quality gates:

1. **Investigation convergence loop**: Interface investigator runs iteratively until 2 consecutive clean passes (no Medium+ findings). Auto-decision engine evaluates findings between passes.
2. **Challenger convergence loop**: Challenger runs iteratively for `pre-implementation` and `pre-orchestration` stages until 2 consecutive clean passes. Fix agents: implementer (pre-impl), spec-author (pre-orch).
3. **Auto-approval**: After both convergence loops complete, a passthrough `auto_approval` phase is recorded for audit purposes. No human gate required.

**Auto-Decision Engine** (`.claude/scripts/auto-decision.mjs`): evaluates investigation + challenger convergence findings against three criteria (action verb, field/section reference, structured confidence enum) and auto-accepts qualifying findings. Applies to investigation and challenger (pre-impl/pre-orch) convergence loops only — NOT the PRD loop. Safety rails (oscillation detection, circuit breaker 90%/95%, 5-iteration cap, cross-stage 3-round-trip advisory, security escalation, all-or-nothing batch) gate the engine. See `.claude/docs/AUTO-DECISION.md` for full protocol, audit-trail schema, and graceful-degradation behavior.

**PRD Loop Unchanged**: The PRD gather-criticize loop remains fully human-in-the-loop. Auto-decision logic does NOT apply to PRD critic findings.

### Workflow Enforcement (Practice 4.3)

Mandatory workflow stages (challenger dispatches, completion verification, documentation) are enforced at three levels: cooperative (phase transition DAG), coercive (PreToolUse/Stop hooks that physically block tool execution), and obligation (manifest status field validation at phase exits).

**Cooperative enforcement** (session-checkpoint.mjs) uses a DAG-based predecessor model. Each phase declares its valid predecessors; transitions to phases with unvisited mandatory predecessors are rejected at the `graduated` enforcement level and warned at the `warn-only` level. The enforcement level is configurable per session:

- **off**: No enforcement; all transitions allowed (informational checklist only)
- **warn-only**: Log warnings for skipped mandatory stages but allow transitions
- **graduated**: Block transitions that skip mandatory predecessors; require explicit override

**Override mechanism**: When enforcement blocks a transition, agents may use `override-skip` (with rationale) to bypass a specific phase, or `reset-enforcement` to clear accumulated skip warnings. All overrides are recorded in session history for audit.

**Coercive enforcement** (PreToolUse/Stop hooks) physically blocks tool execution when prerequisites are not met:

- **PreToolUse Agent hook** (`workflow-gate-enforcement.mjs`): Blocks dispatch of 7 enforced subagent types (implementer, test-writer, e2e-test-writer, code-reviewer, security-reviewer, documenter, completion-verifier) when their workflow prerequisites are not met. Implementer requires convergence-type prerequisites (investigation and challenger gates with clean_pass_count >= 2). Uses stderr + exit 2 for blocking.
- **Stop hook** (`workflow-stop-enforcement.mjs`): Blocks session completion when mandatory dispatches (code-reviewer, security-reviewer, completion-verifier, documenter) have not occurred. Uses stdout JSON `{"decision": "block"}` for blocking.
- **Write protection** (`workflow-file-protection.mjs`): Blocks agent writes to `gate-override.json` and `gate-enforcement-disabled`. Not disabled by the kill switch.

**Obligation enforcement**: Phase transitions validate manifest status fields via `validateObligations()` in `workflow-dag.mjs`. See HOOKS.md § Status Obligation Enforcement for the full mapping (9 phases → 14 obligations) and phase-scoped override syntax.

**Exempt workflows**: `oneoff-vibe`, `refactor`, and `journal-only` workflows bypass all enforcement.

**Fail-open**: Structural errors exit 0. Exception: missing convergence fields default to 0 (fail-closed). See HOOKS.md § Fail-Open Behavior.

---

## Self-Answer Protocol

Agents must consult the four-tier assumption hierarchy (code > spec > memory > reasoning) before escalating questions to humans. The full protocol is at `.claude/memory-bank/self-answer-protocol.md`.

**Key rules**:

- Use `SELF-RESOLVED(<tier>)` format when a source tier provides an answer
- Reserve `TODO(assumption)` only for genuinely unresolvable questions (no tier provides evidence)
- Always escalate observable behavior questions when only reasoning-tier evidence exists
- Always escalate cross-tier conflicts (code says X, spec says Y)
- Each agent declares its Acceptable Assumption Domains in `.claude/agents/*.md`

---

## Persistence & State Guarantees

- Long-lived plans, decisions, or discoveries must be persisted externally. Do not rely on conversation history as durable memory.
- At any stopping point, ensure an external artifact captures: current objective, completed work, current phase, next steps, and unresolved questions. This artifact must be sufficient to resume work after context reset.

### Artifact Storage Paths

| Artifact                             | Storage Path                                             |
| ------------------------------------ | -------------------------------------------------------- |
| Journal entries                      | `.claude/journal/entries/<date>-<slug>.md`               |
| Decision records                     | `.claude/journal/decisions/<id>.md`                      |
| Handoff documents                    | `.claude/context/archive/<slug>-handoff.md`              |
| Investigation reports (spec-coupled) | `.claude/specs/groups/<sg-id>/investigation-report.md`   |
| Investigation reports (standalone)   | `.claude/journal/entries/investigation-<date>-<slug>.md` |
| Fix reports                          | `.claude/journal/entries/fix-<date>-<slug>.md`           |

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
├── practice-index.md       # Practice number -> canonical file/line mapping
└── best-practices/
    ├── code-quality.md     # Error handling, DI, validation patterns
    ├── contract-first.md   # Contract-first development practices
    ├── ears-format.md      # EARS format for security requirements
    ├── logging.md          # Log design, structured logs, correlation, observability
    ├── software-principles.md # Core software engineering principles
    ├── spec-authoring.md   # How to write good specs
    ├── subagent-design.md  # How to design effective subagents
    └── typescript.md       # TypeScript best practices
```

### Retrieval Policy

Load memory-bank files based on task context:

| File                                    | Load Trigger                                                                      | Consumers                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `project.brief.md`                      | Session start (always)                                                            | Main agent                                                              |
| `org-context.md`                        | PRD work dispatched                                                               | PRD-writer                                                              |
| `tech.context.md`                       | Implementation routed                                                             | Implementer, Spec-author                                                |
| `testing.guidelines.md`                 | Test work dispatched                                                              | Test-writer, Implementer                                                |
| `best-practices/code-quality.md`        | Implementation routed                                                             | Implementer, Code-reviewer                                              |
| `best-practices/spec-authoring.md`      | Spec work dispatched                                                              | Spec-author, Atomizer                                                   |
| `best-practices/ears-format.md`         | Security requirements work                                                        | Spec-author (Required Context); Security-reviewer (source ref only)     |
| `best-practices/contract-first.md`      | Implementation routed                                                             | Implementer, Code-reviewer                                              |
| `best-practices/logging.md`             | Implementation routed                                                             | Implementer, Code-reviewer                                              |
| `best-practices/software-principles.md` | Implementation routed                                                             | Implementer, Code-reviewer                                              |
| `best-practices/typescript.md`          | TypeScript work dispatched                                                        | Implementer                                                             |
| `best-practices/subagent-design.md`     | Subagent dispatch                                                                 | route/SKILL.md, implement/SKILL.md, orchestrate/SKILL.md, spec/SKILL.md |
| `self-answer-protocol.md`               | All agent dispatches                                                              | All 23 agents                                                           |
| `traces/low-level/*.json`               | Implementation routed, Test dispatched, Review dispatched, Exploration dispatched | Implementer, Test-writer, Code-reviewer, Security-reviewer, Explore     |
| `traces/high-level.json`                | Dispatch planning (main agent)                                                    | Main agent                                                              |
| `traces/high-level.md`                  | Routing, dispatch planning                                                        | Main agent, Route                                                       |

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

**Raised orchestrator bar** (see `.claude/docs/ROUTING.md`): `/route` recommends `orchestrator` only when the request clears a three-condition gate (10+ anticipated atomic specs AND ≥2 multi-domain criteria with evidence AND tight parallelization benefit) and emits a `multi_domain_justification` field. Medium-complexity work that previously routed to orchestrator under the legacy "5+ files, 4+ hours" heuristic now defaults to `oneoff-spec`. In-flight orchestrator spec groups are not reclassified; the raised bar is forward-only.

### Core Skills

| Skill          | Purpose                                                                                                        | When to Use                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/route`       | Analyze task complexity and route to workflow                                                                  | Start of any new task                                                                                               |
| `/prd`         | Create PRDs through gather-criticize loop, sync existing PRDs, push amendments                                 | Before spec authoring                                                                                               |
| `/spec`        | Author specifications (TaskSpec, WorkstreamSpec, MasterSpec)                                                   | After requirements gathering                                                                                        |
| `/atomize`     | Decompose high-level specs into atomic specs                                                                   | Orchestrator workflows only (after spec authoring)                                                                  |
| `/enforce`     | Validate atomic specs meet atomicity criteria                                                                  | Orchestrator workflows only (after atomization)                                                                     |
| `/investigate` | Surface cross-spec inconsistencies                                                                             | MANDATORY for oneoff-spec and orchestrator before implementation                                                    |
| `/challenge`   | Operational feasibility scrutiny before implementation or orchestration                                         | Required for oneoff-spec before implementation and orchestrator before orchestration                                |
| `/implement`   | Implement from approved specs                                                                                  | After spec approval                                                                                                 |
| `/test`        | Write tests for acceptance criteria                                                                            | Parallel with implementation or after                                                                               |
| `/e2e-test`    | Generate E2E tests from spec contracts                                                                         | Parallel with implementation (opt-out via e2e_skip)                                                                 |
| `/unify`       | Validate spec-impl-test alignment                                                                              | After implementation and tests complete                                                                             |
| `/code-review` | Code quality and best practices review                                                                         | After convergence, before security                                                                                  |
| `/security`    | Security review of implementation                                                                              | After code review, before merge                                                                                     |
| `/docs`        | Generate documentation from implementation                                                                     | After security review                                                                                               |
| `/doc-audit`   | Diagnose documentation health (staleness, coverage gaps, broken refs)                                          | On-demand, post-documenter, or PRD-time                                                                             |
| `/refactor`    | Behavior-preserving code quality improvements (dispatches refactorer subagent)                                 | Tech debt sprints, post-merge cleanup                                                                               |
| `/orchestrate` | Coordinate multi-workstream projects                                                                           | For large tasks with 3+ workstreams                                                                                 |
| `/flow-verify` | Verify wiring correctness across systems                                                                       | MANDATORY at 4 stages: prd-review (parallel), spec-review (parallel), impl-verify (serial gate), post-impl (serial) |
| `/manual-test` | Bounded exploratory end-to-end verification (5 happy + 3 failure + 2 adjacent, then stop)                      | Advisory final step after `/docs`; non-blocking                                                                     |

See `.claude/memory-bank/tech.context.md` for the full subagent list, directory structure, branch naming convention, and spec-is-contract principle.

PostToolUse hooks enforce type checking, linting, JSON/spec validation automatically. See `.claude/docs/HOOKS.md`.

For the `/doc-audit` skill internals, see `.claude/docs/DOC-AUDIT.md`. For the `/flow-verify` skill internals, see `.claude/docs/FLOW-VERIFIER.md`.

### Iteration Cycles

Full workflow sequences (oneoff-vibe, oneoff-spec, orchestrator) are documented in `/route` SKILL.md § Integration with Other Skills. Convergence mechanics (2 consecutive clean passes, cross-stage resolution cap of 3) live in `/challenge` and `/investigate` SKILL.md. Dedicated `/challenge` dispatches are required only at `pre-implementation` for oneoff-spec and `pre-orchestration` for orchestrator. Former `pre-test` and `pre-review` challenger dispatches were deleted; `/unify` preflight and reviewer-focus metadata carry those signals. Investigation is MANDATORY before implementation for oneoff-spec and orchestrator workflows. Security-category overrides must be tagged as "security-risk acknowledgment" in the Decisions Log — see `/security` SKILL.md.

### Parallel Execution

- Multiple `spec-author` subagents for workstreams
- `implementer`, `test-writer`, and `e2e-test-writer` run in parallel (no ordering constraint — test-writer and e2e-test-writer work from spec only; e2e-test-writer dispatched by default with opt-out via `e2e_skip: true` in spec frontmatter)
- `code-reviewer` and `security-reviewer` run in parallel after unifier and reviewer-focus metadata prerequisites
- Both reviewers converge independently; `documenter` waits for both convergences
- Main agent handles integration and synthesis

### Independent Verification (Practice 2.4)

When `implementer`, `test-writer`, and `e2e-test-writer` run in parallel, neither the test-writer nor the e2e-test-writer **may see the implementation**. Both receive only the **spec** (acceptance criteria, task list, evidence table, contract definitions) — never implementation file paths or code. This ensures tests verify the _contract_, not the _implementation_. The e2e-test-writer is dispatched by default for all spec-based workflows (opt-out via `e2e_skip: true` with rationale in spec frontmatter). Its isolation is additionally enforced by a PreToolUse hook that blocks all reads outside spec/contract/template/test/docs directories and all writes outside `tests/e2e/`. If either agent needs interface/type information, provide it from the spec's evidence table or contract definitions.

### Assumption Tracking (Practice 1.10)

When multiple agents implement in parallel, each agent's `TODO(assumption)` comments create a distributed assumption graph. After parallel implementation and before the review gate, the orchestrator MUST scan modified files for `TODO(assumption)` markers, group by topic, and flag conflicts (two agents assumed different values for the same integration point). A single agent's assumption is a local decision; multiple agents' assumptions about the same topic are a distributed consensus problem.

### Convergence Gates

Before merge, all gates must pass. Each gate marked with **(loop)** runs under the Convergence Loop Protocol. Per-gate thresholds and `attestation_mode` are read from the `PerGateThresholdTable` (exported by `workflow-dag.mjs`) via the `SessionThresholdSnapshot` captured at session start (`session.active_work.threshold_snapshot`). Pipeline-efficiency ws-1 introduces **content-hash attestation-skip** for content-stable gates: when the gate's `hash_input_manifest` content-hash is byte-identical between Pass N and Pass N-1, the gate MAY converge at **1 clean pass + attestation** (instead of 2 consecutive). Investigation and challenger retain 2-consecutive-clean with `attestation_mode: "none"` — distinct findings per pass observed in evidence runs make content-hash attestation unsafe for these gates.

- Spec complete
- Investigation convergence **(loop)** — 2 consecutive clean passes, `attestation_mode: none`, auto-decision engine
- Challenger convergence **(loop)** — 2 consecutive clean passes, `attestation_mode: none`, auto-decision engine (pre-impl/pre-orch stages only)
- All ACs implemented
- All tests passing (100% AC coverage)
- Unifier validation passed **(loop)** — `required_clean_passes: 1`, `attestation_mode: content-hash` (may skip on stable-state attestation; EC-7 conservative fallback if hash differs)
- Code review passed (no High/Critical issues) **(loop)** — `required_clean_passes: 2`, `attestation_mode: content-hash` (this ship; REQ-001 relaxation to 1 pending baseline accrual)
- Security review passed **(loop)** — `required_clean_passes: 2`, `attestation_mode: content-hash` (this ship; REQ-001 relaxation to 1 pending baseline accrual)
- Completion verification passed **(loop)** — `required_clean_passes: 1`, `attestation_mode: content-hash` (may skip on stable-state attestation)
- E2E tests passed (unless e2e_skip)
- Documentation generated
- Manual test (advisory) — `/manual-test` dispatched after `/docs`; findings reviewed but non-blocking

**Minimum-pruning floor (BIZ-002)**: At least one of `{unifier, code-review, security, completion-verifier}` MUST be configured at `(required_clean_passes: 1, attestation_mode: "content-hash")` unless `.claude/prds/pipeline-efficiency/threshold-decisions.md` documents ≥10% Medium+ 2nd-pass rate for all four gates. Enforced at `/enforce` time via `minimum-pruning-floor.mjs` (AC14.1–AC14.4). Per-gate rationale and baseline evidence live in `.claude/prds/pipeline-efficiency/threshold-decisions.md`.

**compute-hashes gate ordering (REQ-009 / SC-9)**: Registry hash verification runs as a phase-transition hook at `post-impl → pre-unify` ONLY — pre-impl dispatch removed (dead code). The hook is wired into `.claude/scripts/lib/workflow-dag.mjs` (exports `COMPUTE_HASHES_HOOK_SOURCE_PHASE`, `COMPUTE_HASHES_HOOK_TARGET_PHASE`, `COMPUTE_HASHES_HOOK_PHASE_TRANSITION` = `testing→verifying`, `COMPUTE_HASHES_VERIFY_FLAG`, `COMPUTE_HASHES_DRIFT`, `shouldRunComputeHashesHook()`, `runComputeHashesGate()`) and invokes `node .claude/scripts/compute-hashes.mjs --verify` synchronously via `execFileSync`. The synchronous invocation is load-bearing: on non-zero exit, `runComputeHashesGate()` throws `COMPUTE_HASHES_DRIFT` inline on the caller's stack, allowing the facilitator to `process.exit(err.exitCode)` BEFORE the Node event loop drains any queued `SubagentStop` convergence-recorder — the ordering contract prevents a drift-failing pass from producing a ritual clean-pass append. On exit 0, the transition proceeds to `verifying` and the unifier dispatches against fresh hashes; on exit 2, the session aborts with the recorder skipped. Advisory lock at `.claude/coordination/compute-hashes.lock` (30s timeout) serializes concurrent ws-1/ws-2/ws-3 orchestrators; timeout emits `COMPUTE_HASHES_LOCK_TIMEOUT` + exit 2. Late-stage completion-verifier retains a secondary `registry-hash-verify` drift check. See `.claude/docs/HOOKS.md` §compute-hashes post-impl → pre-unify gate and §Worktree-canon integration points for full error shapes, audit payload schema, and consumer wiring.

### Integration Verification Gate (Practice 4.5)

**Subsumed by flow-verifier.** The flow-verifier agent (`/flow-verify`) performs comprehensive wiring verification at 4 stages (prd-review, spec-review, impl-verify, post-impl), covering all checks previously described here plus additional flow types (user, data, event, control) and carry-forward findings across stages. See `.claude/agents/flow-verifier.md` and `.claude/skills/flow-verify/SKILL.md`.

---

## Contract-First Development

Agents must prove symbols exist before referencing them (Evidence-Before-Edit). Schema defines truth — types are generated, not hand-written.

### Wire Protocol Contracts (Practice 1.8)

Every cross-boundary integration point must have an explicit wire protocol contract defining: HTTP method, path, request/response shapes, error codes, and authentication requirements. See `.claude/memory-bank/best-practices/contract-first.md` for full details.

### Boundary Ownership Assignment (Practice 1.9)

Each integration boundary has exactly one owning spec: SSE/WebSocket routes are owned by the relay spec, REST routes are owned by the server spec, shared database schemas are owned by the schema-owner spec. When in doubt, the spec that defines the data shape owns the boundary.

### Contract Stratification (Practice 2.5)

Contracts exist at four layers — each must be explicitly verified:

1. **Type contracts** — TypeScript interfaces, Zod schemas
2. **Symbol contracts** — exported names, import paths
3. **Wire protocol contracts** — HTTP/SSE/WS request/response shapes
4. **Behavioral contracts** — expected side effects, ordering guarantees, error semantics

For full practices, see `.claude/memory-bank/best-practices/contract-first.md`.

---

## Code Quality Foundations

These practices apply to all implementation work. See `.claude/memory-bank/best-practices/code-quality.md` for full details.

- **Structured error handling** — Use typed error classes with error codes, not string messages
- **Dependency injection** — Pass dependencies explicitly; no hidden singletons or global state
- **Zod validation at boundaries** — Validate all external input (API requests, file reads, env vars) with Zod schemas
- **Module boundary enforcement** — Export only the public API; keep internals private
- **Named constants over magic values** — No unexplained literals in logic; use descriptive constant names
- **Contract-generated types** — Types are derived from schemas (Zod, OpenAPI), not hand-written

For code quality standards, see `.claude/memory-bank/best-practices/code-quality.md`. For contract-first practices, see `.claude/memory-bank/best-practices/contract-first.md`.

---

## Communication Style

Use Caveman-lite for agent → human output: direct, full-sentence, evidence-complete. Hedge only when uncertainty matters. Keep identifiers, paths, URLs, code blocks, errors, ordered steps, and required fields exact.

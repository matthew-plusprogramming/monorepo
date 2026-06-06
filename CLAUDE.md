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

## Advanced Delegation Patterns

These are runtime invariants. Detailed examples and mechanics live in `.claude/memory-bank/delegation.guidelines.md`, `.claude/docs/WORKFLOW-ENFORCEMENT.md`, `.claude/docs/AUTO-DECISION.md`, and `.claude/docs/HOOKS.md`.

### Recursive Delegation (Practice 1.4)

Subagents may coordinate bounded slices of work instead of only executing leaf tasks: **main agent -> slice coordinator -> leaf executor**. Maximum depth: 3 levels. Each level returns structured summaries and artifact pointers, never raw data. Treat main-agent context as RAM; subagent context is the cheap read path.

### Pre-Computed Structure (Practice 1.5)

When the human provides explicit decomposition, **use it directly**. For ambiguous larger scope, capture a compact slice/dependency table in `spec.md` instead of creating a separate decomposition workflow.

### File-Based Coordination (Practice 1.6)

For trivial inter-agent coordination, sentinel files (`.claude/coordination/<slice-id>.done`, `.status`) are allowed. A single `ls` or tiny status read may be direct; anything investigative is delegated.

### Error Escalation Protocol

Every subagent return includes `status` (`success` | `partial` | `failed`), `summary`, `blockers`, and `artifacts`. Proceed on `success`; review/retry or escalate `partial`; retry `failed` once silently, then escalate with context. Intermediate conductors must surface sub-subagent failures.

### Convergence Loop Protocol

Quality gates run iteratively: **check → fix → recheck** until the gate's configured clean-pass threshold is met or 5 iterations (escalate after 5 with `CONVERGENCE FAILURE` report). Thresholds come from `SessionThresholdSnapshot`; legacy sessions without a snapshot fall back to 2 consecutive clean passes.

**Applicable gates**: `investigation`, `challenger`, `unifier`, `code_review`, `security_review`, `completion_verifier`.

**Recording convergence**: After each clean pass, record via:

```
node .claude/scripts/session-checkpoint.mjs update-convergence <gate_name>
```

Do NOT write to `session.json` manually. Each gate skill (`/investigate`, `/challenge`, `/unify`, `/code-review`, `/security`) and the `completion-verifier` agent document their own check agent, fix agent, and loop mechanics. Coercive enforcement (`workflow-gate-enforcement.mjs`) blocks downstream dispatches when the gate-specific clean-pass threshold is not met; legacy no-snapshot sessions preserve the historical `clean_pass_count < 2` behavior.

### Autonomous Convergence

Common-case spec-to-implementation work proceeds without human approval after investigation and challenger convergence.

**Auto-Decision Engine**: May accept qualifying investigation/challenger findings; safety rails include oscillation detection, 90%/95% circuit breaker, 5-iteration cap, security escalation, and all-or-nothing batches. See `.claude/docs/AUTO-DECISION.md`.

**PRD Loop Unchanged**: The PRD gather-criticize loop remains fully human-in-the-loop. Auto-decision logic does **not** apply to PRD critic findings.

### Workflow Enforcement (Practice 4.3)

Workflow stages are enforced cooperatively by phase-DAG transitions, coercively by PreToolUse/Stop hooks, and structurally by manifest obligation validation.

- `session-checkpoint.mjs` supports `off`, `warn-only`, and `graduated` enforcement; overrides require rationale and are recorded.
- `workflow-gate-enforcement.mjs` blocks implementer, test-writer, e2e-test-writer, code-reviewer, security-reviewer, documenter, and completion-verifier dispatches when prerequisites are missing. Implementer requires investigation and challenger convergence at the session's configured threshold (legacy fallback: 2).
- `workflow-stop-enforcement.mjs` blocks completion when risk-tier-required dispatches are missing. Trust-bearing sessions require code-reviewer, security-reviewer, completion-verifier, documenter, and e2e-test-writer unless the spec has a valid e2e opt-out. Runtime-validation specs additionally require passing manual-test.
- `workflow-file-protection.mjs` blocks writes to enforcement override files and is not disabled by the kill switch.
- Exempt workflows (`oneoff-vibe`, `refactor`, `journal-only`) bypass normal dispatch/completion enforcement, but Stop still fails closed if they edit trust-bearing files such as hooks, settings, registries, agents, skills, memory-bank files, or `CLAUDE.md`.
- Structural hook errors generally fail open; missing convergence fields fail closed. See `.claude/docs/HOOKS.md`.

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

### Retrieval Policy

Load memory-bank files based on task context; this is the canonical agent-to-file mapping:

| Context file                                                                  | Load trigger / consumers                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `project.brief.md`                                                            | Session start / main agent                                    |
| `org-context.md`                                                              | PRD work / PRD-writer                                         |
| `tech.context.md`                                                             | Implementation or spec routing / Implementer, Spec-author     |
| `testing.guidelines.md`                                                       | Test work / Test-writer, Implementer                          |
| `best-practices/{code-quality,contract-first,logging,software-principles}.md` | Implementation and review / Implementer, Code-reviewer        |
| `best-practices/{spec-authoring,ears-format}.md`                              | Spec or security requirements work / Spec-author, Security-reviewer |
| `best-practices/{subagent-design,typescript}.md`                              | Subagent or TypeScript work / route, implement, spec, Implementer |
| `self-answer-protocol.md`                                                     | All agent dispatches / all agents                             |

### Usage & Maintenance

- **Main agent**: Reference `delegation.guidelines.md` when uncertain about tool usage
- **Subagents**: Receive relevant memory-bank content in dispatch prompts
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

**Every new user request MUST begin with `/route`** (except follow-ups and clarifications). Route determines: (1) workflow (`oneoff-vibe` | `oneoff-spec` | `refactor` | `journal-only`), (2) delegation plan, (3) exploration needs.

- **Small tasks (oneoff-vibe)**: Truly trivial work, clear bounded low-risk edits, or explicit vibe/skip-spec override
- **Spec tasks (oneoff-spec)**: TaskSpec/full spec in one `spec.md`, with parallel delegation for implementation, tests, E2E, and optional slices
- **Large tasks (oneoff-spec)**: Same workflow; capture contracts, dependencies, test surfaces, and optional spec slices in `spec.md`

**Spec-first routing** (see `.claude/docs/ROUTING.md`): `/route` never creates a separate large-work coordination workflow for new work. Complexity changes the richness of `spec.md` and the delegation plan, not the workflow.

### Core Skills

- **Routing/spec gates**: `/route` starts new tasks; `/prd` gathers requirements; `/spec` authors one `spec.md` with TaskSpec/full-spec detail as needed.
- **Pre-implementation scrutiny**: `/investigate` is MANDATORY for oneoff-spec before implementation; `/challenge` runs before oneoff-spec implementation.
- **Build/test/review**: `/implement`, `/test`, and `/e2e-test` run from specs; E2E Test runs parallel with implementation (opt-out via e2e_skip); `/unify` validates spec/impl/test alignment.
- **Release gates**: `/code-review` and `/security` run after unifier and reviewer-focus metadata; `/docs` runs after security; `/manual-test` runs after `/docs`, advisory by default and mandatory for `runtime_validation_required: true` specs.
- **Operations**: `/doc-audit` diagnoses docs health; `/refactor` dispatches refactorer for behavior-preserving cleanup; `/flow-verify` checks prd-review, spec-review, impl-verify, and post-impl flows.

See `.claude/memory-bank/tech.context.md` for the full subagent list, directory structure, branch naming convention, and spec-is-contract principle.

PostToolUse hooks run scoped validators for JSON, templates, agent/skill frontmatter, spec schemas, spec structure, and structured docs. See `.claude/docs/HOOKS.md`.

For the `/doc-audit` skill internals, see `.claude/docs/DOC-AUDIT.md`. For the `/flow-verify` skill internals, see `.claude/docs/FLOW-VERIFIER.md`.

### Iteration Cycles

Full workflow sequences live in `/route` SKILL.md § Integration with Other Skills. Investigation is MANDATORY before implementation for oneoff-spec workflows. Dedicated `/challenge` dispatches are required at `pre-implementation`; `/unify` preflight and reviewer-focus metadata cover post-implementation review routing. Security-category overrides must be tagged as "security-risk acknowledgment" in the Decisions Log.

### Parallel Execution

- Optional `spec-author` subagents for clearly separated slices, all folded back into the same `spec.md`
- `implementer`, `test-writer`, and `e2e-test-writer` run in parallel (no ordering constraint — test-writer and e2e-test-writer work from spec only; e2e-test-writer dispatched by default with opt-out via `e2e_skip: true` in spec frontmatter)
- `code-reviewer` and `security-reviewer` may run in parallel after unifier and reviewer-focus metadata prerequisites
- Both reviewers converge independently; `documenter` waits for both convergences
- Main agent handles integration and synthesis

### Independent Verification (Practice 2.4)

Default test generation is contract-first and isolated from implementation. `e2e-test-writer` **must never see implementation** and receives only specs/contracts; hooks restrict its reads and writes to its allowed surfaces. `test-writer` also defaults to strict isolation, with one narrow bug-fix hybrid exception: `spec_mode: bug-fix` plus a valid `test_writer_unlock` after a first failing strict-mode run. Do not provide implementation paths to test-writer for normal feature work, and never provide them to e2e-test-writer.

### Assumption Tracking (Practice 1.10)

After parallel implementation and before review, scan modified files for `TODO(assumption)` markers, group them by topic, and flag conflicts where agents assumed different values for the same integration point.

### Convergence Gates

Before merge, all workflow/risk-tier-required gates must pass. Per-gate thresholds and `attestation_mode` come from `PerGateThresholdTable` through the `SessionThresholdSnapshot`.

| Gate / requirement                                               | Required state                                                                                                                                                                    |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec, ACs, tests                                                 | Spec complete; all ACs implemented; all tests passing with 100% AC coverage                                                                                                       |
| Investigation (Interface investigator) and challenger **(loop)** | 2 consecutive clean passes, `attestation_mode: none`, auto-decision for investigation and pre-implementation challenger only                                                       |
| Unifier and completion-verifier **(loop)**                       | `required_clean_passes: 1`, `attestation_mode: content-hash`; content-hash attestation-skip may converge at 1 clean pass + attestation when inputs are stable                     |
| Code-review and security **(loop)**                              | No High/Critical issues; `required_clean_passes: 2`, `attestation_mode: content-hash` pending baseline-backed relaxation                                                          |
| E2E, docs, manual test                                           | E2E tests passed (unless e2e_skip); documentation generated; `/manual-test` is advisory by default but blocks terminal Stop for `runtime_validation_required: true` until passing |

**Minimum-pruning floor (BIZ-002)**: At least one of `{unifier, code-review, security, completion-verifier}` must remain configured at `(required_clean_passes: 1, attestation_mode: "content-hash")` unless `.claude/prds/pipeline-efficiency/threshold-decisions.md` documents the zero-relax evidence required by `minimum-pruning-floor.mjs`.

**compute-hashes gate ordering (REQ-009 / SC-9)**: Artifact hash verification runs only at `post-impl -> pre-unify` / `testing -> verifying`. Author checkouts run `node .claude/scripts/compute-hashes.mjs --verify`; synced consumers fall back to `node .claude/scripts/consumer-hash-verify.mjs --verify` against `.claude/locks/<project>.lock.json` when the author registry is not shipped. Drift aborts before convergence recording; success lets unifier dispatch against fresh hashes. The advisory lock, error shapes, audit payloads, and secondary completion-verifier drift check are documented in `.claude/docs/HOOKS.md`.

### Stop-hook Gates

Stop-hook gates run inside `workflow-stop-enforcement.mjs` (PostToolUse / Stop hook) and block session-completion via `{decision: "block"}` when their preconditions fail. They are NOT entries in `PerGateThresholdTable`; they have no clean-pass / convergence loop. Each block is independently fail-open on structural error (DEC-008).

| Gate                | Source                                                    | Condition                                                               | Block-reason format                                              |
| ------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `deployment-verify` | `workflow-stop-enforcement.mjs:1489-1564`                 | `session.deployment.detected === true && verify_deploy_passed !== true` | "Deployment detected without post-deploy verification..."        |
| `pre-merge-verify`  | `workflow-stop-enforcement.mjs` (after deployment-verify) | `session.pre_merge_verify.status === 'failed'`                          | "Pre-merge-verify gate failed: reason=<closed-22-value-enum>..." |

Both gates are composed at the truth-table conjunction: `completionAllowed iff !deploymentBlocked && !preMergeBlocked` (NFR-8). When both fail, both reasons appear in the operator-facing output (AC-6.6, no precedence). The pre-merge-verify gate consumes the closed 22-value reason vocabulary at `.claude/scripts/lib/pre-merge-verify.mjs:97` (REQ-007 / NFR-12). For pre-merge-verify internals, see `.claude/docs/internals/pre-merge-verify-architecture.md`.

### Integration Verification Gate (Practice 4.5)

**Subsumed by flow-verifier.** `/flow-verify` checks wiring at prd-review, spec-review, impl-verify, and post-impl across user, data, event, and control flows. See `.claude/docs/FLOW-VERIFIER.md`.

---

## Contract-First Development

Agents must prove symbols exist before referencing them (Evidence-Before-Edit). Schema defines truth — types are generated, not hand-written.

### Wire Protocol Contracts (Practice 1.8)

Every cross-boundary integration point needs an explicit protocol contract: method/path, request/response shape, error codes, and auth requirements.

### Boundary Ownership Assignment (Practice 1.9)

Each integration boundary has exactly one owning spec. When ownership is unclear, the spec that defines the data shape owns the boundary.

### Contract Stratification (Practice 2.5)

Verify all four contract layers: type contracts, symbol contracts, wire protocol contracts, and behavioral contracts. Full practices live in `.claude/memory-bank/best-practices/contract-first.md`.

---

## Code Quality Foundations

Implementation work follows structured errors, explicit dependency injection, Zod validation at external boundaries, narrow module exports, named constants over magic values, and contract-generated types. Full standards live in `.claude/memory-bank/best-practices/code-quality.md`.

---

## Communication Style

Use Caveman-lite for agent → human output: direct, full-sentence, evidence-complete. Hedge only when uncertainty matters. Keep identifiers, paths, URLs, code blocks, errors, ordered steps, and required fields exact.

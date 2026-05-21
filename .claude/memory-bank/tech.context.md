---
last_reviewed: 2026-04-17
---

# Technical Context

Stacks & Tooling

- Node.js + TypeScript, Express, Effect, Zod, JWT.
- AWS SDK v3, CDKTF (OpenTofu/Terraform compatible).
- Turborepo, Vite, ESLint flat config.

Constraints

- TypeScript modules across packages; keep builds and configs consistent.
- Keep changes minimal and localized; adhere to repo style.

Environment

- Local dev for the server; CDKTF for infra with outputs consumed by the app.
- Worktree env keys: `.env.keys` are untracked; use `node .claude/scripts/sync-worktree-env-keys.mjs` (add `--overwrite` to replace existing files) for a single worktree or `node .claude/scripts/manage-worktrees.mjs sync` to refresh all worktrees (overwrites existing `.env.keys` and `cdktf-outputs` files). `manage-worktrees.mjs ensure` also syncs `cdk/platform-cdk/cdktf-outputs` when present, and use the `dotenvx-run.mjs` wrapper for missing-key hints.
- Optional: use `git worktree` to keep parallel changes isolated (e.g. hidden repo-local `.worktrees/{admin,backend,client}` on `worktree/*` branches).
- When you hit a `"package not found"` error, run `npm run install` at the repo root and retry first.

Entrypoints

- Server: `apps/node-server/src/index.ts` (dev) | `apps/node-server/src/lambda.ts` (Lambda)
- Infra: `cdk/platform-cdk/src/index.ts`

Where To Look First

- Handlers: `apps/node-server/src/handlers/*`
- Schemas: `packages/core/schemas/schemas/**/*`
- Infra stacks: `cdk/platform-cdk/src/stacks/**/*`

Codebase Map

- `apps/node-server`: Express app, middleware, handlers, Lambda wrapper.
- `cdk/platform-cdk`: CDKTF stacks (API, analytics, client website), consumers, outputs loader.
- `packages/core/backend-core`: Effect→Express adapter, services, types.
- `packages/core/schemas`: Zod domain schemas and constants.
- Shared configs: `packages/configs/*`.
- Shared UI: `packages/core/ui-components` exports reusable React components/styles for the web apps; CSS module typings are generated via `gen:css-types` (watch in `dev`) into `__generated__/src`.

Tech Stack Details

- Validation: Zod 4 for inputs and env `apps/node-server/src/types/environment.ts`.
- Effects: Effect 3 for typed effects/layers/errors `packages/core/backend-core`.
- Auth: JWT with custom claims `packages/core/schemas/schemas/user/userToken.ts` (optional; can be ejected via `npm run eject:users`); role constants in `packages/core/backend-core/src/auth/roles.ts`, admin enforcement via `apps/node-server/src/middleware/isAdmin.middleware.ts`.
- Build: Vite SSR to CJS; TS strict, shared configs.

Workflows

- Repo: build/lint/clean via turborepo scripts.
- App (node-server): `dev`, `build`, `preview`, env management via dotenvx.
- Infra (CDKTF): deploy/synth/destroy per stage; outputs written and consumed by app.

Task Recipes

- Add endpoint: define schema → implement handler using `parseInput` → wrap with `generateRequestHandler` → wire route → run dev.
- Add table/GSI: update schema constants → add stack changes → deploy → load outputs → update app client.
- Add middleware: implement Effect middleware → wrap as `RequestHandler` → register in server entry.

Scaffolding

- Repository scaffolding scripts live under `scripts/**`; `scripts/create-repository-service.mjs` is a thin wrapper over a config-driven runner defined in `scripts/scaffolds/repository-service.config.json` plus shared utilities in `scripts/utils/**`.
- Reusable hooks register via `scripts/utils/hooks.mjs`; configs declare which hooks run per stage (`preScaffold`, `renderTemplates`, `postScaffold`) and map template tokens to resolvers.
- Aspect ejection codemods live under `scripts/eject-aspect.mjs` with per-aspect definitions in `scripts/aspects/*.aspect.mjs` (e.g., `npm run eject:analytics`, `npm run eject:users`).

---

## Claude Code Orchestration Framework

## Architecture Overview

The system is organized around the `.claude/` directory structure:

```
.claude/
├── agents/              # Subagent specifications (21 specialized agents)
├── skills/              # Skill definitions (workflow stages)
├── specs/
│   ├── groups/          # Active spec groups
│   ├── archive/         # Completed specs
│   └── schema/          # JSON validation schemas
├── context/
│   └── session.json     # Session state for cross-session recovery
├── coordination/        # Ephemeral coordination files (not committed)
├── memory-bank/         # Persistent project knowledge
│   ├── project.brief.md
│   ├── tech.context.md
│   ├── delegation.guidelines.md
│   └── best-practices/
├── scripts/             # Validation scripts for hooks
│   └── lib/             # Shared libraries (workflow-dag.mjs, hook-utils.mjs)
├── templates/           # Spec and artifact templates
├── docs/                # System documentation
├── journal/             # Fix reports and discoveries
└── settings.json        # Hooks configuration
```

## Subagent Model

21 specialized subagents, each with focused responsibilities:

| Subagent                 | Model | Purpose                                                                                                                              |
| ------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `challenger`             | opus  | MANDATORY operational feasibility check for oneoff-spec workflows (pre-implementation)                                                |
| `completion-verifier`    | opus  | Post-completion verification gates (docs, assumptions, registry, memory bank)                                                        |
| `explore`                | opus  | Investigate questions via web or codebase research; returns structured findings                                                      |
| `interface-investigator` | opus  | Surface cross-spec inconsistencies (env vars, APIs, data shapes, assumptions)                                                        |
| `spec-author`            | opus  | Author oneoff specs (no code)                                                                                                        |
| `implementer`            | opus  | Implement from approved specs                                                                                                        |
| `test-writer`            | opus  | Write tests for acceptance criteria                                                                                                  |
| `e2e-test-writer`        | opus  | Black-box E2E testing: Playwright browser tests and HTTP API tests from spec contracts only                                          |
| `unifier`                | opus  | Validate convergence                                                                                                                 |
| `code-reviewer`          | opus  | Code quality review (read-only, runs before security)                                                                                |
| `security-reviewer`      | opus  | Security review - PRDs (shift-left) and implementation (read-only)                                                                   |
| `documenter`             | opus  | Generate docs from implementation                                                                                                    |
| `refactorer`             | opus  | Code quality improvements with behavior preservation                                                                                 |
| `manual-tester`          | opus  | Bounded exploratory end-to-end verification (5 happy + 3 failure + 2 adjacent, then stop); advisory/non-blocking; runs after `/docs` |
| `prd-writer`             | opus  | Conduct discovery interviews and draft/amend PRDs (D-034 format)                                                                     |
| `prd-critic`             | opus  | Evaluate PRDs from one of four perspectives with severity ratings                                                                    |
| `prd-reader`             | opus  | Extract requirements from existing PRDs into EARS format                                                                             |
| `prd-amender`            | opus  | Push implementation discoveries back to PRDs (D-028 amendment format)                                                                |
| `doc-auditor`            | opus  | Diagnose documentation health — staleness, coverage gaps, broken refs, orphaned docs                                                 |
| `flow-verifier`          | opus  | Verify cross-boundary wiring correctness — missing imports, unregistered routes, mismatched events, disconnected handlers            |

## Spec is Contract Principle

**The spec is the authoritative source of truth.**

- Implementation must conform to spec
- Tests must verify spec requirements
- Any deviation requires spec amendment first (never deviate silently)
- Unifier validates alignment before approval

## Spec System Workflow

```
oneoff-spec:  TaskSpec → Investigation Convergence Loop (2 clean passes, auto-decision) → Challenger Convergence Loop (pre-implementation, auto-decision) → Auto-Approval → Implement + Test → Integration Verify → Unify + reviewer-focus metadata → Code Review → Security → Completion Verify
```

### Spec Types

- **TaskSpec**: Main active spec format for work that needs a written contract
- **Spec slices**: Optional lightweight sections inside the same `spec.md` for larger work; do not create separate workstream, master, or decomposed spec files

### Spec Lifecycle

1. **Draft**: Initial authoring from requirements
2. **Approved**: User-approved, ready for implementation
3. **Implementing**: Work in progress
4. **Implemented**: Acceptance criteria complete
5. **Verified**: Unifier confirmed convergence

## Validation Hooks

Hooks run automatically at various tool lifecycle points to catch issues early and enforce workflow rules. The system uses two enforcement layers: **cooperative** (session-checkpoint.mjs DAG-based phase transitions and SubagentStop recorders) and **coercive** (PreToolUse/Stop hooks that physically block tool execution). For full documentation, see `.claude/docs/HOOKS.md`.

### PostToolUse Hooks (Edit|Write)

Live PostToolUse hooks are defined in `.claude/settings.json` and documented in
`.claude/docs/HOOKS.md`. Keep this memory-bank surface high level: the live
edit-time hooks now focus on syntax/schema/frontmatter/spec/manifest-drift
validation, not advisory linting.

### PreToolUse Hooks (Coercive Enforcement)

| Hook                        | Trigger          | Purpose                                                                              |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------------ |
| `workflow-gate-enforcement` | PreToolUse Agent | Block dispatch of enforced subagent types when prerequisites not met                 |
| `workflow-file-protection`  | PreToolUse Write | Block agent writes to gate-override.json, kill switch, session.json, and session.log |

### Stop Hooks

| Hook                        | Trigger | Purpose                                                                                                       |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `workflow-stop-enforcement` | Stop    | Block session completion on missing dispatches, obligation violations, or completion-invariant check failures |

### SubagentStop Hooks

| Hook                        | Trigger      | Purpose                                                                                                                                                                                                                                                                         |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `convergence-pass-recorder` | SubagentStop | Record pass evidence via 4-tier extractor + module-import `recordPass()`                                                                                                                                                                                                        |
| `dispatch-record-hook`      | SubagentStop | Record Task-tool dispatches via session-checkpoint.mjs (sole writer). Uses SubagentStop per sg-enforcement-layer-gaps Task 22 fallback (PostToolUse+Agent unsupported). Last-write-wins on duplicate. Fail-open on any error. See HOOKS.md § SubagentStop Dispatch Record Hook. |

## Workflow Enforcement (Practice 4.3)

Workflow enforcement operates in two layers:

**Cooperative layer** (`session-checkpoint.mjs`): DAG-based phase transition validation with configurable enforcement levels (off, warn-only, graduated). Agents call `transition-phase` to advance through workflow stages. Violations are warned or blocked depending on level. Override via `override-skip` command with rationale.

**Coercive layer** (PreToolUse/Stop hooks): Physically blocks tool execution when prerequisites are not met. No cooperative participation required -- reads session.json dispatch history as the source of truth.

- `workflow-gate-enforcement.mjs` blocks dispatch of 7 enforced subagent types (implementer, test-writer, e2e-test-writer, code-reviewer, security-reviewer, documenter, completion-verifier) when workflow prerequisites are not recorded in session.json
- `workflow-stop-enforcement.mjs` blocks session completion on (a) missing mandatory dispatches (code-reviewer, security-reviewer, completion-verifier, documenter, e2e-test-writer), (b) manifest status obligation violations at `phase=complete`, (c) five completion-invariant checks at `phase=complete` with an active spec group (convergence depth, challenger stage coverage, phase DAG predecessors, artifact inventory, convergence-field sanity -- see HOOKS.md § Completion-Invariant Checks), (d) unverified deployment
- `workflow-file-protection.mjs` blocks agent writes to enforcement override files and session state files (session.json, session.log); not disabled by kill switch

**Shared DAG module** (`scripts/lib/workflow-dag.mjs`): Single source of truth for predecessor graphs, enforcement tables, and query functions consumed by both layers.

**Shared check library** (`scripts/lib/stop-hook-checks.mjs`): Pure-function module exporting `shouldRunChecks()` guard and five check functions (`checkConvergenceDepth`, `checkChallengerStages`, `checkPhaseDagPredecessors`, `checkArtifactInventory`, `checkConvergenceFieldSanity`) consumed by both the Stop hook and the `session-checkpoint.mjs verify` CLI. Ensures enforcement cannot drift between the two surfaces.

**Exempt workflows**: `oneoff-vibe`, `refactor`, and `journal-only` bypass all enforcement.

**Kill switch**: `.claude/coordination/gate-enforcement-disabled` disables gate and stop enforcement. Write protection remains active.

**Override**: `.claude/coordination/gate-override.json` with session-scoped entries allows bypassing specific gates (human terminal only).

**Fail-open**: Structural errors (missing session.json, malformed JSON, script crashes) result in exit 0. Exception: missing convergence fields default to 0 (fail-closed).

### session-checkpoint.mjs API Surface

`session-checkpoint.mjs` is the sole trusted writer for `.claude/context/session.json`. It exposes both a CLI and a module-import API.

**Module-import** (sole surface; used exclusively by `convergence-pass-recorder.mjs`):

```javascript
import { recordPass } from '.claude/scripts/session-checkpoint.mjs';

await recordPass({
  source: 'hook', // or 'parse_failed' | 'manual_fallback'
  gate: 'investigation', // one of VALID_CONVERGENCE_GATES
  clean: true, // boolean (required)
  findingCount: 0, // optional
  findingsHash: '<64-hex>', // optional
  agentType: 'interface-investigator',
  agentId: '<uuid>', // optional
});
```

The CLI rejects **every** `--source` value (exit 2, `SOURCE_FORBIDDEN_VIA_CLI`). `recordPass()` is the sole permitted writer for pass evidence records. Rationale: sg-e2e-runtime-connectivity observed 18 passes, 4 consecutive clean, but derivation returned 0 because manual mirrors interleaved with hook records broke the streak. Removing the CLI write surface makes the 2-consecutive-clean invariant non-counterfeitable.

**Relevant CLI ops**:

- `record-pass` -- CLI surface removed. Every `--source` value exits non-zero with `SOURCE_FORBIDDEN_VIA_CLI`. Pass evidence writes are programmatic via `recordPass()` module import.
- `update-convergence <gate>` -- derive `clean_pass_count` via tail-walk with streak-reset semantics (bound: last 200 entries)
- `update-circuit-breaker --gate <gate> --event <failure|success>` -- atomically mutate per-gate circuit-breaker state in `session.convergence_log_failures.<gate>` (degraded mode threshold: 3 consecutive failures)
- `verify [--spec-group <sg-id>]` -- locally run the five completion-invariant checks against the active (or specified) spec group and print per-check PASS/FAIL summary. Exit 0 on clean, 1 on any failure. Shares the library with the Stop hook; respects kill switch and exempt workflows. See HOOKS.md § Completion-Invariant Checks § Local verification.
- `transition-phase <phase>`, `override-skip <phase> <rationale>`, `reset-enforcement`

For the full convergence architecture (4-tier extraction pipeline, streak-reset tail-walk, circuit-breaker degraded mode, source enum), see `.claude/docs/WORKFLOW-ENFORCEMENT.md` § Evidence-Based Convergence.

### path-validate Helper Contract

`.claude/scripts/lib/path-validate.mjs` is the shared POSIX path-validation library consumed by `validate-manifest.mjs`, `session-checkpoint.mjs`, and `migrate-manifest.mjs` (sg-enforcement-layer-gaps Task 5 / REQ-M1-010 / AC-1.5, AC-1.6).

**API**:

- `validatePath(candidate, { allowNull?, projectRoot? })` -- non-throwing, returns `{ valid, reason?, detail? }`
- `assertValidPath(candidate, opts, fieldName)` -- throws `PATH_VALIDATE_REJECT` with structured `err.code`, `err.reason`, `err.detail`, `err.fieldName` on failure
- `PATH_REJECT_REASONS` -- frozen enum: `NULL_VALUE`, `EMPTY_STRING`, `NOT_A_STRING`, `ABSOLUTE_PATH`, `PARENT_TRAVERSAL`, `SYMLINK`

**POSIX-only ruleset**: rejects absolute paths, `..` components, symlinks (when `projectRoot` supplied), and empty strings (unless `allowNull: true`). Windows drive letters and UNC paths are deliberately out of scope -- see OQ-8 resolution in the spec and follow-up PRD for Windows support.

**Division of responsibility**: the library is pure (no normalization). Consumers normalize before calling -- e.g., `session-checkpoint.mjs normalizePathCandidate()` handles URL-encoded components, Unicode NFKC, and slash homoglyphs before validation. This keeps the library deterministic and unit-testable while letting each consumer apply channel-appropriate normalization.

### UNTRUSTED_AGENT_TYPE_SENTINEL Trust Pattern

`.claude/scripts/dispatch-record-hook.mjs:104` defines `UNTRUSTED_AGENT_TYPE_SENTINEL = 'unknown_fallback'` per sg-enforcement-layer-gaps AC-11.4 / SEC-004.

**Rationale**: PreToolUse is the authoritative source for `subagent_type` (dispatcher-controlled). SubagentStop payloads are agent-controlled and MUST NOT be treated as authoritative. When SubagentStop fires with no prior in-flight entry for `agent_id`, the fallback record uses the sentinel instead of trusting the payload-reported `agent_type`.

**Invariant**: downstream consumers (workflow-gate-enforcement, session-checkpoint queries) MUST NOT treat `agent_type === 'unknown_fallback'` as equivalent to a real agent type for type-specific gate prerequisites. Sentinel records count as dispatch-happened audit evidence only. The stderr warning on fallback preserves the reported type for post-hoc investigation without elevating it to trusted status.

## Workflow Types

### oneoff-vibe (Small tasks)

```
Request → Route → Delegate to subagent → Synthesize → Commit
```

- Simple changes with clear bounded low-risk scope
- No formal spec required
- Single subagent dispatch

### oneoff-spec (Medium tasks)

```
Request → Route → /prd (gather-criticize loop, optional TAD) → [Optional: PRD Draft] → Spec →
  Investigation Convergence Loop (2 clean passes, auto-decision) →
  Challenger Convergence Loop (pre-implementation, auto-decision) →
  Auto-Approval (passthrough logging) →
  [Parallel: Implement + Test + E2E Test (E2E only for cross-boundary specs)] →
  Integration Verify → Unify + reviewer-focus metadata →
  Code Review → Security →
  Completion Verification →
  [If UI: Browser Test] → Docs → [If PRD: PRD Push] → Commit
```

- Requires formal specification
- No decomposition step (TaskSpec is implemented directly; optional slices stay inside `spec.md`)
- Investigation is MANDATORY (single-spec mode: Category 7, env/dep, external surfaces)
- Parallel implementation and testing
- Full review chain

For large tasks, keep one `spec.md` and use optional internal spec slices rather than separate workstream/master/decomposed files.

**Investigation Checkpoint**: `/investigate` is MANDATORY before implementation for oneoff-spec (mode: `single-spec`). It surfaces cross-boundary inconsistencies (env vars, API contracts, deployment assumptions) that would otherwise become runtime bugs.

**Challenger Stage**: `/challenge` is required at `pre-implementation` and runs as a convergence loop (2 consecutive clean passes, auto-decision).

## Branch Naming Convention

Spec-based work uses the branch naming pattern `sg-<feature-name>/<action>`:

- **Pattern**: `sg-<feature-name>/<action>`
- **Examples**:
  - `sg-selective-context-copy/implement` - Implementation of selective copy feature
  - `sg-auth-system/fix-logout` - Fix for auth system logout
  - `sg-e2e-add-file/implement` - E2E test implementation

**Purpose**: This convention enables spec derivation from branch names. The spec group ID is the first path segment (e.g., `sg-auth-system` from `sg-auth-system/fix-logout`). Branches not matching the `sg-*` pattern are not spec-linked.

## Session State

Cross-session recovery via `.claude/context/session.json`:

```json
{
  "phase_checkpoint": {
    "phase": "implementing",
    "substages_visited": ["pre-impl"],
    "last_transition_at": "2026-04-21T00:00:00Z"
  }
}
```

### Top-Level Convergence Fields

- `convergence.<gate>.clean_pass_count` -- derived count of consecutive clean hook-sourced passes (read by coercive enforcement)
- `convergence_evidence.<gate>.passes[]` -- append-only pass evidence array (streak-reset tail-walk source of truth)
- `convergence_log_failures.<gate>` -- per-gate circuit-breaker state (`consecutive_count`, `last_failure_at`, `degraded_mode`, `entered_degraded_at`) for session.log write failure tracking

### Valid Phases

The session tracks workflow progress through 14 active phases:

`prd_gathering`, `spec_authoring`, `investigating`, `awaiting_approval` (backwards compat), `auto_approval`, `challenging`, `implementing`, `testing`, `verifying`, `reviewing`, `completion_verifying`, `documenting`, `journaling`, `complete`

Phases added by workflow enforcement: `challenging` (mandatory feasibility checks), `completion_verifying` (post-completion gates), `documenting` (documentation generation), `auto_approval` (passthrough logging after convergence). Phase transitions are validated via DAG-based predecessor rules in `session-checkpoint.mjs`.

## Key File Locations

| Artifact                   | Location                                                                       |
| -------------------------- | ------------------------------------------------------------------------------ |
| Active specs               | `.claude/specs/groups/<spec-group-id>/`                                        |
| Manifest                   | `.claude/specs/groups/<spec-group-id>/manifest.json`                           |
| Session state              | `.claude/context/session.json`                                                 |
| Convergence diagnostic log | `.claude/context/session.log` (FULL_BLOCK, mode 0600)                          |
| Agent definitions          | `.claude/agents/<agent-name>.md`                                               |
| Skill definitions          | `.claude/skills/<skill-name>/SKILL.md`                                         |
| Session state writer       | `.claude/scripts/session-checkpoint.mjs` (CLI + `recordPass()` module export)  |
| Shared DAG module          | `.claude/scripts/lib/workflow-dag.mjs`                                         |
| Shared stop-hook checks    | `.claude/scripts/lib/stop-hook-checks.mjs`                                     |
| Hook utilities             | `.claude/scripts/lib/hook-utils.mjs`                                           |
| Sync constants             | `.claude/scripts/lib/sync-constants.mjs`                                       |
| Path validation helper     | `.claude/scripts/lib/path-validate.mjs` (POSIX-only; shared consumer library)  |
| Dispatch record hook       | `.claude/scripts/dispatch-record-hook.mjs` (SubagentStop; sole-writer via CLI) |
| Coordination files         | `.claude/coordination/`                                                        |

## Sync Validation Pipeline

`compute-hashes --update` runs three validation gates before writing `.claude/metaclaude-registry.json`: orphan detector (unregistered files under sync-scoped roots), import-graph validator (acorn AST, per-edge relative-import resolution + registry lookup), and cross-bundle closure check (importer's bundle must equal importee's bundle or be a descendant). Together these catch the "half-wired artifact" drift class at the author before consumers crash with `ERR_MODULE_NOT_FOUND` at runtime.

**Two-tier enforcement**: `compute-hashes --update` hard-blocks on violations (author-side); `metaclaude-cli sync` warns but does not strand consumers (consumer-side). Both surfaces share the same gate logic and the same structured violation shape.

**Trust root**: All security-relevant constants (`BUNDLE_INHERITANCE`, `WHITELIST_GLOBS`, `SKIP_GATES_OVERUSE_THRESHOLD`, sync-scoped root list) live in `.claude/scripts/lib/sync-constants.mjs` as JavaScript `const` declarations, **not** in the registry itself. A compromised registry cannot silently raise thresholds or broaden bundle inheritance -- any change to these constants requires a source-code diff visible in review.

**Escape hatch**: `compute-hashes --update --skip-gates="<reason ≥ 10 chars>"` bypasses gates, appending one JSON line to `.claude/audit/skip-gates.jsonl`. No env-var bypass. Overuse warning after 5 uses in a rolling 7-day window. The composite Husky v9 pre-commit hook (`validate-orphans` + `skip-gates-append-only-check` + import-graph validator) enforces append-only semantics on the audit log.

For the operational guide see `.claude/docs/SYNC-SYSTEM.md`; for the internals (pipeline architecture, Zod schema extension points, closure check pseudocode, TOCTOU model) see `.claude/docs/SYNC-SYSTEM-INTERNALS.md`.

## Test Infrastructure

### vitest Peer-Dependency Pinning Drift

**Pattern**: vitest publishes `vitest`, `@vitest/runner`, `@vitest/expect`, `@vitest/snapshot`, `@vitest/utils`, `@vitest/coverage-v8`, and (optionally) `@vitest/ui` as a cohort that must stay exactly version-aligned. Transitive installs (`npm install @vitest/runner@latest`, CI lockfile refresh, etc.) can silently drop the pin on a sibling package — yielding a mixed-version tree where `vitest` at 4.0.18 coexists with `@vitest/runner` at 4.1.4. The internal API shape differs across patch boundaries; the net effect observed during `sg-enforcement-layer-gaps` was **+50 net-new test failures at the 4.0.18 → 4.1.4 boundary** with no code change on the test side. Diagnosis is slow: error messages surface as generic assertion failures, stack traces point into node_modules, and `npm ls vitest` is the only reliable signal.

**Practice (pin-all-vitest-packages)**: Pin every `vitest` and `@vitest/*` entry in `package.json` to the same exact version — no `^`, no `~`. When bumping, bump the whole cohort atomically.

```json
{
  "devDependencies": {
    "vitest": "4.0.18",
    "@vitest/runner": "4.0.18",
    "@vitest/expect": "4.0.18",
    "@vitest/coverage-v8": "4.0.18"
  }
}
```

**Offline-install caveat (EC-5)**: Pin enforcement depends on the lockfile. Fully-offline installs against a stale `node_modules/` cannot detect drift that happened before the cache was snapshotted; the postinstall guard (below) is the runtime backstop.

**Postinstall guard**: `.claude/scripts/verify-vitest-pins.mjs` runs as `npm`'s `postinstall` lifecycle hook. It reads `package.json`, enumerates `vitest` + `@vitest/*` entries in `dependencies` / `devDependencies`, and exits non-zero on any mismatch (carat prefix, tilde prefix, or version disagreement). The script requires Node ≥ 18 (ties to `package.json#engines`); older runtimes fail with a clear stderr message. If no `vitest` / `@vitest/*` entries appear in `package.json`, the script logs `INFO: No @vitest packages installed; verification skipped` and exits 0 (graceful skip — presence detection is via `package.json` parse, not via `node_modules` filesystem glob, to avoid false matches on legacy trees).

Invocation surface: `node .claude/scripts/verify-vitest-pins.mjs`. Wired from `"postinstall"` in the root `package.json`.

## Progress Heartbeat Discipline (Practice 4.2)

Long-running spec implementations must emit periodic progress signals. The `progress-heartbeat-check` hook enforces this automatically:

- Monitors `last_progress_update` timestamp in the spec group's `manifest.json`
- **Warning** at 15 minutes of silence — reminds the agent to log progress
- **Block** after 3 warnings — further edits are blocked until progress is logged
- Logging progress resets the warning counter to 0

Agents working on spec-based tasks should update progress in the manifest before the heartbeat triggers. This prevents silent stalls where an agent appears active but has stopped making meaningful progress.

## Independent Verification (Practice 2.4)

When `implementer`, `test-writer`, and `e2e-test-writer` run in parallel, neither the test-writer nor the e2e-test-writer **may see the implementation**. This is the spec-derived independent verification constraint:

- The test-writer receives only the **spec** (acceptance criteria, task list, evidence table) — never implementation file paths or code
- Tests are derived from the spec's acceptance criteria, not from reading implementation details
- This ensures tests verify the _contract_, not the _implementation_ — catching cases where code passes its own logic but violates the spec

When dispatching in parallel, the main agent must provide the test-writer with the spec artifact only. If the test-writer needs to understand interfaces or types, those should come from the spec's evidence table or contract definitions, not from implementation files.

## Assumption Tracking (Practice 1.10)

When multiple agents implement in parallel, each agent's `TODO(assumption)` comments create a distributed assumption graph. After parallel implementation and before the review gate, the main agent MUST scan modified files for `TODO(assumption)` markers, group by topic, and flag conflicts (two agents assumed different values for the same integration point). A single agent's assumption is a local decision; multiple agents' assumptions about the same topic are a distributed consensus problem.

## Parallel Execution

For large tasks, the main agent coordinates parallel execution from one `spec.md`:

- Optional spec slices inside `spec.md`; avoid separate spec files for decomposition
- `implementer`, `test-writer`, and `e2e-test-writer` run in parallel (no ordering constraint — test-writer and e2e-test-writer work from spec only; e2e-test-writer dispatched only for cross-boundary specs)
- `code-reviewer` and `security-reviewer` run in parallel after unifier and reviewer-focus metadata prerequisites
- Both reviewers converge independently; `documenter` waits for both convergences
- Main agent handles integration and synthesis

## Convergence Gates

Before merge, all gates must pass. Each gate marked with **(loop)** runs under the Convergence Loop Protocol — requiring 2 consecutive clean passes, not single-pass:

- Spec complete
- Investigation convergence **(loop)** — auto-decision engine integration
- Challenger convergence **(loop)** — pre-implementation, auto-decision engine
- All ACs implemented
- All tests passing (100% AC coverage)
- Unifier validation passed **(loop)**
- Code review passed (no High/Critical issues) **(loop)**
- Security review passed **(loop)**
- Completion verification passed **(loop)**
- E2E tests passed (if cross-boundary)
- Browser tests passed (if UI)
- Documentation generated

## Example Workflow: oneoff-spec (Logout Button)

```markdown
User: "Add a logout button to the dashboard"

1. `/route` → oneoff-spec (medium complexity)
2. Use `/prd` to gather requirements about placement, behavior, error handling
3. Dispatch Spec-author subagent → Create TaskSpec with 4 ACs, 6 tasks
4. [If spec references auth system] Dispatch Interface-investigator →
   Surface any conflicts with existing auth contracts
5. User approves spec (after resolving any investigation findings)
6. `/challenge` → MANDATORY operational feasibility check (stage: pre-implementation)
7. [Parallel] Dispatch Implementer + Test-writer subagents
8. Integration Verify → Dispatch Unifier subagent → Validate convergence
9. Assemble reviewer-focus metadata
10. [Parallel] Dispatch Code-reviewer + Security-reviewer subagents
11. Dispatch Browser-tester subagent → UI testing
12. Dispatch Documenter subagent → Generate API docs
13. Synthesize results → Commit with spec evidence
```

## Example Workflow: Large Spec With Slices

```markdown
User: "Build a deployment pipeline with build, deploy, and monitoring"

1. `/route` → oneoff-spec (large, use internal spec slices)
2. Use `/prd` to gather requirements across build, deploy, and monitoring
3. Dispatch Spec-author subagent → Create one `spec.md` with optional slices
4. `/investigate sg-deployment-pipeline` → MANDATORY checkpoint
   - Finds: GIT_SSH_KEY_PATH vs GIT_SSH_KEY_BASE64 conflict
   - Finds: Missing LOG\_\* vars in monitoring slice
   - Finds: Container image format inconsistency
5. Surface decisions to user → User chooses canonical patterns
6. Update `spec.md` with decisions
7. Re-run `/investigate` → Clean (no issues)
8. User approves spec
9. `/challenge` → MANDATORY operational feasibility check (stage: pre-implementation)
10. [Parallel] Dispatch Implementer + Test-writer + E2E-test-writer where relevant
11. Integration Verify → Unify → Validate convergence
12. Assemble reviewer-focus metadata
13. Continue with Code Review → Security → Docs → Commit
```

## Trace System

The trace system generates pre-computed architectural summaries of the codebase. Agents consume these summaries instead of performing expensive Explore dispatches.

### Architecture

```
trace.config.json          # Module definitions with fileGlobs
    ↓
trace-generate.mjs         # Main generation script
    ├── analyzeFile()       # Parse exports (symbol, type, signature, lineNumber) and imports per file
    ├── parseExports()      # Regex-based export extraction with signature capture
    └── parseImports()      # Regex-based import extraction (static only)
    ↓
lib/trace-utils.mjs        # Shared utilities
    ├── loadTraceConfig()   # Load and validate trace.config.json
    ├── fileToModule()      # Map file path → module ID (first match)
    ├── fileToModules()     # Map file path → all matching module IDs (for ambiguity detection)
    ├── isTraceStale()      # Check trace freshness against staleness threshold
    ├── matchesGlob()       # File glob matching
    ├── findFilesMatchingGlobs()  # Find all files matching module globs
    └── sanitizeMarkdown()  # Escape CommonMark special chars for .md output
    ↓
lib/high-level-trace.mjs   # High-level trace generation
    ├── generateHighLevelTrace()          # Entry point: produces JSON + MD
    ├── generateHighLevelTraceJSON()      # Build high-level JSON structure
    ├── generateHighLevelTraceMarkdown()  # Render high-level MD summary
    └── validateHighLevelTrace()          # Schema validation
    ↓
traces/                    # Output directory (not committed, not synced)
    ├── high-level.json    # Module landscape with dependencies/dependents
    ├── high-level.md      # Human-readable module summary
    └── low-level/
        ├── <module-id>.json          # Per-module detailed trace (exports, imports, files)
        ├── <module-id>.md            # Per-module human-readable summary
        ├── <module-id>.calls.json    # Per-module call graph (fenced from main-agent reads; can balloon)
        └── <module-id>.summary.json  # Call-graph summary (top-20 callees, counts) — safe for main-agent
```

### Trace Data Fields

**Low-level trace exports** include:

- `symbol`: Export name (e.g., `parseExports`)
- `type`: Export type (e.g., `function`, `class`, `const`, `type`)
- `signature`: Display-facing function signature, truncated at 200 chars (e.g., `(source: string): Array<{...}>`)
- `signatureRaw`: Extended capture up to 500 chars, stores unparsed text when regex fails
- `lineNumber`: 1-indexed source line number of the export declaration

**High-level trace modules** include:

- `dependencies[]`: String array of moduleIds this module imports from
- `dependents[]`: String array of moduleIds that import from this module
- `skippedFiles[]`: Files that matched multiple module globs (configuration error indicator)

### Consumption Patterns

**Main agent** (before dispatch):

- Read `traces/high-level.md` for module landscape and dependency graph
- Use module information to inform routing and dispatch decisions
- This is the Pre-Computed Summary Exception to delegation-first

**Subagents** (implement, test, code-review, security, explore):

- Receive relevant trace file paths in dispatch prompts
- Read `traces/low-level/<module-id>.json` for module-specific structural detail
- Match task file paths against `trace.config.json` module `fileGlobs` to find relevant traces
- Check freshness via `isTraceStale(moduleId, config)` before trusting exact details

**Graceful degradation**: When traces are unavailable (no traces directory, no config, no matching modules), all consumers proceed without trace context -- identical to pre-trace behavior. No error or warning produced.

### Trace Scripts (synced via registry)

| Script                       | Purpose                                     |
| ---------------------------- | ------------------------------------------- |
| `trace-generate.mjs`         | Generate all trace files from config        |
| `lib/trace-utils.mjs`        | Shared utilities (config, staleness, globs) |
| `lib/high-level-trace.mjs`   | High-level trace JSON/MD generation         |

### Key Constraints

- Regex-based parsing only (no AST) for portability
- Trace files contain structural metadata only -- never source code, env values, or credentials
- Trace output files are NOT synced via registry (each project generates its own)
- Only trace scripts sync to consumer projects
- `isTraceStale()` checks file modification time against configurable staleness threshold

## Structured Documentation System

The structured documentation system provides machine-parseable YAML documentation that sits between low-level traces and high-level memory-bank content.

### Three-Layer Documentation Model

```
traces (file-level)  →  structured docs (module-level)  →  memory-bank (process-level)
```

### Key Locations

| Artifact   | Location                              |
| ---------- | ------------------------------------- |
| Schema     | `.claude/docs/structured/schema.yaml` |
| Docs       | `.claude/docs/structured/`            |
| Templates  | `.claude/templates/structured-docs/`  |
| Validator  | `.claude/scripts/docs-validate.mjs`   |
| Generator  | `.claude/scripts/docs-generate.mjs`   |
| Scaffolder | `.claude/scripts/docs-scaffold.mjs`   |
| Shared lib | `.claude/scripts/lib/yaml-utils.mjs`  |

### Document Types

- `architecture.yaml` - Module dependency map
- `flows/index.yaml` + `flows/*.yaml` - Flow definitions with steps
- `glossary.yaml` - Term definitions
- `decisions.yaml` - Architecture decision records (extension)
- `runbooks.yaml` - Operational procedures (extension)

### Sync & Hooks

- Registry category: `structured-docs-templates` (with `_sync_policy: "never-overwrite"` -- templates only sync if target file does not exist)
- PostToolUse hook triggers on `.claude/docs/**/*.yaml` for automatic validation

## S-DLC Team Relationship

When the S-DLC system is active, teams operate as a coordination layer above the skills/agents defined here:

- Teams wrap existing agents (composition, not replacement)
- Deliberation happens at team level; execution via agents
- Skills emit lifecycle events for dashboard observability (planned, not yet implemented)
- Local development works identically with or without S-DLC

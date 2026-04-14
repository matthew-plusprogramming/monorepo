---
last_reviewed: 2026-03-18
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

The following sections describe the Claude Code agent orchestration framework used across all projects. This is the shared infrastructure for specs, subagents, validation hooks, and workflow coordination.

### Architecture Overview

The system is organized around the `.claude/` directory structure:

```
.claude/
├── agents/              # Subagent specifications (23 specialized agents)
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

### Subagent Model

23 specialized subagents, each with focused responsibilities:

| Subagent                 | Model | Purpose                                                                                                                           |
| ------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| `atomicity-enforcer`     | opus  | Validate atomic specs meet atomicity criteria                                                                                     |
| `atomizer`               | opus  | Decompose specs into atomic specs with single responsibility                                                                      |
| `challenger`             | opus  | MANDATORY operational feasibility check for oneoff-spec and orchestrator workflows (pre-implementation/test/review/orchestration) |
| `completion-verifier`    | opus  | Post-completion verification gates (docs, assumptions, registry, memory bank)                                                     |
| `explore`                | opus  | Investigate questions via web or codebase research; returns structured findings                                                   |
| `interface-investigator` | opus  | Surface cross-spec inconsistencies (env vars, APIs, data shapes, assumptions)                                                     |
| `spec-author`            | opus  | Author workstream specs (no code)                                                                                                 |
| `implementer`            | opus  | Implement from approved specs                                                                                                     |
| `test-writer`            | opus  | Write tests for acceptance criteria                                                                                               |
| `e2e-test-writer`        | opus  | Black-box E2E testing: Playwright browser tests and HTTP API tests from spec contracts only                                       |
| `unifier`                | opus  | Validate convergence                                                                                                              |
| `code-reviewer`          | opus  | Code quality review (read-only, runs before security)                                                                             |
| `security-reviewer`      | opus  | Security review - PRDs (shift-left) and implementation (read-only)                                                                |
| `documenter`             | opus  | Generate docs from implementation                                                                                                 |
| `refactorer`             | opus  | Code quality improvements with behavior preservation                                                                              |
| `facilitator`            | opus  | Orchestrate multi-workstream projects with git worktrees                                                                          |
| `browser-tester`         | opus  | Browser-based UI testing                                                                                                          |
| `prd-writer`             | opus  | Conduct discovery interviews and draft/amend PRDs (D-034 format)                                                                  |
| `prd-critic`             | opus  | Evaluate PRDs from one of four perspectives with severity ratings                                                                 |
| `prd-reader`             | opus  | Extract requirements from existing PRDs into EARS format                                                                          |
| `prd-amender`            | opus  | Push implementation discoveries back to PRDs (D-028 amendment format)                                                             |
| `doc-auditor`            | opus  | Diagnose documentation health — staleness, coverage gaps, broken refs, orphaned docs                                              |
| `flow-verifier`          | opus  | Verify cross-boundary wiring correctness — missing imports, unregistered routes, mismatched events, disconnected handlers         |

### Spec is Contract Principle

**The spec is the authoritative source of truth.**

- Implementation must conform to spec
- Tests must verify spec requirements
- Any deviation requires spec amendment first (never deviate silently)
- Unifier validates alignment before approval

### Spec System Workflow

```
oneoff-spec:  TaskSpec → Investigation Convergence Loop (2 clean passes, auto-decision) → Challenger Convergence Loop (pre-implementation, auto-decision) → Auto-Approval → Implement + Test → Challenge (pre-test, single-pass) → Integration Verify → Unify → Challenge (pre-review, single-pass) → Code Review → Security → Completion Verify
orchestrator: WorkstreamSpecs → Atomize → Enforce → Investigation Convergence Loop (2 clean passes, auto-decision) → Challenger Convergence Loop (pre-orchestration, auto-decision) → Auto-Approval → Implement + Test → Challenge (pre-test, single-pass) → Integration Verify → Unify → Challenge (pre-review, single-pass) → Code Review → Security → Completion Verify
```

### Spec Types

- **TaskSpec**: Single-feature specifications for medium tasks
- **WorkstreamSpec**: Component of a larger orchestrated effort
- **MasterSpec**: Coordinates multiple workstreams with contracts

### Spec Lifecycle

1. **Draft**: Initial authoring from requirements
2. **Atomized**: Decomposed into atomic specs (orchestrator workflows only)
3. **Enforced**: Validated against atomicity criteria (orchestrator workflows only)
4. **Approved**: User-approved, ready for implementation
5. **Implementing**: Work in progress
6. **Implemented**: All atomic specs complete
7. **Verified**: Unifier confirmed convergence

### Validation Hooks

Hooks run automatically at various tool lifecycle points to catch issues early and enforce workflow rules. The system uses two enforcement layers: **cooperative** (session-checkpoint.mjs DAG-based phase transitions, advisory SubagentStop reminders) and **coercive** (PreToolUse/Stop hooks that physically block tool execution). For full documentation, see `.claude/docs/HOOKS.md`.

#### PostToolUse Hooks (Edit|Write)

| Hook                         | Trigger                 | Purpose                                     |
| ---------------------------- | ----------------------- | ------------------------------------------- |
| `typescript-typecheck`       | `*.ts,*.tsx`            | Type checking via workspace-aware tsc       |
| `eslint-check`               | `*.ts,*.tsx,*.js,*.jsx` | Linting via workspace-aware ESLint          |
| `json-validate`              | `*.json`                | JSON syntax validation                      |
| `claude-md-drift`            | `*CLAUDE.md`            | Detect CLAUDE.md drift from canonical base  |
| `manifest-validate`          | `*manifest.json`        | Validate manifest against spec-group schema |
| `template-validate`          | `.claude/templates/*`   | Validate template structure                 |
| `registry-hash-verify`       | `.claude/**`            | Artifact hash verification                  |
| `agent-frontmatter-validate` | `.claude/agents/*.md`   | Agent frontmatter schema validation         |
| `skill-frontmatter-validate` | `*SKILL.md`             | Skill frontmatter schema validation         |
| `spec-schema-validate`       | `.claude/specs/**/*.md` | JSON schema validation for specs            |
| `spec-validate`              | `.claude/specs/**/*.md` | Spec markdown structure validation          |

#### PreToolUse Hooks (Coercive Enforcement)

| Hook                        | Trigger          | Purpose                                                                |
| --------------------------- | ---------------- | ---------------------------------------------------------------------- |
| `workflow-gate-enforcement` | PreToolUse Agent | Block dispatch of enforced subagent types when prerequisites not met   |
| `workflow-file-protection`  | PreToolUse Write | Block agent writes to gate-override.json and gate-enforcement-disabled |
| `trace-read-enforcement`    | PreToolUse Edit  | Block edits to files in traced modules unless trace was read           |

#### Stop Hooks

| Hook                        | Trigger | Purpose                                                        |
| --------------------------- | ------- | -------------------------------------------------------------- |
| `workflow-stop-enforcement` | Stop    | Block session completion when mandatory dispatches are missing |

#### SubagentStop Hooks

| Hook                        | Trigger      | Purpose                                                                 |
| --------------------------- | ------------ | ----------------------------------------------------------------------- |
| `convergence-gate-reminder` | SubagentStop | Remind main agent to update convergence gates after subagent completion |

### Workflow Enforcement (Practice 4.3)

Workflow enforcement operates in two layers:

**Cooperative layer** (`session-checkpoint.mjs`): DAG-based phase transition validation with configurable enforcement levels (off, warn-only, graduated). Agents call `transition-phase` to advance through workflow stages. Violations are warned or blocked depending on level. Override via `override-skip` command with rationale.

**Coercive layer** (PreToolUse/Stop hooks): Physically blocks tool execution when prerequisites are not met. No cooperative participation required -- reads session.json dispatch history as the source of truth.

- `workflow-gate-enforcement.mjs` blocks dispatch of 7 enforced subagent types (implementer, test-writer, e2e-test-writer, code-reviewer, security-reviewer, documenter, completion-verifier) when workflow prerequisites are not recorded in session.json
- `workflow-stop-enforcement.mjs` blocks session completion when mandatory dispatches (code-reviewer, security-reviewer, completion-verifier, documenter) have not occurred
- `workflow-file-protection.mjs` blocks agent writes to enforcement override files (not disabled by kill switch)

**Shared DAG module** (`scripts/lib/workflow-dag.mjs`): Single source of truth for predecessor graphs, enforcement tables, and query functions consumed by both layers.

**Exempt workflows**: `oneoff-vibe`, `refactor`, and `journal-only` bypass all enforcement.

**Kill switch**: `.claude/coordination/gate-enforcement-disabled` disables gate and stop enforcement. Write protection remains active.

**Override**: `.claude/coordination/gate-override.json` with session-scoped entries allows bypassing specific gates (human terminal only).

**Fail-open**: Structural errors (missing session.json, malformed JSON, script crashes) result in exit 0. Exception: missing convergence fields default to 0 (fail-closed).

### Workflow Types

#### oneoff-vibe (Small tasks)

```
Request → Route → Delegate to subagent → Synthesize → Commit
```

- Simple changes with clear scope
- No formal spec required
- Single subagent dispatch

#### oneoff-spec (Medium tasks)

```
Request → Route → /prd (gather-criticize loop, optional TAD) → [Optional: PRD Draft] → Spec →
  Investigation Convergence Loop (2 clean passes, auto-decision) →
  Challenger Convergence Loop (pre-implementation, auto-decision) →
  Auto-Approval (passthrough logging) →
  [Parallel: Implement + Test + E2E Test (E2E only for cross-boundary specs)] →
  Challenge (pre-test, single-pass) → Integration Verify → Unify →
  Challenge (pre-review, single-pass) →
  Code Review → Security →
  Completion Verification →
  [If UI: Browser Test] → Docs → [If PRD: PRD Push] → Commit
```

- Requires formal specification
- No atomization step (TaskSpec is implemented directly)
- Investigation is MANDATORY (single-spec mode: Category 7, env/dep, external surfaces)
- Parallel implementation and testing
- Full review chain

#### orchestrator (Large tasks)

```
Request → Route → /prd (gather-criticize loop, optional TAD) → [Optional: PRD Draft] → ProblemBrief →
  [Parallel: WorkstreamSpecs] → MasterSpec →
  Investigation Convergence Loop (2 clean passes, auto-decision) →
  Challenger Convergence Loop (pre-orchestration, auto-decision) →
  Auto-Approval (passthrough logging) →
  /orchestrate (allocates worktrees, dispatches facilitator) →
  [Parallel per workstream: Implement + Test + E2E Test (E2E only for cross-boundary specs)] →
  Challenge (pre-test, single-pass) → Integration Verify →
  Unify →
  Challenge (pre-review, single-pass) →
  Code Review → Security → Completion Verification →
  Browser Test → Docs → [If PRD: PRD Push] → Commit
```

- 3+ workstreams
- Git worktree isolation
- Cross-workstream contract validation

**Investigation Checkpoint**: `/investigate` is MANDATORY before implementation for both oneoff-spec (mode: `single-spec`) and orchestrator (mode: `standard`) workflows. It surfaces cross-boundary inconsistencies (env vars, API contracts, deployment assumptions) that would otherwise become runtime bugs.

**Challenger Stages**: `/challenge` is MANDATORY at four workflow stages: `pre-implementation` (convergence loop after investigation convergence), `pre-test` (single-pass after impl), `pre-review` (single-pass after unify), and `pre-orchestration` (convergence loop after investigation convergence -- orchestrator only). The `pre-implementation` and `pre-orchestration` stages run as convergence loops (2 consecutive clean passes, auto-decision); `pre-test` and `pre-review` are single-pass checks.

### Branch Naming Convention

Spec-based work uses the branch naming pattern `sg-<feature-name>/<action>`:

- **Pattern**: `sg-<feature-name>/<action>`
- **Examples**:
  - `sg-selective-context-copy/implement` - Implementation of selective copy feature
  - `sg-auth-system/fix-logout` - Fix for auth system logout
  - `sg-e2e-add-file/implement` - E2E test implementation

**Purpose**: This convention enables spec derivation from branch names. The spec group ID is the first path segment (e.g., `sg-auth-system` from `sg-auth-system/fix-logout`). Branches not matching the `sg-*` pattern are not spec-linked.

### Session State

Cross-session recovery via `.claude/context/session.json`:

```json
{
  "phase_checkpoint": {
    "phase": "implementing",
    "atomic_specs_pending": ["as-003", "as-004"],
    "atomic_specs_complete": ["as-001", "as-002"],
    "last_completed": "as-002"
  }
}
```

#### Valid Phases

The session tracks workflow progress through 15 phases:

`prd_gathering`, `spec_authoring`, `atomizing`, `enforcing`, `investigating`, `awaiting_approval` (backwards compat), `auto_approval`, `challenging`, `implementing`, `testing`, `verifying`, `reviewing`, `completion_verifying`, `documenting`, `journaling`, `complete`

Phases added by workflow enforcement: `challenging` (mandatory feasibility checks), `completion_verifying` (post-completion gates), `documenting` (documentation generation), `auto_approval` (passthrough logging after convergence). Phase transitions are validated via DAG-based predecessor rules in `session-checkpoint.mjs`.

### Key File Locations

| Artifact           | Location                                             |
| ------------------ | ---------------------------------------------------- |
| Active specs       | `.claude/specs/groups/<spec-group-id>/`              |
| Atomic specs       | `.claude/specs/groups/<spec-group-id>/atomic/`       |
| Manifest           | `.claude/specs/groups/<spec-group-id>/manifest.json` |
| Session state      | `.claude/context/session.json`                       |
| Agent definitions  | `.claude/agents/<agent-name>.md`                     |
| Skill definitions  | `.claude/skills/<skill-name>/SKILL.md`               |
| Shared DAG module  | `.claude/scripts/lib/workflow-dag.mjs`               |
| Hook utilities     | `.claude/scripts/lib/hook-utils.mjs`                 |
| Coordination files | `.claude/coordination/`                              |

### Progress Heartbeat Discipline (Practice 4.2)

Long-running spec implementations must emit periodic progress signals. The `progress-heartbeat-check` hook enforces this automatically:

- Monitors `last_progress_update` timestamp in the spec group's `manifest.json`
- **Warning** at 15 minutes of silence — reminds the agent to log progress
- **Block** after 3 warnings — further edits are blocked until progress is logged
- Logging progress resets the warning counter to 0

Agents working on spec-based tasks should update progress in the manifest before the heartbeat triggers. This prevents silent stalls where an agent appears active but has stopped making meaningful progress.

### Independent Verification (Practice 2.4)

When `implementer`, `test-writer`, and `e2e-test-writer` run in parallel, neither the test-writer nor the e2e-test-writer **may see the implementation**. This is the spec-derived independent verification constraint:

- The test-writer receives only the **spec** (acceptance criteria, task list, evidence table) — never implementation file paths or code
- Tests are derived from the spec's acceptance criteria, not from reading implementation details
- This ensures tests verify the _contract_, not the _implementation_ — catching cases where code passes its own logic but violates the spec

When dispatching in parallel, the orchestrator must provide the test-writer with the spec artifact only. If the test-writer needs to understand interfaces or types, those should come from the spec's evidence table or contract definitions, not from implementation files.

### Assumption Tracking (Practice 1.10)

When multiple agents implement in parallel, each agent's `TODO(assumption)` comments create a distributed assumption graph. After parallel implementation and before the review gate, the orchestrator MUST scan modified files for `TODO(assumption)` markers, group by topic, and flag conflicts (two agents assumed different values for the same integration point). A single agent's assumption is a local decision; multiple agents' assumptions about the same topic are a distributed consensus problem.

### Parallel Execution

For large tasks, the main agent orchestrates parallel execution:

- Multiple `spec-author` subagents for workstreams
- `implementer`, `test-writer`, and `e2e-test-writer` run in parallel (no ordering constraint — test-writer and e2e-test-writer work from spec only; e2e-test-writer dispatched only for cross-boundary specs)
- `code-reviewer` and `security-reviewer` run in parallel (same dispatch prerequisites: challenger pre-review + unifier)
- Both reviewers converge independently; `documenter` waits for both convergences
- Main agent handles integration and synthesis

### Convergence Gates

Before merge, all gates must pass. Each gate marked with **(loop)** runs under the Convergence Loop Protocol — requiring 2 consecutive clean passes, not single-pass:

- Spec complete
- Investigation convergence **(loop)** — auto-decision engine integration
- Challenger convergence **(loop)** — pre-impl/pre-orch stages, auto-decision engine
- All ACs implemented
- All tests passing (100% AC coverage)
- Unifier validation passed **(loop)**
- Code review passed (no High/Critical issues) **(loop)**
- Security review passed **(loop)**
- Completion verification passed **(loop)**
- E2E tests passed (if cross-boundary)
- Browser tests passed (if UI)
- Documentation generated

### Example Workflow: oneoff-spec (Logout Button)

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
8. `/challenge` → MANDATORY operational feasibility check (stage: pre-test)
9. Integration Verify → Dispatch Unifier subagent → Validate convergence
10. `/challenge` → MANDATORY operational feasibility check (stage: pre-review)
11. [Parallel] Dispatch Code-reviewer + Security-reviewer subagents
12. Dispatch Browser-tester subagent → UI testing
13. Dispatch Documenter subagent → Generate API docs
14. Synthesize results → Commit with spec evidence
```

### Example Workflow: Multi-Workstream with Investigation

```markdown
User: "Build a deployment pipeline with build, deploy, and monitoring"

1. `/route` → orchestrator (3 workstreams)
2. Use `/prd` to gather requirements for each workstream
3. [Parallel] Dispatch 3 Spec-author subagents → Create WorkstreamSpecs
4. Create MasterSpec linking workstreams
5. `/investigate ms-deployment-pipeline` → MANDATORY checkpoint
   - Finds: GIT_SSH_KEY_PATH vs GIT_SSH_KEY_BASE64 conflict
   - Finds: Missing LOG\_\* vars in monitoring workstream
   - Finds: Container image format inconsistency
6. Surface decisions to user → User chooses canonical patterns
7. Update affected specs with decisions
8. Re-run `/investigate` → Clean (no issues)
9. User approves MasterSpec
10. `/challenge` → MANDATORY operational feasibility check (stage: pre-orchestration)
11. [Parallel per workstream] Dispatch Implementer + Test-writer
12. `/challenge` → MANDATORY operational feasibility check (stage: pre-test)
13. Integration Verify → Unify → Validate convergence
14. `/challenge` → MANDATORY operational feasibility check (stage: pre-review)
15. Continue with Code Review → Security → Docs → Commit
```

### Trace System

The trace system generates pre-computed architectural summaries of the codebase. Agents consume these summaries instead of performing expensive Explore dispatches.

#### Architecture

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
        ├── <module-id>.json  # Per-module detailed trace (exports, imports, files)
        └── <module-id>.md    # Per-module human-readable summary
```

#### Trace Data Fields

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

#### Consumption Patterns

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

#### Trace Scripts (synced via registry)

| Script                       | Purpose                                     |
| ---------------------------- | ------------------------------------------- |
| `trace-generate.mjs`         | Generate all trace files from config        |
| `lib/trace-utils.mjs`        | Shared utilities (config, staleness, globs) |
| `lib/high-level-trace.mjs`   | High-level trace JSON/MD generation         |
| `trace-read-enforcement.mjs` | PreToolUse hook: enforce trace reads        |

#### Key Constraints

- Regex-based parsing only (no AST) for portability
- Trace files contain structural metadata only -- never source code, env values, or credentials
- Trace output files are NOT synced via registry (each project generates its own)
- Only trace scripts sync to consumer projects
- `isTraceStale()` checks file modification time against configurable staleness threshold

### Structured Documentation System

The structured documentation system provides machine-parseable YAML documentation that sits between low-level traces and high-level memory-bank content.

#### Three-Layer Documentation Model

```
traces (file-level)  →  structured docs (module-level)  →  memory-bank (process-level)
```

#### Key Locations

| Artifact   | Location                              |
| ---------- | ------------------------------------- |
| Schema     | `.claude/docs/structured/schema.yaml` |
| Docs       | `.claude/docs/structured/`            |
| Templates  | `.claude/templates/structured-docs/`  |
| Validator  | `.claude/scripts/docs-validate.mjs`   |
| Generator  | `.claude/scripts/docs-generate.mjs`   |
| Scaffolder | `.claude/scripts/docs-scaffold.mjs`   |
| Shared lib | `.claude/scripts/lib/yaml-utils.mjs`  |

#### Document Types

- `architecture.yaml` - Module dependency map
- `flows/index.yaml` + `flows/*.yaml` - Flow definitions with steps
- `glossary.yaml` - Term definitions
- `decisions.yaml` - Architecture decision records (extension)
- `runbooks.yaml` - Operational procedures (extension)

#### Sync & Hooks

- Registry category: `structured-docs-templates` (with `_sync_policy: "never-overwrite"` -- templates only sync if target file does not exist)
- PostToolUse hook triggers on `.claude/docs/**/*.yaml` for automatic validation

### S-DLC Team Relationship

When the S-DLC system is active, teams operate as a coordination layer above the skills/agents defined here:

- Teams wrap existing agents (composition, not replacement)
- Deliberation happens at team level; execution via agents
- Skills emit lifecycle events for dashboard observability (planned, not yet implemented)
- Local development works identically with or without S-DLC

See `.claude/journal/decisions/decision-001-sdlc-local-system-unification.md` for the full architectural decision.

---
last_reviewed: 2026-02-14
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
├── agents/              # Subagent specifications (18 specialized agents)
├── skills/              # Skill definitions (workflow stages)
├── specs/
│   ├── groups/          # Active spec groups
│   ├── archive/         # Completed specs
│   └── schema/          # JSON validation schemas
├── context/
│   └── session.json     # Session state for cross-session recovery
├── memory-bank/         # Persistent project knowledge
│   ├── project.brief.md
│   ├── tech.context.md
│   ├── delegation.guidelines.md
│   └── best-practices/
├── scripts/             # Validation scripts for hooks
├── templates/           # Spec and artifact templates
├── docs/                # System documentation
├── journal/             # Fix reports and discoveries
└── settings.json        # Hooks configuration
```

### Subagent Model

18 specialized subagents, each with focused responsibilities:

| Subagent                 | Model | Purpose                                                                         |
| ------------------------ | ----- | ------------------------------------------------------------------------------- |
| `atomicity-enforcer`     | opus  | Validate atomic specs meet atomicity criteria                                   |
| `atomizer`               | opus  | Decompose specs into atomic specs with single responsibility                    |
| `explore`                | opus  | Investigate questions via web or codebase research; returns structured findings |
| `interface-investigator` | opus  | Surface cross-spec inconsistencies (env vars, APIs, data shapes, assumptions)   |
| `product-manager`        | opus  | Interview users, gather/refine requirements                                     |
| `spec-author`            | opus  | Author workstream specs (no code)                                               |
| `implementer`            | opus  | Implement from approved specs                                                   |
| `test-writer`            | opus  | Write tests for acceptance criteria                                             |
| `unifier`                | opus  | Validate convergence                                                            |
| `code-reviewer`          | opus  | Code quality review (read-only, runs before security)                           |
| `security-reviewer`      | opus  | Security review - PRDs (shift-left) and implementation (read-only)              |
| `documenter`             | opus  | Generate docs from implementation                                               |
| `refactorer`             | opus  | Code quality improvements with behavior preservation                            |
| `facilitator`            | opus  | Orchestrate multi-workstream projects with git worktrees                        |
| `browser-tester`         | opus  | Browser-based UI testing                                                        |
| `prd-author`             | opus  | Author complete PRDs from requirements using template                           |
| `prd-reader`             | opus  | Extract requirements from existing PRDs                                         |
| `prd-writer`             | opus  | Push incremental discoveries back to PRDs                                       |

### Spec is Contract Principle

**The spec is the authoritative source of truth.**

- Implementation must conform to spec
- Tests must verify spec requirements
- Any deviation requires spec amendment first (never deviate silently)
- Unifier validates alignment before approval

### Validation Hooks

PostToolUse hooks run automatically after Edit/Write operations to catch issues early. Key hooks include:

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

Hooks warn but don't block (graceful degradation). For full documentation, see `.claude/docs/HOOKS.md`.

### Spec Lifecycle & Workflow Types

#### Spec System Workflow

```
TaskSpec → Atomize → Enforce → Approve → Implement → Test → Unify → Review
```

#### Spec Types

- **TaskSpec**: Single-feature specifications for medium tasks
- **WorkstreamSpec**: Component of a larger orchestrated effort
- **MasterSpec**: Coordinates multiple workstreams with contracts

#### Spec Lifecycle

1. **Draft**: Initial authoring from requirements
2. **Atomized**: Decomposed into atomic specs (single responsibility each)
3. **Enforced**: Validated against atomicity criteria
4. **Approved**: User-approved, ready for implementation
5. **Implementing**: Work in progress
6. **Implemented**: All atomic specs complete
7. **Verified**: Unifier confirmed convergence

#### oneoff-vibe (Small tasks)

```
Request → Route → Delegate to subagent → Synthesize → Commit
```

- Simple changes with clear scope
- No formal spec required
- Single subagent dispatch

#### oneoff-spec (Medium tasks)

```
Request → Route → PM Interview → [Optional: PRD Draft] → Spec → Atomize → Enforce →
  [If dependencies: Investigate] → Approve →
  [Parallel: Implement + Test] → Unify → Code Review → Security →
  [If UI: Browser Test] → [If public API: Docs] → [If PRD: PRD Push] → Commit
```

- Requires formal specification
- Parallel implementation and testing
- Full review chain

#### orchestrator (Large tasks)

```
Request → Route → PM Interview → [Optional: PRD Draft] → ProblemBrief →
  [Parallel: WorkstreamSpecs] → MasterSpec →
  Investigate (MANDATORY for multi-workstream) → Resolve Decisions →
  Approve → /orchestrate (allocates worktrees, dispatches facilitator) →
  [Parallel per workstream: Implement + Test] →
  Unify → Code Review → Security → Browser Test → Docs → [If PRD: PRD Push] → Commit
```

- 3+ workstreams
- Git worktree isolation
- Cross-workstream contract validation

**Investigation Checkpoint**: For orchestrator workflows, `/investigate` is MANDATORY before implementation. It surfaces cross-workstream inconsistencies (env vars, API contracts, deployment assumptions) that would otherwise become runtime bugs.

### Branch Naming Convention

Spec-based work uses the branch naming pattern `sg-<feature-name>/<action>`:

- **Pattern**: `sg-<feature-name>/<action>`
- **Examples**:
  - `sg-selective-context-copy/implement` - Implementation of selective copy feature
  - `sg-auth-system/fix-logout` - Fix for auth system logout
  - `sg-e2e-add-file/implement` - E2E test implementation

**Purpose**: This convention enables spec derivation from branch names. Use the `extractSpecGroupId(branchName)` utility from `.claude/scripts/selective-claude-copy.mjs` to extract the spec group ID:

```javascript
import { extractSpecGroupId } from './.claude/scripts/selective-claude-copy.mjs';

extractSpecGroupId('sg-auth-system/fix-logout'); // Returns: 'sg-auth-system'
extractSpecGroupId('feature/random-branch'); // Returns: null
```

### Progress Heartbeat Discipline (Practice 4.2)

Long-running spec implementations must emit periodic progress signals. The `progress-heartbeat-check` hook enforces this automatically:

- Monitors `last_progress_update` timestamp in the spec group's `manifest.json`
- **Warning** at 15 minutes of silence — reminds the agent to log progress
- **Block** after 3 warnings — further edits are blocked until progress is logged
- Logging progress resets the warning counter to 0

Agents working on spec-based tasks should update progress in the manifest before the heartbeat triggers. This prevents silent stalls where an agent appears active but has stopped making meaningful progress.

### Content-Hash Versioning (Practice 4.3)

Every artifact in `.claude/` is versioned by content hash in addition to semver. The `registry-hash-verify` hook validates hashes on every edit to `.claude/` files.

- **Verify**: `node .claude/scripts/compute-hashes.mjs --verify` — checks all artifacts match their registered hashes
- **Update**: `node .claude/scripts/compute-hashes.mjs --update` — recomputes hashes for modified artifacts

When modifying scripts or other registered artifacts, always update the registry hash afterward. The hash is the source of truth for sync — consumers receive artifacts based on hash comparison, not file timestamps.

### Independent Verification (Practice 2.4)

When `implementer` and `test-writer` run in parallel, the test-writer **must not see the implementation**. This is the spec-derived independent verification constraint:

- The test-writer receives only the **spec** (acceptance criteria, task list, evidence table) — never implementation file paths or code
- Tests are derived from the spec's acceptance criteria, not from reading implementation details
- This ensures tests verify the _contract_, not the _implementation_ — catching cases where code passes its own logic but violates the spec

When dispatching in parallel, the orchestrator must provide the test-writer with the spec artifact only. If the test-writer needs to understand interfaces or types, those should come from the spec's evidence table or contract definitions, not from implementation files.

### Assumption Tracking (Practice 1.10)

When multiple agents implement in parallel, each agent's `TODO(assumption)` comments create a distributed assumption graph. After parallel implementation and before the review gate, the orchestrator MUST scan modified files for `TODO(assumption)` markers, group by topic, and flag conflicts (two agents assumed different values for the same integration point). A single agent's assumption is a local decision; multiple agents' assumptions about the same topic are a distributed consensus problem.

### Parallel Execution

For large tasks, the main agent orchestrates parallel execution:

- Multiple `spec-author` subagents for workstreams
- `implementer` and `test-writer` run in parallel
- `code-reviewer` and `security-reviewer` run in parallel
- Main agent handles integration and synthesis

### Convergence Gates

Before merge, all gates must pass. Each gate marked with **(loop)** runs under the Convergence Loop Protocol — requiring 2 consecutive clean passes, not single-pass:

- Spec complete and approved
- All ACs implemented
- All tests passing (100% AC coverage)
- Unifier validation passed **(loop)**
- Code review passed (no High/Critical issues) **(loop)**
- Security review passed **(loop)**
- Browser tests passed (if UI)
- Documentation generated (if public API)

### Session State Management

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

### Key File Locations

| Artifact          | Location                                             |
| ----------------- | ---------------------------------------------------- |
| Active specs      | `.claude/specs/groups/<spec-group-id>/`              |
| Atomic specs      | `.claude/specs/groups/<spec-group-id>/atomic/`       |
| Manifest          | `.claude/specs/groups/<spec-group-id>/manifest.json` |
| Session state     | `.claude/context/session.json`                       |
| Agent definitions | `.claude/agents/<agent-name>.md`                     |
| Skill definitions | `.claude/skills/<skill-name>/SKILL.md`               |

### Example Workflows

#### oneoff-spec (Logout Button)

```markdown
User: "Add a logout button to the dashboard"

1. `/route` → oneoff-spec (medium complexity)
2. Dispatch PM subagent → Interview user about placement, behavior, error handling
3. Dispatch Spec-author subagent → Create TaskSpec with 4 ACs, 6 tasks
4. Dispatch Atomizer subagent → Decompose into atomic specs
5. Dispatch Atomicity-enforcer subagent → Validate atomicity
6. [If spec references auth system] Dispatch Interface-investigator →
   Surface any conflicts with existing auth contracts
7. User approves spec (after resolving any investigation findings)
8. [Parallel] Dispatch Implementer + Test-writer subagents
9. Dispatch Unifier subagent → Validate convergence
10. [Parallel] Dispatch Code-reviewer + Security-reviewer subagents
11. Dispatch Browser-tester subagent → UI testing
12. Dispatch Documenter subagent → Generate API docs
13. Synthesize results → Commit with spec evidence
```

#### Multi-Workstream with Investigation

```markdown
User: "Build a deployment pipeline with build, deploy, and monitoring"

1. `/route` → orchestrator (3 workstreams)
2. Dispatch PM subagent → Gather requirements for each workstream
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
10. [Parallel per workstream] Dispatch Implementer + Test-writer
11. Continue with Unify → Code Review → Security → Docs → Commit
```

### S-DLC Team Relationship

When the S-DLC system is active, teams operate as a coordination layer above the skills/agents defined here:

- Teams wrap existing agents (composition, not replacement)
- Deliberation happens at team level; execution via agents
- Skills emit lifecycle events for dashboard observability
- Local development works identically with or without S-DLC

See `.claude/journal/decisions/decision-001-sdlc-local-system-unification.md` for the full architectural decision.

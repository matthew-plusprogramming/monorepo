# Routing Heuristic - Spec First

> Canonical reference for `/route` complexity heuristics.

## Purpose

`/route` decides whether a user request should use `oneoff-vibe`,
`oneoff-spec`, `refactor`, or `journal-only`. Large and cross-boundary work now
stays in `oneoff-spec`; complexity changes the spec depth and delegation plan,
not the workflow.

## Workflow Table

| Workflow       | When |
| -------------- | ---- |
| `oneoff-vibe`  | Truly trivial work, clear bounded low-risk edits, or explicit operator override |
| `oneoff-spec`  | Default for feature work, behavior changes, policy changes, integration risk, verification risk, and large work |
| `refactor`     | Explicit behavior-preserving cleanup with no feature or behavior change |
| `journal-only` | Documentation of completed work, decisions, investigations, or operational notes |

## Vibe Threshold

Use `oneoff-vibe` when a formal spec would add more ceremony than clarity:

- Typo fixes, missing imports, obvious syntax fixes, version bumps, or comment clarification.
- Bounded low-risk edits with a clear outcome, usually 1-3 files, one concern, and direct validation by diff review, static check, affected test, or docs/prompt review.
- Explicit operator override such as "just do it", "vibe", "quick fix", or "skip spec".

Do not default to `oneoff-vibe` for auth, permissions, credentials, hooks,
session state, registries, hashes, sync/audit paths, filesystem safety,
deployment, CI, public API contracts, schemas, shared-library behavior, or
cross-runtime integration.

## Oneoff-Spec Default

Use `oneoff-spec` for almost everything that has product, behavioral,
operational, or verification meaning:

- New functionality or enhancement.
- Bug fixes with observable behavior.
- UI, API, schema, hook, policy, prompt, or documentation behavior changes.
- Cross-boundary changes that need contracts or dependency ordering.
- Large efforts that benefit from parallel subagents.

Large work should keep one `.claude/specs/groups/<sg-id>/spec.md`. The spec can
include richer sections for contracts, dependencies, test surfaces, merge/order
notes, and optional slices.

## Large Work

Do not create a separate large-work workflow for new work. When a request is
large, `/route` should emit:

```yaml
workflow: oneoff-spec
estimated_scope: large
delegation_plan:
  mode: parallel
  spec_slices:
    - id: api
      scope: Contract and handler changes
    - id: ui
      scope: User-facing integration
```

Use spec slices only when they clarify parallel work or dependency order. Avoid
turning slices into mini-spec files or extra gates.

Large-scope signals:

- 5+ files impacted across multiple layers.
- Estimated effort above 4 hours.
- Cross-cutting contracts, interfaces, shared state, or storage changes.
- Multiple independent test surfaces.
- 3+ services, cross-runtime boundaries, or separately releasable components.
- Clear parallel execution opportunities.

## Recording Decisions

Route decisions are persisted with:

```bash
node .claude/scripts/session-checkpoint.mjs record-route-decision oneoff-spec "<rationale>"
```

The route rationale should explain the risk and delegation shape. It should not
emit the old multi-domain justification field; complex-domain evidence belongs
in the normal rationale and optional spec-slice notes.

## Worked Examples

### Trivial edit

Request: "Fix the typo in README."

Decision: `oneoff-vibe`. Validation is direct diff review.

### Normal feature

Request: "Add a logout button to the user dashboard."

Decision: `oneoff-spec`. The spec defines UI behavior, token/session clearing,
redirect behavior, and tests.

### Large cross-boundary feature

Request: "Implement real-time notifications across WebSocket server, frontend
client, notification persistence, and auth middleware integration."

Decision: `oneoff-spec`, `estimated_scope: large`. Add spec sections for the
WebSocket contract, persistence shape, auth assumptions, frontend behavior,
test surfaces, and optional slices such as `server`, `client`, `persistence`,
and `auth`.

### Behavior-preserving cleanup

Request: "Refactor the auth module without changing behavior."

Decision: `refactor`, unless the request adds MFA, changes session semantics, or
otherwise introduces behavior.

## Current Surfaces

- `.claude/skills/route/SKILL.md` defines the interactive routing contract.
- `.claude/scripts/lib/routing-heuristics.mjs` provides deterministic classifier support for tests.
- `.claude/scripts/session-checkpoint.mjs record-route-decision` persists route decisions.
- `CLAUDE.md` and `.claude/templates/claude-md-base.md` summarize the workflow policy for propagated contexts.

# Agentic System - Operator's Guide

## Choosing the Right Workflow

```
                Does this involve multiple workstreams,
                repos, or cross-cutting contracts?
                                |
                +---------------+---------------+
                |                               |
               YES                             NO
                |                               |
                v                               v
        +---------------+           Is this clearly bounded
        | ORCHESTRATOR  |           and small?
        | /orchestrate  |                   |
        +---------------+           +-------+-------+
                                    |               |
                                   YES             NO
                                    |               |
                                    v               v
                            +-------------+  +-------------+
                            | ONE-OFF     |  | ONE-OFF     |
                            | VIBE        |  | SPEC        |
                            | (no spec)   |  | /spec first |
                            +-------------+  +-------------+
```

| Scenario                               | Workflow     | Skills                                   |
| -------------------------------------- | ------------ | ---------------------------------------- |
| Feature across frontend + backend + DB | Orchestrator | `/orchestrate`, `/spec`, `/implement`    |
| New API endpoint with tests            | One-off Spec | `/spec`, `/implement`, `/test`, `/unify` |
| Typo fix or small refactor             | One-off Vibe | Direct execution                         |

**When in doubt**: Use `/route` to analyze task complexity.

## Nuances & Gotchas

1. **Mode is chosen by USER, not inferred** - Even small tasks can be orchestrator. Ask.
2. **Spec approval is a gate** - Cannot implement without recorded approval in Decision Log.
3. **Specs are living documents** - Update spec if reality changes. Capture deviations.
4. **One-pass context discipline** - Load once, take notes, cite line numbers. No repeated pulls.
5. **Workstreams own contracts, not teams** - Decompose by interface boundaries.
6. **Memory Bank is PR-reviewed** - Changes to `.claude/memory-bank/` need PR review.
7. **Vibe mode is for small changes only** - If scope grows, switch to one-off-spec immediately.
8. **Tests must trace back to ACs** - Every AC needs a test. Log evidence in Execution section.
9. **Decision & Work Log is human-facing** - Approvals and decisions live here. Keep readable.
10. **Phase check is a gate** - Run `npm run phase:check` before shipping.

## Skills Reference

| Skill          | Purpose                                        |
| -------------- | ---------------------------------------------- |
| `/route`       | Analyze task complexity, recommend workflow    |
| `/pm`          | Interview user to gather requirements          |
| `/spec`        | Author TaskSpec, WorkstreamSpec, or MasterSpec |
| `/implement`   | Execute implementation from approved spec      |
| `/test`        | Write tests for acceptance criteria            |
| `/unify`       | Validate spec-impl-test alignment              |
| `/security`    | Security review before merge                   |
| `/orchestrate` | Coordinate multi-workstream projects           |

## Convergence Gates

Before merge: Spec approved | All ACs implemented | Tests passing | `/unify` passed | `/security` passed

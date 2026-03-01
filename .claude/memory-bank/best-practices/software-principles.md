# Software Design Principles

Reinforcement checklist — these compound across the codebase when applied consistently.

## Separation of Concerns

- Each module: single, well-defined responsibility
- Separate business logic from infrastructure (DB, HTTP, filesystem)
- Keep handlers thin; delegate to services

## DRY

- Extract shared logic into utilities or shared packages
- Balance DRY with clarity — sometimes duplication is clearer than abstraction

## Composition Over Inheritance

- Prefer function composition and DI over class hierarchies
- Build complex functionality from simple, composable units

## Explicit Over Implicit

- Make dependencies explicit; avoid hidden globals
- Surface configuration and environment requirements clearly

## Incremental Change

- Small, focused changes; avoid large sweeping refactors
- Validate assumptions early with tests or probes
- Minimize blast radius; isolate risky changes

## Fail Fast

- Validate inputs early; reject invalid data at the boundary
- Surface errors clearly; avoid silent failures
- Use typed error channels (Effect) for predictable error handling

## Configuration as Code

- Store configuration in version control
- Use typed schemas (Zod) for config validation
- Separate secrets from configuration

## Spec-First Development

- Specs before implementation for non-trivial work
- Validate implementation against spec requirements
- Never deviate silently from spec

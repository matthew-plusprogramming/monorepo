---
last_reviewed: 2026-01-07
domain: architecture
tags: [design, principles, patterns]
---

# Software Design Principles

## Separation of Concerns (SoC)

- Each module should have a single, well-defined responsibility.
- Separate business logic from infrastructure (DB, HTTP, filesystem).
- Use adapters to isolate external dependencies; make them injectable.
- Keep handlers thin; delegate to services for business logic.

## Don't Repeat Yourself (DRY)

- Extract shared logic into utility functions or shared packages.
- Use builders and factories for test data construction.
- Centralize configuration (schemas, constants) in shared packages.
- Balance DRY with clarity; sometimes duplication is clearer than abstraction.

## Composition Over Inheritance

- Prefer function composition and dependency injection over class hierarchies.
- Use mixins or higher-order functions for shared behavior.
- Build complex functionality from simple, composable units.
- Avoid deep inheritance trees; favor flat, composable structures.

## Dependency Injection

- Pass collaborators via constructor parameters or function arguments, not module-level singletons.
- An agent asked to "write tests for ServiceX" must be able to see exactly which dependencies to mock. Without DI, the agent must trace imports through the entire codebase.
- Use factory functions or a lightweight container for complex dependency graphs.
- Register services as factories; resolve dependencies at runtime.

## Explicit Over Implicit

- Make dependencies explicit; avoid hidden globals or singletons.
- Document assumptions in code comments or specs.
- Prefer explicit error handling over implicit exception propagation.
- Surface configuration and environment requirements clearly.

## Boundaries and Contracts

- Define clear interfaces at module boundaries.
- Use typed contracts for inter-service communication.
- Validate inputs at system boundaries with runtime schemas (Zod, io-ts); trust internal data after validation.
- Derive TypeScript types from schemas (`z.infer<typeof Schema>`), never hand-write parallel type definitions.
- When contract schemas exist (OpenAPI, GraphQL, Prisma), generate types from them. The schema is the single source of truth.
- Document breaking changes in specs before implementation.

## Incremental Change

- Make small, focused changes; avoid large, sweeping refactors.
- Ship incrementally with feature flags when possible.
- Validate assumptions early with tests or probes.
- Minimize blast radius; isolate risky changes.

## Fail Fast

- Validate inputs early; reject invalid data at the boundary.
- Surface errors clearly; avoid silent failures.
- Use typed error channels (Effect) for predictable error handling.
- Use a **structured error taxonomy**: typed error classes with machine-readable `error_code`, `blame` attribution (`self` | `upstream` | `client`), and `retry_safe` boolean. Never throw raw strings.
- Log errors with context for debugging. Include error codes, correlation IDs, and blame attribution.

## Configuration as Code

- Store configuration in version control when possible.
- Use typed schemas for configuration validation (Zod).
- Separate secrets from configuration; load secrets from secure sources.
- Document configuration options and defaults.

## Observability

- Add structured logging at key decision points.
- Include correlation IDs for request tracing.
- Monitor health endpoints and key metrics.
- Plan for debugging in production; add sufficient context to logs.

## Spec-First Development

- Create specifications before implementation for non-trivial work.
- Use EARS format for testable acceptance criteria.
- Validate implementation against spec requirements.
- Document deviations from spec; never deviate silently.

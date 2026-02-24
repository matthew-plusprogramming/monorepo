---
domain: development
tags: [contracts, types, validation, evidence, wire-protocol, boundaries]
last_reviewed: 2026-02-14
---

# Contract-First Development Best Practices

## Core Principle

The schema defines truth. Types are generated from it. Agents must use what the generated type exposes — they don't get to "choose" camelCase vs snake_case.

## Evidence-Before-Edit (Practice 1.7)

The single most common class of AI-generated bugs is "I assumed it was called X": snake*case vs camelCase mismatches, referencing fields that don't exist, using a route path that was renamed. These aren't logic errors — they're failures of *discovery\*.

### The Rule

An agent may not introduce or reference any identifier unless it first shows evidence the symbol exists. Evidence means:

- `grep`/`rg` results showing the symbol in the repo
- A type definition containing the exact property name
- A generated client/server type proving casing and shape

### The Evidence Table

Before any edit phase, produce a table:

| Symbol / Field | Source File            | Line(s) | Notes            |
| -------------- | ---------------------- | ------- | ---------------- |
| `AuthService`  | `src/services/auth.ts` | 15      | PascalCase class |
| `logout()`     | `src/services/auth.ts` | 89      | camelCase method |

If evidence is missing: search more, or propose adding the symbol to the contract. Never invent locally.

### Recursive Conductor Integration

For implementers using the recursive conductor pattern: the DISCOVER phase is a mandatory explore-subagent dispatch before any implementer dispatch. The evidence table should be included in the atomic spec.

## Contract Integrity

When a project has contract-generated types (OpenAPI, GraphQL, Prisma, Zod schemas):

- **Schema defines truth.** Types are generated from it, never hand-written at boundaries.
- **Generated folders are read-only.** Agents must not edit files in `generated/`, `__generated__/`, or equivalent directories. The only way to change a generated type is to change the source schema and regenerate.
- **Contract changes trigger**: regenerate → typecheck → test. No skipping steps.
- The agent doesn't get to "choose" camelCase vs snake_case — it must use whatever the generated type exposes.

### The Pipeline

```
Schema (OpenAPI / Zod / GraphQL / Prisma)
    ↓ generate
Types (generated/, __generated__/)
    ↓ import
Application code
```

### Why It Matters for AI Agents

When types are generated from schemas, agents can't introduce a field that doesn't exist — the type checker catches it immediately. Without this, each agent invocation is a new opportunity for naming drift. With it, the correct names are always one grep away, in a file the agent can't edit.

## Interface Contracts

- Define interfaces before implementations. Depend on abstractions, not concretions.
- Shared types live in dedicated modules (`types/`, `contracts/`), never co-located with a single implementation.
- Use the template method pattern for shared lifecycle logic with extension points.
- Breaking interface changes require spec amendment.

## Wire Protocol Contracts (Practice 1.8)

When a feature spans multiple services, runtimes, or spec boundaries (e.g., backend SSE → frontend consumer, API server → client SDK, publisher → subscriber), the spec MUST include a **Wire Protocol Contract** section that explicitly defines the integration surface:

- **Endpoint**: Path, host service, config function
- **Event Format**: Transport mechanism, event name pattern, data format
- **Consumer Contract**: Listener pattern, validation, reconnection
- **Publisher Contract**: Broadcast method, event name construction, payload shape

**Why this exists**: Evidence-Before-Edit (Practice 1.7) catches symbol-level integration issues ("does this function exist?"). Wire Protocol Contracts catch protocol-level integration issues ("are both sides speaking the same language?"). Human developers working serially discover wire protocol details by reading the other side's code. Parallel agents execute simultaneously with no visibility into each other's decisions — any detail not specified in the contract becomes a coinflip.

**Applicability**: Required for any spec that crosses a service, runtime, or process boundary. Not needed for intra-module specs.

## Boundary Ownership Assignment (Practice 1.9)

Every cross-boundary integration point MUST have a single owning spec responsible for both registering the endpoint AND defining the contract.

| Pattern       | Owner                          | Owns What                                          |
| ------------- | ------------------------------ | -------------------------------------------------- |
| SSE/WebSocket | The **relay/broadcaster** spec | Route registration + event naming + broadcast API  |
| REST API      | The **server** spec            | Route + request/response schema + status codes     |
| Redis Streams | The **publisher** spec         | Stream name + message schema + consumer group name |
| Message Queue | The **publisher** spec         | Topic/queue name + message format + DLQ config     |
| Shared Types  | The **defining** spec          | Type module + exports + re-export barrel           |

The consumer spec references the publisher spec's contract — it does not independently define connection details. When specs divide as "publisher logic" and "consumer logic," the registration falls between them unless ownership is pre-assigned.

## Contract Stratification (Practice 2.5)

Contracts exist at four layers, each requiring different validation:

| Layer                      | What It Defines                                 | Validated By                          |
| -------------------------- | ----------------------------------------------- | ------------------------------------- |
| **Type Contract**          | Data shapes, field names, types                 | TypeScript compiler, Zod schemas      |
| **Symbol Contract**        | Function/class existence, signatures            | Evidence-Before-Edit (Practice 1.7)   |
| **Wire Protocol Contract** | Endpoint paths, event names, service addressing | Wire Protocol Contract (Practice 1.8) |
| **Behavioral Contract**    | Ordering, timing, retry semantics               | Integration tests, E2E tests          |

Each layer is independently necessary. Failing to validate at one layer creates a gap even when all other layers pass. Agents excel at satisfying explicit contracts (types compile, symbols exist) but cannot validate implicit contracts (naming conventions, service addressing) unless those are made checkable.

## Named Constants: Architectural Concerns

- Share parsing logic between frontend and backend to prevent drift.
- Use bounded data structures (ring buffers, capped arrays) to prevent unbounded memory growth in long-running processes.

## Validation at Boundaries

### Pattern

```typescript
// Schema defines the shape
const ConfigSchema = z.object({
  port: z.number().min(1).max(65535),
  host: z.string(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
});

// Type is derived from schema — never hand-written
type Config = z.infer<typeof ConfigSchema>;

// Validate once at the boundary
const config = ConfigSchema.parse(rawInput);

// Internal code trusts the type
function startServer(config: Config) {
  // config.port is guaranteed to be a valid number
  // No need to re-validate
}
```

### Rules

- Validate all external input at the point of entry (config files, API payloads, WebSocket messages)
- Use `z.infer<typeof Schema>` for type derivation — never maintain a parallel type definition
- Internal code trusts the validated types — no re-validation deeper in the stack
- Invalid state should be impossible to represent after the boundary layer

## When to Apply

- **Always**: Evidence-before-edit (zero infrastructure cost, immediately effective)
- **When contracts exist**: Contract integrity guardrails
- **When crossing boundaries**: Wire protocol contracts + boundary ownership assignment
- **For spec authoring**: Contract stratification — identify which layers each spec touches
- **When feasible**: Full schema → generate → read-only pipeline

## Integration with Existing Practices

- **Evidence-Before-Edit + Spec-as-Contract**: The evidence table makes spec conformance mechanically verifiable
- **Evidence-Before-Edit + Recursive Conductor**: The DISCOVER phase is a mandatory explore-subagent dispatch before any implementer dispatch
- **Contract-Generated Types + Code Review**: Reviewers check for hand-written DTOs that duplicate generated types
- **Validation at Boundaries + Named Constants**: Schema-derived types enforce naming; constants enforce values
- **Wire Protocol + Boundary Ownership**: Together they ensure cross-service specs never have ambiguous integration surfaces
- **Contract Stratification + Investigation**: The `/investigate` skill validates all four layers across workstreams

---
domain: development
tags: [contracts, types, validation, evidence]
---

# Contract-First Development Best Practices

## Core Principle

The schema defines truth. Types are generated from it. Agents must use what the generated type exposes — they don't get to "choose" camelCase vs snake_case.

## Evidence-Before-Edit

The single most common class of AI-generated bugs is "I assumed it was called X": snake*case vs camelCase mismatches, referencing fields that don't exist, using a route path that was renamed. These aren't logic errors — they're failures of \_discovery*.

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

### When to Apply

- **Always**: For any edit that references existing symbols (zero infrastructure cost)
- **Especially**: Cross-module changes, API boundary changes, generated type usage

## Contract-Generated Types

### The Pipeline

```
Schema (OpenAPI / Zod / GraphQL / Prisma)
    ↓ generate
Types (generated/, __generated__/)
    ↓ import
Application code
```

### Rules

1. **Schema defines truth**: The canonical field names, types, and shapes live in the schema
2. **Types are generated**: Run the generator, import the output. Never hand-write a DTO that duplicates generated types.
3. **Generated folders are read-only**: Agents must not edit files in `generated/` directories. Change the schema and regenerate.
4. **Contract changes trigger**: regenerate → typecheck → test. No skipping steps.

### Why It Matters for AI Agents

When types are generated from schemas, agents can't introduce a field that doesn't exist — the type checker catches it immediately. Without this, each agent invocation is a new opportunity for naming drift. With it, the correct names are always one grep away, in a file the agent can't edit.

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

## Integration with Existing Practices

- **Evidence-Before-Edit + Spec-as-Contract**: The evidence table makes spec conformance mechanically verifiable
- **Evidence-Before-Edit + Recursive Conductor**: The DISCOVER phase is a mandatory explore-subagent dispatch before any implementer dispatch
- **Contract-Generated Types + Code Review**: Reviewers check for hand-written DTOs that duplicate generated types
- **Validation at Boundaries + Named Constants**: Schema-derived types enforce naming; constants enforce values

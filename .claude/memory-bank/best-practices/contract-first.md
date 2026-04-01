# Contract-First Development Best Practices

## Core Principle

The schema defines truth. Types are generated from it. Agents must use what the generated type exposes — they don't get to "choose" camelCase vs snake_case.

## Evidence-Before-Edit (Practice 1.7)

The single most common class of AI-generated bugs is "I assumed it was called X": snake_case vs camelCase mismatches, referencing fields that don't exist, using a route path that was renamed. These aren't logic errors — they're failures of discovery.

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

## Contract Content Templates

Four YAML contract content templates define the machine-parseable contract format for each contract layer. Each uses a "base plus" format: structured core fields (machine-parseable) plus optional freeform fields under a `context:` namespace (LLM-readable).

### Template Files

| Template   | File                                                   | Core Fields                                                                        | Security Fields                                                                |
| ---------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| REST API   | `.claude/contracts/templates/rest-api.template.yaml`   | method, path, content_type, request_shape, response_shape, error_codes             | auth_method, auth_scope, required_headers, rate_limit_tier, error_sanitization |
| Event      | `.claude/contracts/templates/event.template.yaml`      | event_name, channel, payload_shape                                                 | auth_method, channel_access_control                                            |
| Data Model | `.claude/contracts/templates/data-model.template.yaml` | entity_name, fields, relationships, indexes                                        | data_classification, pii_fields                                                |
| Behavioral | `.claude/contracts/templates/behavioral.template.yaml` | behavior_name, retry_policy, timeout, ordering_guarantee, concurrency, idempotency | rate_limit_tier                                                                |

### Self-Describing Schema

Each template includes a `_schema:` block listing its own required and optional fields. The validation hook reads this block to determine what is mandatory, enabling new templates without hook code changes.

### Usage in Specs

Contracts are embedded inline in spec markdown using fenced YAML blocks with the language tag `yaml:contract`:

````markdown
```yaml:contract
_template: rest-api
method: POST
path: /api/v1/sessions
# ... remaining fields from template
```
````

### Core-Over-Freeform Precedence

Core structured fields are always authoritative over freeform `context:` fields. If a freeform context field contradicts a core field value, the core field is the source of truth and the validation hook will emit a warning.

## Naming Conventions

Naming conventions for all four contract types are documented at `.claude/contracts/naming-conventions.md`. Key patterns:

- **REST API endpoints**: kebab-case paths with path-based versioning (`/api/v{n}/...`)
- **Event names**: dot-separated lowercase (`resource.action`)
- **Data model fields**: snake_case
- **Error codes**: lowercase_underscore, namespaced by domain
- **Security**: `SECRET_`/`PRIVATE_` prefixes for sensitive env vars, `pii_*` markers for PII fields

**Precedence rule**: New code follows new conventions; existing code follows legacy conventions until refactored.

## Contract Validation Workflow

Contract validation operates at two levels:

### 1. Structural Validation (Automated, Authoring Time)

The `contract-validate.mjs` PostToolUse hook fires on spec writes (`.claude/specs/**/*.md`) and checks:

- Required fields present (from template `_schema:` block)
- Security field presence based on `boundary_visibility` (defaulting to "external")
- Freeform `context:` fields do not contradict core field values
- Specs without contract sections pass cleanly (backward compatible)

### 2. Semantic Validation (Agent-Driven, Investigation Time)

The interface investigator's Category 8 (Contract Completeness) validates:

- Field values consistent across specs (no cross-spec contradictions)
- No placeholder content ("TODO", "TBD") in contract fields
- Contract references resolve to real paths
- Naming conventions followed

### Append-Only Contract Modification Rule

Once a contract is defined, existing fields cannot be removed or have their types changed. Type widening (e.g., `string` to `string|null`) is a breaking change. Breaking changes require a new contract version with `-v2` suffix. This is enforced by convention (agent instructions and code review) -- automated enforcement is deferred.

## Validation at Boundaries

### Rules

- Validate all external input at the point of entry (config files, API payloads, WebSocket messages)
- Use `z.infer<typeof Schema>` for type derivation — never maintain a parallel type definition
- Internal code trusts the validated types — no re-validation deeper in the stack
- Invalid state should be impossible to represent after the boundary layer

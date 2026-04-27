---
_source_modules: ['spec-schemas', 'spec-schema-validate']
title: Spec Frontmatter Reference — Runtime Connectivity Fields
last_reviewed: 2026-04-19
---

# Spec Frontmatter Reference — Runtime Connectivity Fields

Reference for the five runtime-connectivity frontmatter fields plus the widened `e2e_skip_rationale` enum. All fields live in markdown spec frontmatter (WorkstreamSpec + AtomicSpec). `e2e_skip_rationale` additionally lives on manifest.json (SpecGroup).

Source schemas:

- `.claude/specs/schema/workstream-spec.schema.json`
- `.claude/specs/schema/atomic-spec.schema.json`
- `.claude/specs/schema/spec-group.schema.json` (`e2e_skip_rationale` enum only)

The source of truth is the schema files above, the validator in `.claude/scripts/spec-schema-validate.mjs`, and the focused schema regression tests in `.claude/scripts/__tests__/`.

All fields are **optional at the top level**; conditional requirements apply only when a gating field is set (see each field below). Schema is additive — legacy specs without these fields continue to validate.

---

## Field Summary

| Field                            | Type                   | Conditional                                                  | Consumer                        |
| -------------------------------- | ---------------------- | ------------------------------------------------------------ | ------------------------------- |
| `runtime_env`                    | object                 | `rationale` required when `liveness` ∈ {L2, L3}              | `e2e-test-writer`               |
| `crosses_boundary`               | boolean                | `crosses_boundary_rationale` required when `false`           | `sg-e2e-gate5-enforcement`      |
| `runtime_connectivity_budget_ms` | integer (0–60000)      | `runtime_connectivity_budget_rationale` required when set    | `sg-e2e-gate5-enforcement`      |
| `security_surface`               | enum \| enum[] \| null | —                                                            | `sg-e2e-gate5-enforcement`      |
| `pure_compute_entry_points`      | string[]               | required (non-empty) when `e2e_skip_rationale: pure-compute` | `sg-e2e-pure-compute-check`     |
| `e2e_skip_rationale`             | enum                   | required when `e2e_skip: true`                               | `e2e-test-writer` dispatch gate |

---

## runtime_env

Declares the runtime environment tier a spec depends on. Replaces heuristic infra detection (see `contract-runtime-env-frontmatter` v1.0).

### Shape

```yaml
runtime_env:
  liveness: L1 | L2 | L3
  rationale: string # required (non-empty) when liveness is L2 or L3
  prefer_ipv6: boolean # optional, default false
```

### Tiers

| Value | Meaning                                                                          |
| ----- | -------------------------------------------------------------------------------- |
| `L1`  | Pure compute / in-process. No runtime environment required. Default floor.       |
| `L2`  | Sandboxed runtime (e.g., testcontainers, in-memory service). Rationale required. |
| `L3`  | Live service (real network, external provider). Rationale required.              |

### Examples

L1 (minimal):

```yaml
runtime_env:
  liveness: L1
```

L2 with rationale:

```yaml
runtime_env:
  liveness: L2
  rationale: 'depends on testcontainers postgres fixture'
```

L3 with IPv6 preference:

```yaml
runtime_env:
  liveness: L3
  rationale: 'integration with live SES sandbox'
  prefer_ipv6: true
```

### Validation

- `liveness: L4` — rejected (enum).
- `liveness: L2` without `rationale` — rejected (conditional required).
- `prefer_ipv6: "true"` (string) — rejected (type).

---

## crosses_boundary

Author-declared scope gate for runtime connectivity. Replaces heuristic boundary detection (see `contract-crosses-boundary-signal` v1.0).

### Shape

```yaml
crosses_boundary: boolean # default true when absent
crosses_boundary_rationale: string # required (non-empty) when crosses_boundary is explicitly false
```

### Semantics

| Value            | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `true` or absent | Spec is in-scope for runtime connectivity (default).        |
| `false`          | Spec explicitly out of scope. Rationale required for audit. |

### Examples

In-scope (implicit):

```yaml
# crosses_boundary omitted — default true
```

Out of scope with rationale:

```yaml
crosses_boundary: false
crosses_boundary_rationale: 'Pure spec-schema validation; no HTTP / WS / SSE / subprocess / external state mutation.'
```

### Validation

- `crosses_boundary: false` without `crosses_boundary_rationale` — rejected.
- `crosses_boundary: "no"` (string) — rejected (type).

---

## runtime_connectivity_budget_ms

Per-spec override for the Gate 5 execution budget.

### Shape

```yaml
runtime_connectivity_budget_ms: integer # 0–60000 inclusive (hard cap)
runtime_connectivity_budget_rationale: string # required (non-empty) when budget set
```

### Examples

```yaml
runtime_connectivity_budget_ms: 30000
runtime_connectivity_budget_rationale: 'Large SQL migration replay; measured p95 22s.'
```

### Validation

- `runtime_connectivity_budget_ms: 60001` — rejected (over hard cap).
- Budget set without rationale — rejected.
- `runtime_connectivity_budget_ms: "30000"` (string) — rejected (type).
- `runtime_connectivity_budget_ms: 0` — accepted at schema layer; may be rejected at runtime by Gate 5 as unworkable.

---

## security_surface

Authoritative enum declaring which security-relevant surfaces a spec touches. This is an **enum**, not a boolean (see `contract-security-surface-enum` v1.0). Schema rejection of out-of-enum values is the primary typosquatting defense (SEC-010).

### Shape

```yaml
security_surface: <enum> | <enum>[] | null
```

Enum values: `auth | cors | session | csrf | serialization | input-validation`.

### oneOf Branches

| Branch          | Example                          | Meaning                                  |
| --------------- | -------------------------------- | ---------------------------------------- |
| Single value    | `security_surface: auth`         | One surface touched.                     |
| Array of values | `security_surface: [auth, cors]` | Multiple surfaces touched (minItems: 1). |
| Explicit null   | `security_surface: null`         | Documented "no surface".                 |
| Absent          | (field omitted)                  | Treated as null.                         |

### Examples

```yaml
# Single
security_surface: auth

# Multiple
security_surface: [auth, cors]

# Explicit none
security_surface: null
```

### Validation

- `security_surface: csrfs` (typo) — rejected (enum).
- `security_surface: [auth, fake]` — rejected on the bad array element.
- `security_surface: true` (boolean form) — rejected (oneOf branches are string / array / null).

---

## pure_compute_entry_points

Entry point file paths for the pure-compute static-analysis sub-check (see `contract-pure-compute-entry-points` v1.0). Conditionally required when a spec opts out of E2E tests via the `pure-compute` rationale.

### Shape

```yaml
pure_compute_entry_points: string[] # each element a non-empty string (file path)
```

### Conditional Requirement

Required + `minItems: 1` when **both** conditions hold:

- `e2e_skip: true`
- `e2e_skip_rationale: pure-compute`

Optional (permitted but ignored) for any other rationale.

### Examples

```yaml
e2e_skip: true
e2e_skip_rationale: pure-compute
pure_compute_entry_points:
  - src/lib/compute/engine.ts
  - src/lib/compute/cli.ts
```

### Validation

- `e2e_skip_rationale: pure-compute` without `pure_compute_entry_points` — rejected.
- Empty array `pure_compute_entry_points: []` — rejected (`minItems: 1`).
- Non-string elements `pure_compute_entry_points: [1, 2]` — rejected (type).

### Downstream

Consumed by the pure-compute verifier in `sg-e2e-pure-compute-check` (a Stage 2 workstream). This spec declares only the schema-level entry-point surface; verifier behaviour is documented separately when that workstream ships.

---

## e2e_skip_rationale — widened enum

The `e2e_skip_rationale` enum was widened from 4 values to 5 with the addition of `pure-compute` (see `contract-e2e-skip-rationale-enum` v1.1, additive).

### Enum Values

| Value           | When to use                                                                           |
| --------------- | ------------------------------------------------------------------------------------- |
| `pure-refactor` | Code motion / rename only; no behaviour change.                                       |
| `test-infra`    | Modifying test tooling, harness, or validator infrastructure (no runtime under test). |
| `type-only`     | TypeScript type definitions only; no runtime code.                                    |
| `docs-only`     | Documentation-only change.                                                            |
| `pure-compute`  | Deterministic pure-compute module; exempt via static-analysis proof of no I/O.        |

### When `pure-compute` Applies

Use `pure-compute` only when the implementation has zero runtime I/O (no HTTP, WS, SSE, subprocess, filesystem side effects, or external state mutation) **and** the spec declares entry points via `pure_compute_entry_points` so a downstream DFS verifier (in `sg-e2e-pure-compute-check`) can prove the claim.

Do not use `pure-compute` for:

- Specs that touch the filesystem (use `test-infra` or leave `e2e_skip` unset).
- Specs that invoke child processes (not pure).
- Specs that construct HTTP clients even if unused (the import graph would reach the I/O layer).

### Example

```yaml
e2e_skip: true
e2e_skip_rationale: pure-compute
pure_compute_entry_points:
  - src/lib/hash/compute.ts
```

### Downstream

Downstream consumers updated to accept `pure-compute`:

- `.claude/scripts/lib/workflow-dag.mjs` — `VALID_E2E_SKIP_RATIONALES` (source of truth).
- `.claude/scripts/spec-validate.mjs` — fallback constant.
- `.claude/scripts/workflow-stop-enforcement.mjs` — imports from workflow-dag.
- Test suites covering the enum length / membership.

All three JSON Schemas (workstream, atomic, spec-group) accept the widened enum.

---

## Interaction Matrix

| Scenario                                                                                        | Result                                                          |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `crosses_boundary: false` + no rationale                                                        | Reject — `crosses_boundary_rationale` required.                 |
| `runtime_env.liveness: L1` + no rationale                                                       | Accept — rationale optional for L1.                             |
| `runtime_env.liveness: L2` + empty/missing rationale                                            | Reject — rationale required for L2/L3.                          |
| `runtime_connectivity_budget_ms: 45000` + no rationale                                          | Reject — budget rationale required when budget set.             |
| `e2e_skip: true` + `e2e_skip_rationale: pure-compute` + no `pure_compute_entry_points`          | Reject — entry points required.                                 |
| `e2e_skip: true` + `e2e_skip_rationale: test-infra` + `pure_compute_entry_points: ['src/x.ts']` | Accept — entry points permitted (ignored) for non-pure-compute. |
| `security_surface` absent entirely                                                              | Accept — equivalent to `null`.                                  |
| Legacy spec with none of the new fields                                                         | Accept — all new fields optional at top level.                  |

---

## Cross-References

- Schema validator architecture: [SCHEMA-VALIDATION.md](./SCHEMA-VALIDATION.md).
- Hook registration: [HOOKS.md § spec-schema-validate.mjs](./HOOKS.md#spec-schema-validatemjs).
- Source schemas: `.claude/specs/schema/{workstream-spec,atomic-spec,spec-group}.schema.json`.
- Parent MasterSpec: [`sg-e2e-runtime-connectivity/spec.md`](../specs/groups/sg-e2e-runtime-connectivity/spec.md).
- Spec authoring conventions: [`memory-bank/best-practices/spec-authoring.md`](../memory-bank/best-practices/spec-authoring.md).

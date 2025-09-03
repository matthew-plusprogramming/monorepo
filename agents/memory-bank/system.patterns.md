| key | value |
| --- | --- |
| last_reviewed | 2025-09-03 |
| stage | planning |


# System Patterns

Overview
- This file captures durable patterns discovered during work. Classify each as declarative (facts) or procedural (repeatable sequences). Only procedural, high-value patterns may change workflows.

Definitions
- Declarative: Facts, mappings, invariants. Stored here and in related context files. Does not change workflows.
- Procedural: Steps/recipes that can be reused. Candidates for workflow synthesis.

Pattern Entry Format
- ID: PAT-YYYYMMDD-<slug>
- Title: short name
- Type: procedural | declarative
- Importance: low | medium | high
- Context: when this applies
- Trigger: signal that starts the pattern
- Steps: ordered list (procedural only)
- Signals: metrics/observables to detect usefulness
- Workflow_Impact: none | modify:<workflow> | create:<slug>
- Status: proposed | adopted

Synthesis Rule
- If Type=procedural and Importance>=medium and recurring across ≥2 tasks (per `agents/memory-bank/progress.log.md` or Reflexion), then:
  - Propose Workflow_Impact=modify:<existing> if pattern naturally augments an existing workflow phase; else Workflow_Impact=create:<slug>.
  - In the Documenter phase, perform "Workflow Synthesis":
    - Modify an existing workflow under `agents/workflows/*.workflow.md`, or
    - Create a new workflow from `agents/workflows/templates/pattern.workflow.template.md` as `agents/workflows/<slug>.workflow.md`.
  - For system-impacting changes, open ADR stub via `agents/memory-bank/decisions/ADR-0000-template.md`.

Example (Procedural)
- ID: PAT-20250903-workflow-synthesis
- Title: Workflow Synthesis from Procedural Patterns
- Type: procedural
- Importance: high
- Context: When a repeatable implementation/testing recipe emerges across tasks
- Trigger: Two or more Reflexion entries cite the same steps
- Steps:
  1. Capture the steps succinctly here
  2. Decide modify vs create
  3. Apply changes to `agents/workflows/*`
  4. Add ADR stub if impactful
  5. Log progress and Reflexion
- Signals: Fewer ad-hoc steps in similar tasks; faster execution
- Workflow_Impact: modify:default.workflow.md (or create:pattern-specific)
- Status: adopted

Example (Declarative)
- ID: PAT-20250903-env-facts
- Title: Environment Facts
- Type: declarative
- Importance: medium
- Context: Recording env vars and their meanings
- Trigger: New env var introduced
- Signals: Correctness of docs; reduced confusion
- Workflow_Impact: none
- Status: adopted

Adopted/Proposed Patterns

- ID: PAT-20250903-request-lifecycle
  - Title: Request Lifecycle Pipeline
  - Type: procedural
  - Importance: high
  - Context: Express handlers with Effect integration
  - Trigger: New/changed endpoints or middleware
  - Steps:
    1. Validate input with Zod
    2. Invoke effectful handler
    3. Map domain/validation errors to HTTP status/body
    4. Emit response with consistent shape
    5. Emit structured logs/metrics for observability
  - Signals: Fewer ad‑hoc response branches; consistent error mapping
  - Workflow_Impact: none
  - Status: adopted

- ID: PAT-20250903-infra-outputs-consumption
  - Title: Infra Outputs Consumption
  - Type: procedural
  - Importance: high
  - Context: Application requires infra names/ARNs produced by CDKTF
  - Trigger: New infra resource or new app dependency on infra
  - Steps:
    1. Deploy/synth stacks and ensure `cdktf-outputs/**/outputs.json` exists
    2. Use `@cdk/backend-server-cdk` consumer `loadCDKOutput`
    3. Respect `__BUNDLED__` when resolving outputs alongside bundles
    4. Wire outputs into services/clients
    5. Verify in dev and Lambda packaging paths
  - Signals: No hardcoded names; boot succeeds; env‑agnostic behavior
  - Workflow_Impact: none
  - Status: adopted

- ID: PAT-20250903-no-hardcoded-resource-names
  - Title: No Hardcoded Resource Names
  - Type: declarative
  - Importance: high
  - Context: Referencing infra resources in application code
  - Trigger: Reading table/log names or similar
  - Signals: Only outputs consumer used; no string literals for resource names
  - Workflow_Impact: none
  - Status: adopted

- ID: PAT-20250903-validate-external-inputs
  - Title: Validate All External Inputs
  - Type: declarative
  - Importance: high
  - Context: HTTP inputs, environment variables, and infra outputs
  - Trigger: Introduction of any new boundary
  - Signals: Zod schemas exist and are applied; boot fails early on invalid env
  - Workflow_Impact: none
  - Status: adopted

- ID: PAT-20250903-jwt-claims-binding
  - Title: JWT Claims Shape and Binding
  - Type: declarative
  - Importance: medium
  - Context: Auth middleware and downstream handlers
  - Trigger: Auth changes or new claim usage
  - Signals: Token schema stable; `req.user` type is consistent across handlers
  - Workflow_Impact: none
  - Status: adopted

- ID: PAT-20250903-config-build-flags
  - Title: Build/Runtime Flags Drive Entrypoints
  - Type: declarative
  - Importance: medium
  - Context: Vite build and runtime selection (Lambda vs Node)
  - Trigger: Changing packaging target or bundling mode
  - Signals: Uses `LAMBDA` and `__BUNDLED__` appropriately; minimal conditional paths
  - Workflow_Impact: none
  - Status: adopted

- ID: PAT-20250903-error-hygiene
  - Title: Error Hygiene and Mapping
  - Type: declarative
  - Importance: medium
  - Context: Error taxonomy and handler boundaries
  - Trigger: New error types or mapping rules
  - Signals: Central taxonomy; pretty Zod errors; no internal details leaked
  - Workflow_Impact: none
  - Status: adopted

- ID: PAT-20250903-observability-logs
  - Title: Observability via CloudWatch Logs
  - Type: declarative
  - Importance: medium
  - Context: Application and security stacks logging
  - Trigger: New service/feature requiring logs
  - Signals: Log groups/streams configured; structured logs emitted
  - Workflow_Impact: none
  - Status: adopted

- ID: PAT-20250903-security-rate-limit-denylist
  - Title: Security: Rate Limiting & Deny List
  - Type: procedural
  - Importance: medium
  - Context: Request throttling and blocklist checks
  - Trigger: Abuse signals or policy thresholds
  - Steps:
    1. Record requests in DynamoDB with TTL for rolling windows
    2. Check deny list table before processing
    3. Short‑circuit with appropriate status when violated
    4. Emit security logs/metrics
  - Signals: Reduced abuse; measurable throttles in logs/metrics
  - Workflow_Impact: none
  - Status: proposed

- ID: PAT-20250903-data-modeling-single-source
  - Title: Data Modeling Single Source of Truth
  - Type: declarative
  - Importance: medium
  - Context: Table keys/GSIs across infra and app
  - Trigger: Adding tables/GSIs or refactoring
  - Signals: Keys/GSIs defined in schema constants and reused by CDKTF and app
  - Workflow_Impact: none
  - Status: adopted

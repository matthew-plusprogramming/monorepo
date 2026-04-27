---
_source_modules: ['docs-scripts']
---

# Structured Documentation System

YAML documentation under `.claude/docs/structured/` for architecture maps,
flows, glossary terms, diagram sources, and PRD report inputs. Markdown docs are
not affected.

## Commands

| Task | Command |
| --- | --- |
| Scaffold starter docs | `node .claude/scripts/docs-scaffold.mjs` |
| Scaffold diagram YAML stubs | `node .claude/scripts/docs-scaffold-diagrams.mjs` |
| Validate YAML docs | `node .claude/scripts/docs-validate.mjs` |
| Validate as hook | `node .claude/scripts/docs-validate.mjs --hook` |
| Generate Mermaid diagrams | `node .claude/scripts/docs-generate.mjs` |
| Compare traces to docs | `node .claude/scripts/trace-docs-sync.mjs` |

All scripts accept `--project-root <path>`. Root resolution order:
`--project-root`, `--root`, `CLAUDE_PROJECT_DIR`, `git rev-parse`, then
`process.cwd()`.

## Directory Map

```text
.claude/docs/structured/
  schema.yaml
  architecture.yaml
  data-models.yaml
  states/index.yaml
  security.yaml
  deployment.yaml
  flows/index.yaml
  flows/<flow-name>.yaml
  glossary.yaml
  decisions.yaml        # optional
  runbooks.yaml         # optional
  generated/*.mmd
```

Templates are synced from `.claude/templates/structured-docs/` into consumer
repos. Project-authored structured docs are local working files and are not
overwritten after first creation.

## Core Files

| File | Purpose | Required top-level fields |
| --- | --- | --- |
| `architecture.yaml` | Module map and dependency graph | `schema_version`, `modules` |
| `flows/index.yaml` | Flow registry | `schema_version`, `flows` |
| `flows/<name>.yaml` | Ordered module flow | `schema_version`, `name`, `description`, `steps` |
| `glossary.yaml` | Project terms | `schema_version`, `terms` |
| `data-models.yaml` | ERD source | `schema_version`, `entities` |
| `states/index.yaml` | State diagram source | `schema_version`, `state_machines` |
| `security.yaml` | Security boundary diagram source | `schema_version`, `zones`, `data_flows` |
| `deployment.yaml` | Deployment topology diagram source | `schema_version`, `nodes`, `connections` |
| `decisions.yaml` | Optional architecture decisions | `decisions` |
| `runbooks.yaml` | Optional operational procedures | `runbooks` |

`schema_version` is currently `1`. Older versions warn; unknown future versions
fail validation.

## Minimal Examples

### Architecture And C4 Component Diagram

`architecture.yaml` drives `generated/architecture.mmd` and
`generated/component-c4.mmd`.

```yaml
schema_version: 1
modules:
  - name: api
    description: HTTP boundary
    path: src/api/**
    responsibilities:
      - Accept requests
    depends_on:
      - database
  - name: database
    description: Persistence
    path: src/db/**
    responsibilities:
      - Store records
```

`dependencies` is accepted as an alias for `depends_on`.

### Flow Diagram

`flows/index.yaml` points at individual flow files. Each step `module` must
match a module in `architecture.yaml`.

```yaml
schema_version: 1
name: login
description: User login flow
steps:
  - order: 1
    module: api
    action: Receive login request
  - order: 2
    module: database
    action: Load user record
```

Generated output: `generated/flow-login.mmd` as a Mermaid `sequenceDiagram`.

### ERD

`data-models.yaml` drives `generated/erd.mmd` as Mermaid `erDiagram`.

```yaml
schema_version: 1
entities:
  - name: Order
    attributes:
      - name: id
        type: uuid
        primary: true
    relationships:
      - target: Customer
        type: many-to-one
        label: placed by
```

### State Diagram

`states/index.yaml` drives `generated/state-<name>.mmd` as Mermaid
`stateDiagram-v2`.

```yaml
schema_version: 1
state_machines:
  - name: order-lifecycle
    initial: created
    states:
      - name: created
      - name: shipped
    transitions:
      - from: created
        to: shipped
        trigger: shipment_dispatched
```

### Security Boundary Diagram

`security.yaml` drives `generated/security.mmd`. It uses `_sync_policy:
"never-sync"` and is not propagated to consumer projects.

```yaml
schema_version: 1
zones:
  - name: public-internet
    trust_level: untrusted
    components:
      - cdn
data_flows:
  - from: public-internet
    to: dmz
    protocol: HTTPS
```

### Deployment Topology Diagram

`deployment.yaml` drives `generated/deployment.mmd`.

```yaml
schema_version: 1
nodes:
  - name: web-server-pool
    type: server
    services:
      - nginx
connections:
  - from: web-server-pool
    to: primary-db
    protocol: TCP/5432
```

## Validation Contract

`docs-validate.mjs` checks:

- required fields, field types, uniqueness, and enums
- schema version
- flow module references against `architecture.yaml`
- glossary `see_also` references
- flow index file existence and path confinement under `flows/`
- stale or manually edited `.mmd` files through source hashes
- module path globs that match no tracked files
- path confinement and file-size limits
- trace/docs divergence when `high-level.json` exists

Warnings do not block in CLI mode. Validation errors exit `1`; the hook wrapper
converts hook-mode failures to blocking exit `2`.

Limits:

| Limit | Value |
| --- | --- |
| YAML file size | 1 MB |
| Architecture modules | 500 |
| Flow index entries | 100 |
| Module path glob length | 200 chars |

## Generation Contract

`docs-generate.mjs` writes Mermaid files under
`.claude/docs/structured/generated/`.

| Source | Output | Diagram |
| --- | --- | --- |
| `architecture.yaml` | `architecture.mmd` | `flowchart TD` |
| `architecture.yaml` | `component-c4.mmd` | C4-style component graph |
| `flows/<name>.yaml` | `flow-<name>.mmd` | `sequenceDiagram` |
| `data-models.yaml` | `erd.mmd` | `erDiagram` |
| `states/index.yaml` | `state-<name>.mmd` | `stateDiagram-v2` |
| `security.yaml` | `security.mmd` | `flowchart TD` |
| `deployment.yaml` | `deployment.mmd` | `flowchart LR` |

Each generated `.mmd` starts with:

```text
%% source-hash: a1b2c3d4
```

The hash is the first 8 chars of the SHA-256 digest of LF-normalized YAML
source. Regeneration overwrites manual `.mmd` edits.

## Trace Bridge

`docs-scaffold.mjs` uses trace data when `high-level.json` and
`low-level/<module>.json` exist. It pre-fills candidate module descriptions,
exports, and dependencies as TODOs for human review.

`trace-docs-sync.mjs` is read-only. It reports:

- traced modules missing from `architecture.yaml`
- docs modules missing from traces
- new or removed exports
- dependency differences

## Templates And Sync Policy

| Template | Sync policy |
| --- | --- |
| `architecture.yaml` | never-overwrite |
| `data-models.yaml` | never-overwrite |
| `deployment.yaml` | never-overwrite |
| `flows/index.yaml` | never-overwrite |
| `glossary.yaml` | never-overwrite |
| `security.yaml` | never-sync |
| `states/index.yaml` | never-overwrite |

`never-overwrite` preserves project-specific docs after initial sync.
`security.yaml` is local-only because it can expose sensitive topology and trust
boundary details.

## Two-Phase PRD Report

The PRD Report template is `.claude/templates/prd-report.template.md`.

Phase 1 is created at PRD completion and includes architecture, user-flow,
security-boundary, and requirement-summary sections.

Phase 2 is assembled after spec completion and adds ERD diagrams, detailed
sequence diagrams, and contract tables while retaining Phase 1 content.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `architecture.yaml already has content` | Edit the file directly, or delete it before scaffolding. |
| `File exceeds 1MB limit` | Split the YAML source. |
| `Unknown schema_version` | Update scripts or set `schema_version: 1`. |
| Path confinement violation | Remove `..` or paths resolving outside the project root. |
| Stale diagram warning | Run `node .claude/scripts/docs-generate.mjs`. |
| Hook blocks a YAML edit | Fix the validation error printed on stderr, then retry. |

## Security

- YAML parsing uses the `yaml` package safe defaults; custom tags are not
  accepted.
- User-provided paths are resolved and checked against the project root.
- Flow file references are additionally confined to `flows/`.
- Mermaid labels are sanitized before generation.
- Size and collection limits protect hook execution from very large inputs.

## See Also

- [TRACES.md](TRACES.md)
- [HOOKS.md](HOOKS.md)
- [SYNC-SYSTEM.md](SYNC-SYSTEM.md)
- `.claude/docs/structured/schema.yaml`

# Structured Documentation System

Machine-readable YAML documentation with automated validation, Mermaid diagram generation, project scaffolding, and trace system integration.

---

## Overview

The structured documentation system provides a YAML-based foundation for project documentation. It consists of:

- **Schema**: A `schema.yaml` reference defining 6 document types
- **Validation**: `docs-validate.mjs` checks schema compliance, cross-references, freshness, and trace cross-references
- **Generation**: `docs-generate.mjs` produces Mermaid diagrams from YAML sources
- **Scaffolding**: `docs-scaffold.mjs` generates a draft architecture from project structure, with optional trace data population
- **Sync Report**: `trace-docs-sync.mjs` compares trace data against docs and reports divergence
- **Templates**: Empty YAML templates synced to consumer projects via the registry

All structured YAML files live under `.claude/docs/structured/`. Existing `.claude/docs/*.md` files are not affected.

---

## Quick Start

### 1. Scaffold Your Architecture

```bash
node .claude/scripts/docs-scaffold.mjs
```

This scans your project directory and generates a draft `architecture.yaml` with TODO placeholders. It also creates empty `flows/index.yaml` and `glossary.yaml` files.

If trace data is available (from `trace-generate.mjs`), the scaffolder pre-populates TODO placeholders with export names, dependency lists, and module descriptions from the traces. Entries remain marked as TODO for human review.

### 2. Fill in the TODOs

Edit `.claude/docs/structured/architecture.yaml` to describe your modules, their paths, and dependencies.

### 3. Validate

```bash
node .claude/scripts/docs-validate.mjs
```

Checks all structured docs for schema violations, broken cross-references, stale diagrams, and trace-to-docs cross-reference mismatches.

### 4. Generate Diagrams

```bash
node .claude/scripts/docs-generate.mjs
```

Produces Mermaid `.mmd` files in `.claude/docs/structured/generated/`.

### 5. Check Trace-Docs Sync

```bash
node .claude/scripts/trace-docs-sync.mjs
```

Compares trace data against `architecture.yaml` and reports divergence (new exports, changed dependencies). No files are modified.

---

## Directory Structure

```
.claude/
  docs/
    structured/
      schema.yaml                  # Schema reference (validation rules)
      architecture.yaml            # Module dependency map
      data-models.yaml             # Entity-relationship diagram source
      states/
        index.yaml                 # State machine diagram source
      security.yaml                # Security boundary diagram source
      deployment.yaml              # Deployment topology diagram source
      flows/
        index.yaml                 # Flow index
        <flow-name>.yaml           # Individual flow definitions
      glossary.yaml                # Project terminology
      decisions.yaml               # Architecture decision records (optional)
      runbooks.yaml                # Operational procedures (optional)
      generated/
        architecture.mmd           # Generated architecture diagram
        component-c4.mmd           # Generated C4 component diagram
        erd.mmd                    # Generated entity-relationship diagram
        state-<name>.mmd           # Generated state machine diagrams
        security.mmd               # Generated security boundary diagram
        deployment.mmd             # Generated deployment topology diagram
        flow-<name>.mmd            # Generated flow diagrams
  templates/
    structured-docs/
      architecture.yaml            # Empty template (synced to consumers)
      data-models.yaml             # Empty data models template
      states/
        index.yaml                 # Empty state machines template
      security.yaml                # Empty security boundary template
      deployment.yaml              # Empty deployment topology template
      flows/
        index.yaml                 # Empty flow index template
      glossary.yaml                # Empty glossary template
    prd-report.template.md         # Two-phase PRD Report template
  scripts/
    docs-validate.mjs              # Validation script
    docs-generate.mjs              # Mermaid generation script
    docs-scaffold.mjs              # Directory scaffolder (architecture)
    docs-scaffold-diagrams.mjs     # Diagram YAML stub scaffolder
    trace-docs-sync.mjs            # Trace-docs sync report
    lib/
      yaml-utils.mjs               # Shared YAML parsing utilities
```

---

## Document Types

### architecture.yaml

Defines the project module map with dependencies.

| Field          | Type | Required | Description                        |
| -------------- | ---- | -------- | ---------------------------------- |
| schema_version | int  | Yes      | Schema version number (current: 1) |
| modules        | list | Yes      | List of module definitions         |

Each module requires:

| Field            | Type   | Required | Description                         |
| ---------------- | ------ | -------- | ----------------------------------- |
| name             | string | Yes      | Unique module identifier            |
| description      | string | Yes      | What this module does               |
| path             | string | Yes      | Glob pattern for source files       |
| responsibilities | list   | Yes      | List of responsibility strings      |
| depends_on       | list   | No       | Module names this module depends on |

The field `dependencies` is accepted as an alias for `depends_on`.

**Example**:

```yaml
schema_version: 1
modules:
  - name: auth-service
    description: Authentication and session management
    path: 'src/auth/**'
    responsibilities:
      - User login and logout
      - Token management
    depends_on:
      - database
```

### flows/index.yaml

Index of all flow definitions. Each entry references a separate flow file.

| Field          | Type | Required | Description           |
| -------------- | ---- | -------- | --------------------- |
| schema_version | int  | Yes      | Schema version number |
| flows          | list | Yes      | List of flow entries  |

Each flow entry requires:

| Field       | Type   | Required | Description                            |
| ----------- | ------ | -------- | -------------------------------------- |
| name        | string | Yes      | Unique flow name                       |
| file        | string | Yes      | Path to flow YAML file (within flows/) |
| description | string | Yes      | What this flow represents              |

### flows/\*.yaml (Individual Flows)

Defines ordered steps referencing architecture modules.

| Field          | Type   | Required | Description               |
| -------------- | ------ | -------- | ------------------------- |
| schema_version | int    | Yes      | Schema version number     |
| name           | string | Yes      | Flow name                 |
| description    | string | Yes      | What this flow represents |
| steps          | list   | Yes      | Ordered list of steps     |

Each step requires:

| Field  | Type   | Required | Description                              |
| ------ | ------ | -------- | ---------------------------------------- |
| order  | int    | Yes      | Step sequence number                     |
| module | string | Yes      | Module name (must exist in architecture) |
| action | string | Yes      | What happens at this step                |

**Example**:

```yaml
schema_version: 1
name: user-login
description: End-to-end user authentication flow
steps:
  - order: 1
    module: api-gateway
    action: Receive login request
  - order: 2
    module: auth-service
    action: Validate credentials
  - order: 3
    module: database
    action: Check user record
```

### glossary.yaml

Project terminology definitions.

| Field          | Type | Required | Description              |
| -------------- | ---- | -------- | ------------------------ |
| schema_version | int  | Yes      | Schema version number    |
| terms          | list | Yes      | List of term definitions |

Each term requires:

| Field      | Type   | Required | Description                                 |
| ---------- | ------ | -------- | ------------------------------------------- |
| term       | string | Yes      | The term being defined                      |
| definition | string | Yes      | Clear definition                            |
| see_also   | list   | No       | Related term names (must exist in glossary) |

### decisions.yaml (Extension)

Architecture decision records. This file is optional.

Each decision requires:

| Field        | Type   | Required | Description                                        |
| ------------ | ------ | -------- | -------------------------------------------------- |
| id           | string | Yes      | Unique decision ID (e.g., ADR-001)                 |
| title        | string | Yes      | Short title                                        |
| status       | string | Yes      | One of: proposed, accepted, deprecated, superseded |
| date         | string | Yes      | Decision date (YYYY-MM-DD)                         |
| context      | string | Yes      | Why this decision was needed                       |
| options      | list   | Yes      | Options considered                                 |
| chosen       | string | Yes      | Selected option                                    |
| consequences | list   | Yes      | Consequences of this decision                      |

### runbooks.yaml (Extension)

Operational procedures. This file is optional.

Each runbook requires:

| Field       | Type   | Required | Description                                     |
| ----------- | ------ | -------- | ----------------------------------------------- |
| name        | string | Yes      | Unique runbook name                             |
| description | string | Yes      | When to use this runbook                        |
| steps       | list   | Yes      | Ordered list of steps (each with order, action) |
| severity    | string | No       | One of: critical, high, medium, low             |

### data-models.yaml (Diagram Source)

Entity-relationship diagram source for data model visualization.

| Field          | Type | Required | Description                |
| -------------- | ---- | -------- | -------------------------- |
| schema_version | int  | Yes      | Schema version number      |
| entities       | list | Yes      | List of entity definitions |

Each entity requires:

| Field         | Type   | Required | Description                                 |
| ------------- | ------ | -------- | ------------------------------------------- |
| name          | string | Yes      | Unique entity name                          |
| attributes    | list   | No       | List of entity attributes (name, type)      |
| relationships | list   | No       | List of relationships (target, type, label) |
| module        | string | No       | Module grouping for large diagram collapse  |

**Example**:

```yaml
schema_version: 1
entities:
  - name: Order
    attributes:
      - name: id
        type: uuid
        primary: true
      - name: total
        type: decimal
    relationships:
      - target: Customer
        type: many-to-one
        label: placed by
```

**Generated diagram**: `generated/erd.mmd` (Mermaid `erDiagram`)

### states/index.yaml (Diagram Source)

State machine diagram source for workflow visualization.

| Field          | Type | Required | Description                       |
| -------------- | ---- | -------- | --------------------------------- |
| schema_version | int  | Yes      | Schema version number             |
| state_machines | list | Yes      | List of state machine definitions |

Each state machine requires:

| Field       | Type   | Required | Description                      |
| ----------- | ------ | -------- | -------------------------------- |
| name        | string | Yes      | Unique state machine name        |
| states      | list   | Yes      | List of state definitions (name) |
| transitions | list   | Yes      | List of transitions (from, to)   |
| initial     | string | No       | Initial state name               |

**Example**:

```yaml
schema_version: 1
state_machines:
  - name: order-lifecycle
    initial: created
    states:
      - name: created
      - name: processing
      - name: shipped
    transitions:
      - from: created
        to: processing
        trigger: payment_confirmed
      - from: processing
        to: shipped
        trigger: shipment_dispatched
```

**Generated diagrams**: `generated/state-<name>.mmd` (Mermaid `stateDiagram-v2`)

### security.yaml (Diagram Source)

Security boundary diagram source for threat modeling visualization.

| Field          | Type | Required | Description                       |
| -------------- | ---- | -------- | --------------------------------- |
| schema_version | int  | Yes      | Schema version number             |
| zones          | list | Yes      | List of security zone definitions |
| data_flows     | list | Yes      | List of data flow definitions     |

Each zone requires:

| Field       | Type   | Required | Description                                                    |
| ----------- | ------ | -------- | -------------------------------------------------------------- |
| name        | string | Yes      | Unique zone name                                               |
| trust_level | string | Yes      | Trust level (untrusted, semi-trusted, trusted, highly-trusted) |
| components  | list   | No       | List of component names within this zone                       |

Each data flow requires:

| Field    | Type   | Required | Description                     |
| -------- | ------ | -------- | ------------------------------- |
| from     | string | Yes      | Source zone name                |
| to       | string | Yes      | Target zone name                |
| protocol | string | No       | Communication protocol          |
| data     | string | No       | Description of data transferred |

**Example**:

```yaml
schema_version: 1
zones:
  - name: public-internet
    trust_level: untrusted
    components:
      - cdn
      - load-balancer
  - name: dmz
    trust_level: semi-trusted
    components:
      - api-gateway
data_flows:
  - from: public-internet
    to: dmz
    protocol: HTTPS
    data: API requests
```

**Generated diagram**: `generated/security.mmd` (Mermaid `flowchart TD` with security zones)

**Note**: `security.yaml` uses `_sync_policy: "never-sync"` and will NOT be propagated to consumer projects.

### deployment.yaml (Diagram Source)

Deployment topology diagram source for infrastructure visualization.

| Field          | Type | Required | Description                       |
| -------------- | ---- | -------- | --------------------------------- |
| schema_version | int  | Yes      | Schema version number             |
| nodes          | list | Yes      | List of infrastructure nodes      |
| connections    | list | Yes      | List of connections between nodes |

Each node requires:

| Field    | Type   | Required | Description                                        |
| -------- | ------ | -------- | -------------------------------------------------- |
| name     | string | Yes      | Unique node name                                   |
| type     | string | Yes      | Node type (server, container, database, cdn, etc.) |
| services | list   | No       | List of services running on this node              |

**Example**:

```yaml
schema_version: 1
nodes:
  - name: web-server-pool
    type: server
    services:
      - nginx
      - node-app
  - name: primary-db
    type: database
    services:
      - postgresql
connections:
  - from: web-server-pool
    to: primary-db
    protocol: TCP/5432
    label: SQL queries
```

**Generated diagram**: `generated/deployment.mmd` (Mermaid `flowchart LR`)

### C4 Component Diagram (from architecture.yaml)

The C4-style component diagram is generated from the existing `architecture.yaml` file (no additional YAML template needed). It uses C4 naming conventions (System, Container, Component labels) to visualize the module dependency graph.

**Generated diagram**: `generated/component-c4.mmd` (Mermaid `flowchart TD` with C4 styling)

---

## Two-Phase PRD Report

The PRD Report is a living artifact generated in two phases:

**Phase 1** (at PRD completion, triggered by Phase 1.6 in `/prd` skill):

- Architecture overview (C4 component diagram)
- User flow sequence diagrams
- Security boundary diagram
- Textual requirement summaries

**Phase 2** (post-spec completion, owned by `/docs` skill, assembled by documenter agent):

- ERD diagrams from data model contracts
- Detailed sequence diagrams from spec flow definitions
- Contract overview table
- Retains all Phase 1 content

Template: `.claude/templates/prd-report.template.md`

---

## Scripts Reference

### docs-scaffold.mjs

Generates a draft `architecture.yaml` by analyzing the project directory structure.

**Usage**:

```bash
node .claude/scripts/docs-scaffold.mjs
node .claude/scripts/docs-scaffold.mjs --project-root /path/to/project
```

**Behavior**:

- If `architecture.yaml` already has modules, the scaffolder refuses to overwrite and exits with a message pointing to the existing file.
- If `architecture.yaml` is missing or has zero modules, the scaffolder scans the project and generates a draft.
- Also creates empty `flows/index.yaml` and `glossary.yaml` if they do not exist.

**Trace Data Population**: When trace data is available (`high-level.json` and `low-level/<module>.json` exist), the scaffolder enriches candidates with export names, dependency lists, and module descriptions from traces. All trace-populated entries remain marked as TODO for human review. Without trace data, the scaffolder generates empty placeholders as before.

**Project Analysis Strategy**:

1. Checks for monorepo structure (`apps/`, `packages/`) and creates modules for each subdirectory
2. Checks for `src/` directory and creates modules from its subdirectories
3. Falls back to scanning top-level directories with source files

Skipped directories: `node_modules`, `.git`, `.claude`, `dist`, `build`, `out`, `coverage`, `.next`, `.nuxt`, `.cache`, `__pycache__`, `.vscode`, `.idea`, `vendor`, `.turbo`.

**Exit Codes**:

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| 0    | Draft created successfully                      |
| 1    | Refused to overwrite existing content, or error |

---

### docs-validate.mjs

Validates all structured YAML documents in `.claude/docs/structured/`.

**Usage**:

```bash
node .claude/scripts/docs-validate.mjs
node .claude/scripts/docs-validate.mjs --hook
node .claude/scripts/docs-validate.mjs --project-root /path/to/project
```

**Validation Checks**:

| Category               | What It Checks                                                        |
| ---------------------- | --------------------------------------------------------------------- |
| Schema validation      | Required fields, types, uniqueness, enum values for all 6 types       |
| Schema version         | Warns on older versions, errors on unknown/future versions            |
| Cross-references       | Flow modules exist in architecture, glossary see_also resolves        |
| Flow index files       | Referenced flow files exist on disk, confined to flows/ directory     |
| Circular deps          | Detected and reported as informational notes (not errors)             |
| Module path globs      | Warns when a module path glob matches zero files in git               |
| Freshness              | Compares .mmd source hashes against current YAML content              |
| Manual edit warning    | Warns if .mmd files were manually edited (hash mismatch or missing)   |
| Empty architecture     | Nudges to run scaffolder when architecture has zero modules           |
| Path confinement       | Rejects paths containing `..` segments                                |
| File size limits       | Rejects files exceeding 1MB before parsing                            |
| Collection limits      | Rejects >500 modules or >100 flows                                    |
| Trace cross-references | Warns on docs modules not in traces; notes traced modules not in docs |

**Trace Cross-Reference Validation**: When `high-level.json` exists, the validator compares module names in `architecture.yaml` against traced module IDs and names. Modules referenced in docs but not in traces produce warnings. Traced modules not referenced in docs produce informational notes. Projects without trace data or `architecture.yaml` skip this check silently.

**Output Modes**:

- **CLI mode** (default): Full human-readable output with errors, warnings, and info categorized separately. Summary line at the end.
- **Hook mode** (`--hook`): Structured output for PostToolUse integration. Errors go to stderr with exit 1 (converted to exit 2 by hook-wrapper). Warnings go to stderr with exit 0.

**Extensibility**: Additional properties in YAML documents beyond the schema definition are silently accepted and do not cause errors.

**Exit Codes**:

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| 0    | All checks passed, or warnings only                |
| 1    | Validation errors found (schema, parse, cross-ref) |

---

### docs-generate.mjs

Generates Mermaid `.mmd` diagram files from structured YAML sources.

**Usage**:

```bash
node .claude/scripts/docs-generate.mjs
node .claude/scripts/docs-generate.mjs --project-root /path/to/project
```

**Generated Diagrams**:

| Source            | Output                     | Diagram Type      |
| ----------------- | -------------------------- | ----------------- |
| architecture.yaml | generated/architecture.mmd | flowchart TD      |
| architecture.yaml | generated/component-c4.mmd | flowchart TD (C4) |
| flows/<name>.yaml | generated/flow-<name>.mmd  | sequenceDiagram   |
| data-models.yaml  | generated/erd.mmd          | erDiagram         |
| states/index.yaml | generated/state-<name>.mmd | stateDiagram-v2   |
| security.yaml     | generated/security.mmd     | flowchart TD      |
| deployment.yaml   | generated/deployment.mmd   | flowchart LR      |

**Architecture Diagrams**:

- Modules render as labeled nodes
- Dependencies render as directed edges (`-->`)
- Circular dependencies render as bidirectional edges (`<-->`)
- Modules with no dependencies appear as unconnected nodes

**Flow Diagrams**:

- Modules render as participants
- Steps render as messages between participants, ordered by step `order` field
- Uses `autonumber` for automatic step numbering
- Steps between different modules render as arrows; steps within the same module render as notes

**Source Hash**:

Every generated `.mmd` file begins with a source hash comment:

```
%% source-hash: a1b2c3d4
```

The hash is the first 8 characters of the SHA-256 digest of the LF-normalized YAML source content. This enables the validator to detect stale diagrams and manual edits.

**Exit Codes**:

| Code | Meaning                       |
| ---- | ----------------------------- |
| 0    | All diagrams generated        |
| 1    | One or more generation errors |

---

### trace-docs-sync.mjs

Compares trace data against `architecture.yaml` and produces a human-readable divergence report.

**Usage**:

```bash
node .claude/scripts/trace-docs-sync.mjs
```

**Behavior**:

- Loads `high-level.json` for module list and dependencies
- Loads `low-level/<module>.json` for export details per module
- Loads `architecture.yaml` for docs module data
- Compares exports and dependencies between trace and docs
- Produces a report listing divergence per module

**Report Format**:

```
Trace-Docs Sync Report
======================

Module: scripts-lib
  New exports not in docs: parseCallGraph, parseEventPatterns
  Removed exports still in docs: (none)
  Changed dependencies: +trace-scripts (new)

Summary: 1 module(s) with divergence, 2 new export(s), 0 removed export(s)
```

The report is informational only. No docs files are modified. The comparison is heuristic: export names are checked against the module description and responsibilities text in `architecture.yaml`.

**Edge Cases**:

- No trace data: Reports "No trace data available"
- No `architecture.yaml`: Reports "No architecture.yaml found"
- Module in traces but not docs: Listed with "In traces but NOT in architecture.yaml"
- Module in docs but not traces: Listed with "In architecture.yaml but NOT in traces"

**Exit Codes**:

| Code | Meaning          |
| ---- | ---------------- |
| 0    | Report generated |
| 1    | Script error     |

---

### lib/yaml-utils.mjs

Shared utility library used by all three scripts. Not invoked directly.

**Exported Functions**:

| Function               | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `safeParseYaml`        | Parse YAML with safe schema, return data and line counter   |
| `readAndParseYaml`     | Read file, check size, parse safely                         |
| `confineToProject`     | Validate path stays within project root (resolves symlinks) |
| `confineToFlowsDir`    | Validate flow file reference stays within flows/ directory  |
| `checkFileSize`        | Reject files exceeding size limit                           |
| `lfNormalize`          | Normalize line endings to LF                                |
| `computeSourceHash`    | Compute 8-char SHA-256 hash of LF-normalized content        |
| `extractSourceHash`    | Extract hash from .mmd file first line                      |
| `getStructuredDocsDir` | Resolve path to .claude/docs/structured/                    |
| `getGeneratedDir`      | Resolve path to .claude/docs/structured/generated/          |
| `resolveProjectRoot`   | Resolve project root from CLI args, env, git, or cwd        |

**Exported Constants**:

| Constant                 | Value              | Description              |
| ------------------------ | ------------------ | ------------------------ |
| `MAX_FILE_SIZE_BYTES`    | 1,048,576          | 1MB file size limit      |
| `MAX_MODULES_COUNT`      | 500                | Maximum modules per file |
| `MAX_FLOWS_COUNT`        | 100                | Maximum flows per index  |
| `CURRENT_SCHEMA_VERSION` | 1                  | Current schema version   |
| `SOURCE_HASH_LENGTH`     | 8                  | Hash truncation length   |
| `SOURCE_HASH_PREFIX`     | `%% source-hash: ` | .mmd hash comment prefix |

**Error Class**:

All scripts use `DocsError` which carries:

- `message`: Human-readable description
- `category`: Error classification (Parse error, Schema violation, Path confinement, Size limit, File error)
- `filePath`: Associated file path
- `details`: Additional structured data

---

## Project Root Resolution

All scripts resolve the project root in this order:

1. `--project-root <path>` CLI argument
2. `--root <path>` CLI argument (alias for test harness)
3. `CLAUDE_PROJECT_DIR` environment variable
4. `git rev-parse --show-toplevel`
5. `process.cwd()` fallback

---

## PostToolUse Hook Integration

The validator is registered as a PostToolUse hook in `.claude/settings.json`. When any `.claude/docs/**/*.yaml` file is edited, `docs-validate.mjs` runs automatically in hook mode.

**Hook Behavior**:

- Blocking errors (schema violations, parse failures): Exit 1, which hook-wrapper.mjs converts to exit 2 (blocks the edit)
- Warnings (stale diagrams, dangling globs): Exit 0 with messages on stderr (does not block)
- Clean validation: Exit 0 with no output

---

## Schema Version

All structured YAML files include a `schema_version` field. The current version is **1**.

| Version Value   | Validator Behavior       |
| --------------- | ------------------------ |
| `1` (current)   | No warnings or errors    |
| `< 1` (older)   | Warning emitted          |
| `> 1` (unknown) | Error (validation fails) |
| Non-integer     | Error (validation fails) |

---

## Security

**Safe YAML Parsing**: All parsing uses the `yaml` package default safe schema. No custom tags are accepted. The `safeParseYaml` wrapper enforces this consistently.

**Path Confinement**: All paths from YAML documents are validated. Paths containing `..` segments are rejected. Flow file references are additionally confined to the `flows/` directory. Symlinks are resolved and re-checked against the project root.

**Input Size Limits**: Files exceeding 1MB are rejected before parsing. Architecture files with more than 500 modules and flow indexes with more than 100 flows are rejected after parsing.

**Glob Pattern Safety**: Module path glob patterns longer than 200 characters are rejected to prevent regular expression denial-of-service.

**Mermaid Injection Prevention**: Module and step labels are sanitized before embedding in Mermaid syntax. Double quotes, newlines, comment markers, and structural keywords are neutralized.

---

## Templates and Sync

Empty templates are distributed to consumer projects via the metaclaude registry sync system.

| Template                                      | Sync Policy     |
| --------------------------------------------- | --------------- |
| `templates/structured-docs/architecture.yaml` | never-overwrite |
| `templates/structured-docs/flows/index.yaml`  | never-overwrite |
| `templates/structured-docs/glossary.yaml`     | never-overwrite |
| `templates/structured-docs/data-models.yaml`  | never-overwrite |
| `templates/structured-docs/states/index.yaml` | never-overwrite |
| `templates/structured-docs/security.yaml`     | never-sync      |
| `templates/structured-docs/deployment.yaml`   | never-overwrite |

Templates use `never-overwrite` so project-specific content is preserved after initial sync. Scripts and schema sync as regular overwritable artifacts.

Each template includes a header comment directing the user to run `docs-scaffold.mjs`.

---

## Common Workflows

### Adding a New Module

1. Edit `architecture.yaml` and add a new entry under `modules`
2. Run `node .claude/scripts/docs-validate.mjs` to check for issues
3. Run `node .claude/scripts/docs-generate.mjs` to regenerate the architecture diagram

### Adding a New Flow

1. Add an entry to `flows/index.yaml` with name, file, and description
2. Create the flow file at `flows/<name>.yaml` with schema_version, name, description, and steps
3. Ensure all step `module` values exist in `architecture.yaml`
4. Run `node .claude/scripts/docs-validate.mjs` to verify cross-references
5. Run `node .claude/scripts/docs-generate.mjs` to generate the flow diagram

### Resolving Stale Diagrams

When the validator warns about stale diagrams (source hash mismatch):

```bash
node .claude/scripts/docs-generate.mjs
```

This regenerates all `.mmd` files with fresh source hashes. Any manual edits to `.mmd` files are overwritten.

### Checking Cross-Reference Integrity

```bash
node .claude/scripts/docs-validate.mjs
```

The validator reports:

- Flow steps referencing modules not in `architecture.yaml` (error)
- Glossary `see_also` referencing nonexistent terms (warning)
- Flow index referencing missing flow files (error)
- Circular module dependencies (informational note, not an error)
- Module path globs matching zero files (warning)
- Docs modules not found in traces (warning, when trace data available)
- Traced modules not referenced in docs (informational note)

### Checking Trace-Docs Sync

```bash
node .claude/scripts/trace-docs-sync.mjs
```

Produces a report listing:

- New exports in traces not documented in architecture.yaml
- Dependencies that differ between traces and docs
- Modules present in only one system (traces or docs)

---

## Troubleshooting

### "architecture.yaml already has content"

The scaffolder refuses to overwrite existing content. Edit the file directly, or delete it and re-run `docs-scaffold.mjs`.

### "File exceeds 1MB limit"

Split large documentation files into smaller units. Architecture files support up to 500 modules; flow indexes support up to 100 flows.

### "Unknown schema_version"

Your file has a `schema_version` higher than the validator recognizes. Update your scripts to the latest version, or set `schema_version: 1`.

### "Path confinement violation"

A path in your YAML file contains `..` segments or resolves outside the project root. Use relative paths without parent directory traversal.

### Hook blocks an edit unexpectedly

Check the stderr output for the specific validation error. Fix the issue in your YAML file, then retry the edit. If the error is a false positive, the hook uses exit 0 for warnings (non-blocking) and exit 2 only for true schema violations or parse errors.

---

## See Also

- [Trace System](TRACES.md) -- Trace generation, querying, and analysis engine
- [Hooks System](HOOKS.md) -- PostToolUse hook architecture and configuration
- [Sync System](SYNC-SYSTEM.md) -- Registry sync infrastructure for distributing artifacts
- `.claude/docs/structured/schema.yaml` -- Full schema reference with all field definitions

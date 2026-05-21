---
_source_modules: ['spec-schema-validate', 'spec-schemas']
title: Spec Schema Validation — Ajv Delegation
last_reviewed: 2026-04-19
---

# Spec Schema Validation — Ajv Delegation

Validator architecture and operational behaviour for `spec-schema-validate.mjs`. The current implementation delegates schema enforcement to Ajv and validates active spec frontmatter plus `manifest.json` files.

Source: `.claude/scripts/spec-schema-validate.mjs`. Registered as a PostToolUse
hook on `.claude/specs/groups/**/*.md` so active specs are checked on edit while
archived specs stay out of the live hook path. See [HOOKS.md § spec-schema-validate.mjs](./HOOKS.md#spec-schema-validatemjs).

---

## Overview

`spec-schema-validate.mjs` validates active spec frontmatter and manifest.json files against JSON Schemas under `.claude/specs/schema/`:

- `session.schema.json` — Session state.
- `spec-group.schema.json` — SpecGroup `manifest.json` files.
- `contract-registry.schema.json`, `audit-report.schema.json`, `problem-brief.schema.json` — supporting structured docs.

The validator is a thin wrapper around [Ajv](https://ajv.js.org/) (JSON Schema Draft-07). Field-path-qualified diagnostics are preserved via a custom Ajv-error formatter.

---

## Quick Reference

| Task                              | Command                                                       |
| --------------------------------- | ------------------------------------------------------------- |
| Validate a single spec            | `node .claude/scripts/spec-schema-validate.mjs <path>`        |
| Validate every spec under a group | `find .claude/specs/groups/<sg-id> -name "*.md" -exec ... \;` |
| Run the validator test suite      | `npm run test:scripts -- spec-schema-validate`                |

Exit codes: `0` valid, `1` invalid.

---

## Ajv Delegation (v2.0)

The prior implementation was a ~350-line hand-rolled validator with no support for `oneOf`, `allOf`, `if/then/else`, `additionalProperties`, `minLength`, `minimum`, or `maximum`. Runtime-connectivity schema fields depend on these keywords for typosquatting defense via `additionalProperties: false`, conditional rationale requirements via `if/then`, `security_surface` shape via `oneOf`, and budget cap enforcement via `maximum`.

The validator now delegates to Ajv 8.x. A single `Ajv` instance is cached module-level; per-schema validators are compiled on demand and reused across invocations within a process.

### Ajv Configuration

```js
new Ajv({
  allErrors: true, // collect all errors, not just the first
  strict: 'log', // surface schema-author typos as warnings
  allowUnionTypes: true, // permit union type arrays in schemas
  verbose: true, // include offending data in error object
});
addFormats(instance); // date-time, uri, etc.
```

`strict: 'log'` is deliberate: `true` would throw on any unknown keyword, making schema development painful; `false` would silently swallow typos. Logging surfaces author mistakes without failing the hook.

### Error Formatting

Ajv errors are converted to human-readable diagnostics via `formatAjvError()`. The formatter preserves the **field-path + expected-value substring shape** that the test suite has historically asserted against, so assertions such as `expect(stderr).toContain("security_surface: value 'csrfs' is not in enum")` remain stable.

Redundant errors are filtered: Ajv emits both the outer `oneOf` failure AND each branch's individual error; the formatter prefers branch-level errors since they identify the offending field. See `filterAjvErrors()` in source.

### YAML Parsing

Frontmatter parsing uses the `yaml` package (already a project dep at v2.8.2+) instead of the prior hand-rolled regex parser. Library parse handles inline arrays (`security_surface: [auth, cors]`), literal `null`, boolean literals, nested objects, and multi-line structures that the regex parser could not round-trip reliably.

---

## Section-Validation Scoping

The validator enforces required markdown sections for active task specs. Section validation runs **only** on files whose resolved absolute path contains `.claude/specs/`.

### Scope Guard

```js
const resolvedPath = resolve(filePath);
if (resolvedPath.includes('.claude/specs/')) {
  const sectionErrors = validateMarkdownSections(content, specType);
  errors.push(...sectionErrors);
}
```

`path.resolve()` is used deliberately so relative-path or symlink-based evasion (e.g., `../evil/.claude/specs/foo.md` resolving outside the specs directory) is rejected. This aligns with the `isUnderSpecsDirectory` convention in `spec-validate.mjs`.

### Why

Helper-driven temp-file fixture tests write spec files to `/var/folders/.../*/spec.md`. Without the guard, those fixtures would be forced to carry full section scaffolding even though the test is exercising frontmatter/schema validation (an orthogonal concern). The guard narrows section validation to the canonical specs directory; ad-hoc CLI invocations on scratch files still receive frontmatter validation but not section enforcement.

**Trade-off**: CLI users running the validator against spec-shaped files outside `.claude/specs/` no longer see section-structure errors — they still receive full frontmatter/schema validation.

---

## Spec Type Resolution

`determineSpecType(filePath, frontmatter)` resolves the target schema using three signals in priority order:

1. **Filename** — `manifest.json` → `spec-group`.
2. **Frontmatter hints** — active task-spec fields and supported manifest fields.

If no signal resolves, the validator emits a warning and exits 0 (no blocking; the hook surface is advisory for non-spec files).

---

## Markdown-Body Exclusion

JSON Schemas declare some sections as `required` even though those sections belong in the markdown body, not the frontmatter. When validating frontmatter-only, the validator strips body-only required fields before compiling.

```js
const MARKDOWN_BODY_ONLY_REQUIRED = new Set([
  'description',
  'acceptance_criteria',
]);

function buildFrontmatterSchema(schema, specType) {
  if (specType === 'spec-group') return schema; // JSON manifest, no body
  if (!schema.required) return schema;
  const filteredRequired = schema.required.filter(
    (f) => !MARKDOWN_BODY_ONLY_REQUIRED.has(f),
  );
  return { ...schema, required: filteredRequired };
}
```

Body sections are enforced separately by `validateMarkdownSections()` (see Section-Validation Scoping above).

---

## FRONTMATTER_FIELDS Whitelist Removal

The prior validator carried a `FRONTMATTER_FIELDS` allow-list: properties not in the list were silently skipped at validate time. Any schema additions without a corresponding whitelist extension became no-ops. The Ajv refactor validates the whole frontmatter object against the schema end-to-end, so the whitelist is no longer needed and has been removed.

If a field appears in frontmatter that is not declared in the schema, the Ajv compiler enforces `additionalProperties: false` at the top level and rejects it. The "silent skip" failure mode is eliminated.

---

## Relationship to Sibling Validators

| Script                     | Role                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `spec-schema-validate.mjs` | JSON Schema validation of frontmatter + manifest.json. Blocks on schema violations.                            |
| `spec-validate.mjs`        | Markdown structure + e2e opt-out consistency + env-dependent AC advisory. Blocks on structure; advises on env. |
| `contract-validate.mjs`    | Explicit checkpoint validation for contract blocks (wire-protocol, types, symbols) inside spec markdown. |
| `validate-manifest.mjs`    | Manifest shape-lint + canonical-field enforcement. Authoritative CI blocker (PostToolUse hook is advisory).    |

The live edit hooks run `spec-schema-validate.mjs`, `spec-validate.mjs`, and
manifest drift checks for active spec groups. Archived specs are validated by
explicit phase/ad-hoc checks when touched, not by default live edit hooks.
`contract-validate.mjs` is retained as an explicit checkpoint because it
maintains escalation state.

---

## Error Diagnostics

Diagnostic format is field-path-qualified for machine grep-ability.

| Keyword                  | Example                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `enum`                   | `runtime_env.liveness: value 'L4' is not in enum [L1, L2, L3]`             |
| `type`                   | `crosses_boundary: expected type boolean, got string`                      |
| `maximum`                | `runtime_connectivity_budget_ms: 60001 exceeds maximum 60000`              |
| `minLength`              | `crosses_boundary_rationale: string length below minimum 1`                |
| `required` (conditional) | `pure_compute_entry_points: required field is missing`                     |
| `additionalProperties`   | `(root): unknown property 'crosses_bounday' (additionalProperties: false)` |
| `minItems`               | `pure_compute_entry_points: array must have at least 1 items`              |

---

## Testing

Tests live at `.claude/scripts/__tests__/`:

- `ajv-validator.test.mjs` — Ajv integration and formatter behaviour.
- `frontmatter-fields.test.mjs` — Per-field positive/negative cases for each new frontmatter field.
- `e2e-skip-rationale-widened.test.mjs` — Enum widening regression + new `pure-compute` acceptance.
- `integration-contracts.test.mjs` — Composite runtime-field fixtures and cross-schema consistency.

Runner: vitest via `npm run test:scripts`. Config: `.claude/scripts/vitest.config.mjs`.

---

## Cross-References

- Field-by-field reference: [SPEC-FRONTMATTER.md](./SPEC-FRONTMATTER.md).
- Hook registration: [HOOKS.md § spec-schema-validate.mjs](./HOOKS.md#spec-schema-validatemjs).
- Manifest validator (sibling): [MANIFEST-MIGRATION.md](./MANIFEST-MIGRATION.md).
- Source schemas: `.claude/specs/schema/*.schema.json`.

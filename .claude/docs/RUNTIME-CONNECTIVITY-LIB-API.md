---
_source_modules: ['e2e-test-writer-lib']
title: e2e-test-writer Library API Reference
last_reviewed: 2026-04-21
---

# e2e-test-writer Library API Reference

API reference for `.claude/scripts/lib/e2e-test-writer/` — the pure-function library that reifies the runtime-connectivity authoring contract. The `e2e-test-writer` agent invokes these helpers deterministically; unit and contract tests import the same surface.

All modules are ES-module JavaScript (`.mjs`) with JSDoc type hints. Parses under TypeScript language service with `--allowJs --checkJs`. No TypeScript runtime loader required.

Barrel entry: [`.claude/scripts/lib/e2e-test-writer/index.mjs`](../scripts/lib/e2e-test-writer/index.mjs).

## Module Surface

| Module                | Purpose                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `archetype-selection` | Priority-ordered archetype selection heuristic.                       |
| `substitution`        | Placeholder grammar, substitution engine, fail-loud unresolved check. |
| `scaffold-tier`       | L1/L2/L3 provisioning block resolution.                               |
| `host-discovery`      | IPv4/IPv6 `discoverHost()` snippet resolution.                        |
| `template-loader`     | File-path template loader (archetype → `.template.mjs`).              |
| `emit`                | End-to-end emission pipeline composing all of the above.              |

## emit

### `emitRuntimeConnectivityTest(input)`

End-to-end pipeline. Composes scope gate → archetype selection → scaffold tier + host discovery → template load → substitution. Returns the emission artifact. Does NOT write to disk.

**Signature**:

```javascript
/**
 * @param {EmitInput} input
 * @returns {EmitResult}
 */
function emitRuntimeConnectivityTest(input);
```

**`EmitInput`**:

| Field             | Type                             | Required | Description                                                                     |
| ----------------- | -------------------------------- | -------- | ------------------------------------------------------------------------------- |
| `specId`          | `string`                         | Yes      | `manifest.id`. Must match `/^[a-z0-9-]+$/`.                                     |
| `frontmatter`     | `Record<string, unknown>`        | Yes      | Parsed spec frontmatter.                                                        |
| `contracts`       | `Array<Record<string, unknown>>` | Yes      | Contract definitions from the spec.                                             |
| `archetypeValues` | `Record<string, string>`         | No       | Archetype-specific placeholder substitutions.                                   |
| `projectRoot`     | `string`                         | No       | Absolute project root for template path resolution.                             |
| `templateDir`     | `string`                         | No       | Override template directory (default `.claude/templates/runtime-connectivity`). |

**`EmitResult`**:

| Field          | Type                                                          | Present when                             |
| -------------- | ------------------------------------------------------------- | ---------------------------------------- |
| `status`       | `'success' \| 'skipped' \| 'failed'`                          | Always.                                  |
| `archetype`    | `string`                                                      | `success` or `failed` (after selection). |
| `emissionPath` | `string` (`tests/e2e/<specId>.runtime-connectivity.spec.mjs`) | `success` only.                          |
| `content`      | `string` (substituted test file contents)                     | `success` only.                          |
| `reason`       | `string`                                                      | `skipped` or `failed`.                   |
| `diagnostics`  | `string[]`                                                    | `failed`.                                |

**Errors**:

| Error           | Code                    | Cause                             |
| --------------- | ----------------------- | --------------------------------- |
| `EmissionError` | `E_BAD_INPUT`           | `input` is not an object.         |
| `EmissionError` | `E_BAD_SPEC_ID`         | `specId` missing or not a string. |
| `EmissionError` | `E_BAD_SPEC_ID_CHARSET` | `specId` fails `/^[a-z0-9-]+$/`.  |

Scope-gate failures (`crosses_boundary: false`, `e2e_skip: true`) return `status: 'skipped'` — not an error.

Archetype selection failures (`ambiguous`, `no-match`) and unresolved-placeholder failures return `status: 'failed'` with diagnostics — not an error. Inner errors from `resolveProvisioningBlock`, `resolveHostDiscovery`, or `loadTemplate` throw; caller handles.

**Example**:

```javascript
import { emitRuntimeConnectivityTest } from '../scripts/lib/e2e-test-writer/index.mjs';

const result = emitRuntimeConnectivityTest({
  specId: 'sg-my-feature',
  frontmatter: {
    crosses_boundary: true,
    runtime_env: { liveness: 'L1' },
  },
  contracts: [{ _template: 'rest-api', path: '/api/v1/login' }],
  archetypeValues: {
    HTTP_METHOD: 'const HTTP_METHOD = "POST";',
    HTTP_PATH: 'const HTTP_PATH = "/api/v1/login";',
    REQUEST_SHAPE: 'const REQUEST_SHAPE = { user: "x", pass: "y" };',
    RESPONSE_ASSERTION: 'expect(parsed).toMatchObject({ ok: true });',
  },
});

if (result.status === 'success') {
  // result.emissionPath === 'tests/e2e/sg-my-feature.runtime-connectivity.spec.mjs'
  // result.content is the substituted .mjs file contents
}
```

### `EmissionError`

Error class for emit-time failures.

| Field     | Type     | Description                              |
| --------- | -------- | ---------------------------------------- |
| `name`    | `string` | `'EmissionError'`.                       |
| `code`    | `string` | Machine-readable code (see table above). |
| `context` | `object` | Additional context.                      |

## archetype-selection

### `selectArchetype(spec)`

Runs the priority-ordered selection heuristic over contract definitions. Pure function.

**Signature**:

```javascript
/**
 * @param {SpecInput} spec
 * @returns {{ status: 'ok', archetype: Archetype }
 *   | { status: 'ambiguous', archetype: null, matched: Archetype[] }
 *   | typeof ARCHETYPE_SELECTION_NO_MATCH}
 */
function selectArchetype(spec);
```

**`SpecInput`**:

| Field         | Type                      | Required |
| ------------- | ------------------------- | -------- |
| `id`          | `string`                  | Yes      |
| `frontmatter` | `Record<string, unknown>` | No       |
| `contracts`   | `ContractDefinition[]`    | Yes      |

**`Archetype`**: `'http-smoke' | 'ws-event' | 'sse-stream' | 'cli-writes-file' | 'ipc-ping-pong'`.

**Return values**:

| Status        | When                                 | Shape                                                                  |
| ------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| `'ok'`        | Exactly one paradigm group matched.  | `{ status, archetype }`                                                |
| `'ambiguous'` | Two or more paradigm groups matched. | `{ status, archetype: null, matched: Archetype[] }`                    |
| `'no-match'`  | No priority row matched.             | `ARCHETYPE_SELECTION_NO_MATCH` (frozen `{ status, archetype: null }`). |

Within the event paradigm, `sse-stream` wins over `ws-event` per AC2.5.

### Exports

| Symbol                          | Type                | Description                                  |
| ------------------------------- | ------------------- | -------------------------------------------- |
| `ARCHETYPES`                    | `readonly string[]` | Frozen canonical archetype enum (5 entries). |
| `ARCHETYPE_SELECTION_AMBIGUOUS` | frozen object       | Sentinel for EC-A1.                          |
| `ARCHETYPE_SELECTION_NO_MATCH`  | frozen object       | Sentinel for EC-A6.                          |
| `selectArchetype`               | function            | Heuristic runner.                            |

## substitution

### `buildSubstitutionMap(input)`

Construct the canonical substitution map keyed by placeholder identifier (no braces).

**Signature**:

```javascript
/**
 * @param {BuildSubstitutionMapInput} input
 * @returns {Record<string, string>}
 */
function buildSubstitutionMap(input);
```

**`BuildSubstitutionMapInput`**:

| Field               | Type                                       | Required | Default |
| ------------------- | ------------------------------------------ | -------- | ------- |
| `specId`            | `string`                                   | Yes      |         |
| `livenessTier`      | `'L1' \| 'L2' \| 'L3'`                     | No       | `'L1'`  |
| `timeoutMs`         | `number`                                   | No       | `30000` |
| `provisioningBlock` | `string` (from `resolveProvisioningBlock`) | Yes      |         |
| `hostDiscovery`     | `string` (from `resolveHostDiscovery`)     | Yes      |         |
| `archetype`         | `Archetype`                                | Yes      |         |
| `archetypeValues`   | `Record<string, string>`                   | No       | `{}`    |

Throws `Error` when `archetype` is unknown.

### `substitute(template, substitutionMap, archetype)`

Apply the substitution map to a template string. Single-pass `String.prototype.replaceAll` per placeholder.

**Signature**:

```javascript
/**
 * @param {string} template
 * @param {Record<string, string>} substitutionMap
 * @param {string} archetype
 * @returns {string}
 * @throws {UnresolvedPlaceholderError}
 */
function substitute(template, substitutionMap, archetype);
```

**Behavior**:

1. For each `[id, value]` in `substitutionMap`, replace all occurrences of `// {{<id>}}` with `value`. The `// ` prefix is part of the marker and is consumed (TECH-003 — omitting the prefix leaves declarations commented out).
2. After the pass, scan the result for any remaining `{{[A-Z][A-Z0-9_]*}}` markers. If any remain, throw `UnresolvedPlaceholderError` with the unique marker identifiers.

**Errors**:

| Error                        | Code                       | Cause                                       |
| ---------------------------- | -------------------------- | ------------------------------------------- |
| `UnresolvedPlaceholderError` | `E_UNRESOLVED_PLACEHOLDER` | `{{…}}` marker(s) remain post-substitution. |

### `UnresolvedPlaceholderError`

| Field       | Type       | Description                           |
| ----------- | ---------- | ------------------------------------- |
| `name`      | `string`   | `'UnresolvedPlaceholderError'`.       |
| `code`      | `string`   | `'E_UNRESOLVED_PLACEHOLDER'`.         |
| `markers`   | `string[]` | Unresolved identifier(s) (no braces). |
| `archetype` | `string`   | Archetype name for context.           |

### Exports

| Symbol                            | Type                                   | Description                                         |
| --------------------------------- | -------------------------------------- | --------------------------------------------------- |
| `PLACEHOLDER_GRAMMAR`             | `RegExp`                               | `/\{\{([A-Z][A-Z0-9_]*)\}\}/g` — global, capturing. |
| `CANONICAL_PLACEHOLDERS`          | `readonly string[]`                    | 6 canonical placeholder identifiers (frozen).       |
| `ARCHETYPE_SPECIFIC_PLACEHOLDERS` | `Record<Archetype, readonly string[]>` | Per-archetype placeholder identifiers (frozen).     |
| `buildSubstitutionMap`            | function                               | Map builder.                                        |
| `substitute`                      | function                               | Substitution engine.                                |
| `UnresolvedPlaceholderError`      | class                                  | Fail-loud error.                                    |

## scaffold-tier

### `resolveProvisioningBlock(tier, specId)`

Map `runtime_env.liveness` to the substituted `{{PROVISIONING_BLOCK}}` snippet.

**Signature**:

```javascript
/**
 * @param {unknown} tier
 * @param {string} specId
 * @returns {string}
 * @throws {InvalidLivenessError}
 */
function resolveProvisioningBlock(tier, specId);
```

**Behavior**:

- `undefined` or `null` → returns L1 snippet (default).
- `'L1'` → `// no external provisioning required (L1 in-process)`.
- `'L2'` → `beforeAll`/`afterAll` `execSync` block referencing `tests/e2e/provisioning/<specId>.sh`.
- `'L3'` → `beforeAll`/`afterAll` `DockerComposeEnvironment` block referencing `tests/e2e/containers/<specId>.compose.yml`.
- Other value → throws `InvalidLivenessError` (defense-in-depth; schema validates upstream).

### `InvalidLivenessError`

| Field  | Type      | Description               |
| ------ | --------- | ------------------------- |
| `name` | `string`  | `'InvalidLivenessError'`. |
| `code` | `string`  | `'E_INVALID_LIVENESS'`.   |
| `tier` | `unknown` | The rejected value.       |

### Exports

| Symbol                     | Type                | Description                    |
| -------------------------- | ------------------- | ------------------------------ |
| `LIVENESS_TIERS`           | `readonly string[]` | `['L1', 'L2', 'L3']` (frozen). |
| `resolveProvisioningBlock` | function            | Tier → snippet resolver.       |
| `InvalidLivenessError`     | class               | Validation error.              |

## host-discovery

### `resolveHostDiscovery(preferIpv6)`

Map `runtime_env.prefer_ipv6` to the substituted `{{HOST_DISCOVERY}}` snippet. Both branches emit an ESM `import os from 'node:os'` (TECH-001).

**Signature**:

```javascript
/**
 * @param {unknown} preferIpv6
 * @returns {string}
 * @throws {InvalidPreferIpv6Error}
 */
function resolveHostDiscovery(preferIpv6);
```

**Behavior**:

- `undefined`, `null`, or `false` → IPv4-first snippet (default). Fallback: `127.0.0.1`.
- `true` → IPv6-first snippet with link-local (`fe80::/…`) exclusion. Fallback: `::1`.
- Other value → throws `InvalidPreferIpv6Error`.

Both branches share the interface-name exclusion regex: `/^(docker0|br-|vEthernet|tailscale0|utun|tun\d|ppp)/`.

### `InvalidPreferIpv6Error`

| Field   | Type      | Description                 |
| ------- | --------- | --------------------------- |
| `name`  | `string`  | `'InvalidPreferIpv6Error'`. |
| `code`  | `string`  | `'E_INVALID_PREFER_IPV6'`.  |
| `value` | `unknown` | The rejected value.         |

### Exports

| Symbol                   | Type     | Description              |
| ------------------------ | -------- | ------------------------ |
| `resolveHostDiscovery`   | function | Flag → snippet resolver. |
| `InvalidPreferIpv6Error` | class    | Validation error.        |

## template-loader

### `loadTemplate(archetype, opts)`

Load the raw template string for an archetype by file path (D-036: templates are NOT inlined in the agent prompt).

**Signature**:

```javascript
/**
 * @param {string} archetype
 * @param {{ projectRoot?: string, templateDir?: string }} [opts]
 * @returns {string}
 * @throws {TemplateNotFoundError}
 */
function loadTemplate(archetype, opts);
```

**Resolution**:

- `archetype` validated against `ARCHETYPES`. Unknown value throws generic `Error`.
- Path: `<projectRoot>/<templateDir>/<archetype>.template.mjs`.
- Defaults: `projectRoot = process.cwd()`, `templateDir = '.claude/templates/runtime-connectivity'`.
- File read UTF-8 via `readFileSync`.
- Missing file throws `TemplateNotFoundError`.

### `templatePathFor(archetype, opts)`

Resolve the absolute template path without reading. Same resolution rules.

### `TemplateNotFoundError`

| Field       | Type     | Description                     |
| ----------- | -------- | ------------------------------- |
| `name`      | `string` | `'TemplateNotFoundError'`.      |
| `code`      | `string` | `'E_TEMPLATE_NOT_FOUND'`.       |
| `archetype` | `string` | Archetype label.                |
| `path`      | `string` | Absolute path that was missing. |

### Exports

| Symbol                  | Type     | Description                                 |
| ----------------------- | -------- | ------------------------------------------- |
| `DEFAULT_TEMPLATE_DIR`  | `string` | `'.claude/templates/runtime-connectivity'`. |
| `loadTemplate`          | function | Read template contents.                     |
| `templatePathFor`       | function | Resolve absolute path (no I/O).             |
| `TemplateNotFoundError` | class    | Missing file error.                         |

## Error Codes Summary

| Code                       | Class                        | Where thrown                  |
| -------------------------- | ---------------------------- | ----------------------------- |
| `E_BAD_INPUT`              | `EmissionError`              | `emitRuntimeConnectivityTest` |
| `E_BAD_SPEC_ID`            | `EmissionError`              | `emitRuntimeConnectivityTest` |
| `E_BAD_SPEC_ID_CHARSET`    | `EmissionError`              | `emitRuntimeConnectivityTest` |
| `E_UNRESOLVED_PLACEHOLDER` | `UnresolvedPlaceholderError` | `substitute`                  |
| `E_INVALID_LIVENESS`       | `InvalidLivenessError`       | `resolveProvisioningBlock`    |
| `E_INVALID_PREFER_IPV6`    | `InvalidPreferIpv6Error`     | `resolveHostDiscovery`        |
| `E_TEMPLATE_NOT_FOUND`     | `TemplateNotFoundError`      | `loadTemplate`                |

## Regression Coverage

The production barrel (`index.mjs`) is the tested import surface. `prod-lib-smoke.test.mjs` imports it directly, emits an `http-smoke` fixture, parses the output as ESM, and dynamically imports stubbed output to catch placeholder-substitution or ESM drift.

## Import Example

```javascript
import {
  emitRuntimeConnectivityTest,
  EmissionError,
  ARCHETYPES,
  selectArchetype,
  buildSubstitutionMap,
  substitute,
  UnresolvedPlaceholderError,
  LIVENESS_TIERS,
  resolveProvisioningBlock,
  resolveHostDiscovery,
  loadTemplate,
} from '../scripts/lib/e2e-test-writer/index.mjs';
```

## See Also

- [RUNTIME-CONNECTIVITY-AUTHORING.md](RUNTIME-CONNECTIVITY-AUTHORING.md) — user-facing guide.
- [RUNTIME-CONNECTIVITY-ARCHETYPES.md](RUNTIME-CONNECTIVITY-ARCHETYPES.md) — archetype reference with per-archetype placeholder sets.
- Library sources: `.claude/scripts/lib/e2e-test-writer/*.mjs`.

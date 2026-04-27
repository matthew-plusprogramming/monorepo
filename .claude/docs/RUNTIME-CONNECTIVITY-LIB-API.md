---
_source_modules: ['e2e-test-writer-lib']
title: e2e-test-writer Library API Reference
last_reviewed: 2026-04-27
---

# e2e-test-writer Library API Reference

Current API reference for `.claude/scripts/lib/e2e-test-writer/`, the
runtime-connectivity E2E emission library used by the `e2e-test-writer` agent
and its regression tests.

Barrel entry: [`.claude/scripts/lib/e2e-test-writer/index.mjs`](../scripts/lib/e2e-test-writer/index.mjs).
All modules are ESM `.mjs` files with JSDoc types.

## Module Surface

| Module | Responsibility |
| --- | --- |
| `emit` | Composes the emission pipeline and returns a result object. |
| `archetype-selection` | Chooses one runtime-connectivity archetype from spec contracts. |
| `substitution` | Builds placeholder maps and replaces template markers. |
| `scaffold-tier` | Resolves `runtime_env.liveness` to a provisioning snippet. |
| `host-discovery` | Resolves `runtime_env.prefer_ipv6` to a `discoverHost()` snippet. |
| `template-loader` | Resolves and reads archetype template files. |

## Barrel Exports

```javascript
export {
  emitRuntimeConnectivityTest,
  EmissionError,
  ARCHETYPES,
  ARCHETYPE_SELECTION_AMBIGUOUS,
  ARCHETYPE_SELECTION_NO_MATCH,
  selectArchetype,
  CANONICAL_PLACEHOLDERS,
  ARCHETYPE_SPECIFIC_PLACEHOLDERS,
  PLACEHOLDER_GRAMMAR,
  buildSubstitutionMap,
  substitute,
  UnresolvedPlaceholderError,
  LIVENESS_TIERS,
  resolveProvisioningBlock,
  InvalidLivenessError,
  resolveHostDiscovery,
  InvalidPreferIpv6Error,
  DEFAULT_TEMPLATE_DIR,
  loadTemplate,
  templatePathFor,
  TemplateNotFoundError,
};
```

## Emission Pipeline

`emitRuntimeConnectivityTest(input)` is the top-level pure function. It does not
write files.

Input shape:

| Field | Type | Notes |
| --- | --- | --- |
| `specId` | `string` | Required. Uses `/^[a-z0-9-]+$/`. |
| `frontmatter` | `Record<string, unknown>` | Required parsed spec frontmatter. |
| `contracts` | `Array<Record<string, unknown>>` | Required contract definitions. |
| `archetypeValues` | `Record<string, string>` | Optional archetype placeholder replacements. |
| `projectRoot` | `string` | Optional template resolution root. |
| `templateDir` | `string` | Optional template directory override. |

Result shape:

| Status | Meaning |
| --- | --- |
| `success` | Returns `archetype`, `emissionPath`, and substituted `content`. |
| `skipped` | Scope gate opted out through `crosses_boundary: false` or `e2e_skip: true`. |
| `failed` | Selection or substitution failed; returns `reason` and `diagnostics`. |

Pipeline order:

1. Validate `input` and `specId`.
2. Return `skipped` for explicit scope opt-outs.
3. Run `selectArchetype({ id, frontmatter, contracts })`.
4. Resolve provisioning from `runtime_env.liveness`.
5. Resolve host discovery from `runtime_env.prefer_ipv6`.
6. Load `.claude/templates/runtime-connectivity/<archetype>.template.mjs`.
7. Build substitutions and replace template markers.
8. Return `tests/e2e/<specId>.runtime-connectivity.spec.mjs` plus content.

Thrown emit validation errors:

| Code | Cause |
| --- | --- |
| `E_BAD_INPUT` | `input` is not an object. |
| `E_BAD_SPEC_ID` | `specId` is absent or not a string. |
| `E_BAD_SPEC_ID_CHARSET` | `specId` contains unsupported characters. |

`EmissionError` exposes `name`, `code`, and `context`.

## Archetype Selection

`selectArchetype(spec)` is pure and returns one of:

| Status | Shape |
| --- | --- |
| `ok` | `{ status, archetype }` |
| `ambiguous` | `{ status, archetype: null, matched }` |
| `no-match` | Frozen `{ status, archetype: null }` sentinel. |

Canonical archetypes:

- `http-smoke`
- `ws-event`
- `sse-stream`
- `cli-writes-file`
- `ipc-ping-pong`

Selection groups contracts by paradigm. Cross-paradigm matches are ambiguous.
Within event contracts, SSE wins over generic websocket/event matches.

Current heuristics:

| Archetype | Match signal |
| --- | --- |
| `http-smoke` | Contract `_template: rest-api`. |
| `sse-stream` | Event contract with SSE channel or `Accept: text/event-stream`. |
| `ws-event` | Event contract with websocket channel/protocol, or generic event contract. |
| `cli-writes-file` | Behavioral contract mentioning file write/create/output behavior. |
| `ipc-ping-pong` | Behavioral contract mentioning IPC, unix socket, named pipe, or ping-pong behavior. |

## Template Substitution

Templates use comment-wrapped markers:

```javascript
// {{PLACEHOLDER_ID}}
```

`PLACEHOLDER_GRAMMAR` matches `{{[A-Z][A-Z0-9_]*}}`.

Canonical placeholders:

- `SPEC_ID`
- `PORT`
- `HOST_DISCOVERY`
- `TIMEOUT_MS`
- `LIVENESS_TIER`
- `PROVISIONING_BLOCK`

`buildSubstitutionMap(input)` adds those canonical replacements and merges
archetype-specific replacements from `archetypeValues`. Defaults:

| Field | Default |
| --- | --- |
| `livenessTier` | `L1` |
| `timeoutMs` | `30000` |
| `archetypeValues` | `{}` |

`substitute(template, substitutionMap, archetype)` replaces each
`// {{ID}}` marker with the mapped value. The `// ` prefix is consumed so
replacement declarations execute instead of staying commented out. After the
pass, remaining markers throw `UnresolvedPlaceholderError`.

`UnresolvedPlaceholderError` exposes `name`,
`code: E_UNRESOLVED_PLACEHOLDER`, `markers`, and `archetype`.

## Provisioning

`resolveProvisioningBlock(tier, specId)` maps `runtime_env.liveness` to the
`PROVISIONING_BLOCK` replacement.

| Tier | Behavior |
| --- | --- |
| absent, `null`, `L1` | In-process placeholder; no external provisioning. |
| `L2` | `beforeAll`/`afterAll` shell hook at `tests/e2e/provisioning/<specId>.sh`. |
| `L3` | `DockerComposeEnvironment` for `tests/e2e/containers/<specId>.compose.yml`. |

Invalid values throw `InvalidLivenessError` with `code: E_INVALID_LIVENESS` and
the rejected `tier`.

`LIVENESS_TIERS` is the frozen enum `['L1', 'L2', 'L3']`.

## Host Discovery

`resolveHostDiscovery(preferIpv6)` maps `runtime_env.prefer_ipv6` to the
`HOST_DISCOVERY` replacement.

| Value | Behavior |
| --- | --- |
| absent, `null`, `false` | IPv4-first discovery; fallback `127.0.0.1`. |
| `true` | IPv6-first discovery; excludes link-local IPv6; fallback `::1`. |

Both branches emit an ESM `import os from 'node:os'`, sort interface names for
stable selection, and exclude common container/VPN interfaces:
`/^(docker0|br-|vEthernet|tailscale0|utun|tun\d|ppp)/`.

Invalid values throw `InvalidPreferIpv6Error` with
`code: E_INVALID_PREFER_IPV6` and the rejected `value`.

## Template Loading

`DEFAULT_TEMPLATE_DIR` is `.claude/templates/runtime-connectivity`.

`templatePathFor(archetype, opts)` validates the archetype and returns:

```text
<projectRoot>/<templateDir>/<archetype>.template.mjs
```

`loadTemplate(archetype, opts)` reads that path as UTF-8. Missing files throw
`TemplateNotFoundError` with `code: E_TEMPLATE_NOT_FOUND`, `archetype`, and
`path`.

## Error Codes

| Code | Class | Source |
| --- | --- | --- |
| `E_BAD_INPUT` | `EmissionError` | `emitRuntimeConnectivityTest` |
| `E_BAD_SPEC_ID` | `EmissionError` | `emitRuntimeConnectivityTest` |
| `E_BAD_SPEC_ID_CHARSET` | `EmissionError` | `emitRuntimeConnectivityTest` |
| `E_UNRESOLVED_PLACEHOLDER` | `UnresolvedPlaceholderError` | `substitute` |
| `E_INVALID_LIVENESS` | `InvalidLivenessError` | `resolveProvisioningBlock` |
| `E_INVALID_PREFER_IPV6` | `InvalidPreferIpv6Error` | `resolveHostDiscovery` |
| `E_TEMPLATE_NOT_FOUND` | `TemplateNotFoundError` | `loadTemplate` |

## Regression Coverage

Focused tests live under `.claude/scripts/__tests__/e2e-test-writer/`.
`prod-lib-smoke.test.mjs` imports the barrel, emits an `http-smoke` fixture,
parses the output as ESM, and dynamically imports stubbed output. Other focused
tests cover archetype selection, template contracts, substitution,
runtime-connectivity sections, scaffold tiers, and black-box isolation.

## See Also

- [RUNTIME-CONNECTIVITY-AUTHORING.md](RUNTIME-CONNECTIVITY-AUTHORING.md)
- [RUNTIME-CONNECTIVITY-ARCHETYPES.md](RUNTIME-CONNECTIVITY-ARCHETYPES.md)
- `.claude/scripts/lib/e2e-test-writer/*.mjs`

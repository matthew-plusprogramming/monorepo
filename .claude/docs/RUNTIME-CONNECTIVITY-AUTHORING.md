---
_source_modules: ['e2e-test-writer-lib']
title: Runtime Connectivity Authoring Pattern
last_reviewed: 2026-04-21
---

# Runtime Connectivity Authoring Pattern

User-guide for spec authors on how the `e2e-test-writer` subagent produces the canonical runtime connectivity smoke test for every in-scope spec. Spec authors do not hand-write these tests; the agent reads spec frontmatter + contracts and emits one test per spec group deterministically.

Authoritative sources:

- Agent prompt: [`.claude/agents/e2e-test-writer.md`](../agents/e2e-test-writer.md) § Runtime Connectivity Smoke Test
- Library API: [RUNTIME-CONNECTIVITY-LIB-API.md](RUNTIME-CONNECTIVITY-LIB-API.md)
- Frontmatter reference: [SPEC-FRONTMATTER.md](SPEC-FRONTMATTER.md)

## What You Get

Every spec with `crosses_boundary: true` (default) and `e2e_skip: false | absent` receives exactly one generated test at:

```
tests/e2e/<manifest.id>.runtime-connectivity.spec.mjs
```

The file is a vitest `.mjs` suite that binds an ephemeral port, discovers a LAN-routable host, exercises the primary event flow (per archetype), and asserts the happy-path response. It participates in completion-verifier Gate 5.

## Scope Gates — When No Test Is Emitted

The agent emits nothing (status `skipped`) in two cases:

| Condition                 | Rationale location           | Effect                                                               |
| ------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `crosses_boundary: false` | `crosses_boundary_rationale` | Spec out of scope for runtime connectivity. Rationale logged.        |
| `e2e_skip: true`          | `e2e_skip_rationale`         | Spec opts out. Rationale enum includes `test-infra`, `pure-compute`. |

Both gates short-circuit before archetype selection. If `e2e_skip_rationale: pure-compute`, the pure-compute static-analysis sub-check runs at Gate 5 (owned by `sg-e2e-pure-compute-check`).

## Archetype Selection (5 Archetypes)

The agent picks exactly one archetype per spec using a deterministic priority-ordered heuristic over contract definitions.

| Archetype         | When to use                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `sse-stream`      | Contract declares SSE channel (`_template: event` + `text/event-stream` channel or Accept header). |
| `ws-event`        | Contract declares WebSocket channel (`_template: event` + `ws://`/`wss://` channel).               |
| `http-smoke`      | Contract declares REST endpoint (`_template: rest-api`).                                           |
| `cli-writes-file` | Contract declares CLI with file-write behavior (`_template: behavioral`, file-write phrase).       |
| `ipc-ping-pong`   | Contract declares IPC channel (`_template: behavioral`, IPC request/response phrase).              |

**Paradigm grouping** (ASM-002): within the event paradigm, `sse-stream` wins over `ws-event`. Across paradigms, multiple matches yield `AMBIGUOUS` and the agent fails loudly. Zero matches yield `NO-MATCH`.

See the [Archetype Reference](RUNTIME-CONNECTIVITY-ARCHETYPES.md) for per-archetype expected spec shape + placeholder requirements.

## Liveness Tiers (L1 / L2 / L3)

The `runtime_env.liveness` frontmatter field determines the `{{PROVISIONING_BLOCK}}` scaffold:

| Tier           | Provisioning block                                                                                              | Author responsibility                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `L1` (default) | `// no external provisioning required (L1 in-process)`                                                          | None. Default.                                              |
| `L2`           | `beforeAll`/`afterAll` invoking `bash tests/e2e/provisioning/<manifest.id>.sh [--teardown]`                     | Author ships the shell script. Both branches required.      |
| `L3`           | `beforeAll`/`afterAll` wrapping `DockerComposeEnvironment('tests/e2e/containers', '<manifest.id>.compose.yml')` | Author ships the compose file. testcontainers dep required. |

Gate 5 (sg-e2e-gate5-enforcement) validates conventional-path file existence at evaluation time; the agent only emits the reference.

### L2 Provisioning Script Contract

Spec authors declaring `runtime_env.liveness: L2` must ship `tests/e2e/provisioning/<manifest.id>.sh` with both branches.

```bash
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--teardown" ]]; then
  # idempotent teardown — safe to run multiple times
  rm -rf /tmp/<manifest.id>/ 2>/dev/null || true
  exit 0
fi
# up / provision
mkdir -p /tmp/<manifest.id>/
```

Requirements:

- **Idempotent `--teardown`**. Safe to run when nothing was provisioned.
- **Write isolation**. MUST NOT write to `.claude/` or repo source files. Permitted: `/tmp/<manifest.id>/`, externally-managed resources, `tests/e2e/` fixtures.
- **Exit codes**. `0` = success; non-zero fails the wrapping `beforeAll`/`afterAll` hook.

## IPv6 Host Discovery

Set `runtime_env.prefer_ipv6: true` to flip the `{{HOST_DISCOVERY}}` snippet from "first non-loopback IPv4" to "first non-loopback IPv6". Both branches share the interface-name exclusion regex (`docker0`, `br-*`, `vEthernet`, `tailscale0`, `utun*`, `tun0-9`, `ppp*`) and stable-sort-by-name ordering per REQ-NFR-013. Only the address family filter and link-local exclusion differ.

If the runtime has no IPv6 interface, the emitted test falls back to `::1` and logs a LAN-binding warning (REQ-NFR-013). Not an authorship error.

## Failure Modes

The agent fails loudly in these cases, emitting no test file:

| Status                   | Condition                                                                     | Resolution                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `ambiguous`              | Two or more paradigm groups matched (e.g., REST + WS).                        | Decompose the spec (DEC-003: one canonical test per spec), or annotate a primary archetype.     |
| `no-match`               | No priority row matched (e.g., `_template: data-model` only).                 | Shape the spec to fit an archetype, opt out via `e2e_skip`, or PRD amendment for 6th archetype. |
| `unresolved-placeholder` | Substitution completed but `{{…}}` markers remain (missing archetype values). | Provide the missing archetype-specific values in the agent's `archetypeValues` map.             |

Diagnostics name the archetype and the unresolved marker(s). No partial file is written.

## Quick Start — Adding a Runtime Connectivity Test

1. Declare the scope in your spec frontmatter:

   ```yaml
   crosses_boundary: true
   runtime_env:
     liveness: L1 # L2 | L3 if external deps required
   ```

2. Shape your contracts so exactly one archetype matches the priority heuristic. Use a REST contract for `http-smoke`, an event contract with a `ws://` channel for `ws-event`, etc.

3. Provide the archetype-specific values in the dispatch (the agent reads them from the spec's contracts). See the [Archetype Reference](RUNTIME-CONNECTIVITY-ARCHETYPES.md) for per-archetype placeholder requirements.

4. Run the e2e-test-writer dispatch. The emitted file lands at `tests/e2e/<manifest.id>.runtime-connectivity.spec.mjs` and runs under the standard vitest config.

## Black-Box Isolation

The agent reads **only** spec files, contracts, templates, and fixtures. It **never** reads implementation source. Enforced at two planes:

- **Plane A** (in-process spy): unit-test regression guard on the agent's authorship logic.
- **Plane B** (external PreToolUse hook `.claude/scripts/e2e-blackbox-enforcement.mjs`): coercive enforcement rail. Reads outside the allowed surface exit 2.

This means the emitted test is a verification of the **contract**, not a mirror of the implementation. If the implementation drifts from the contract, the test fails — which is the intent.

## Troubleshooting

| Symptom                                            | Cause                                                                      | Fix                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `status: skipped (reason: crosses_boundary=false)` | Intentional scope gate.                                                    | Add `crosses_boundary_rationale` and audit the declaration.         |
| `status: failed (reason: ambiguous)`               | Spec contracts span multiple paradigms (e.g., both REST and WS).           | Decompose the spec or annotate a primary archetype in frontmatter.  |
| `status: failed (reason: no-match)`                | No contract matches the priority heuristic.                                | Shape contracts to fit an archetype or opt out with `e2e_skip`.     |
| `status: failed (reason: unresolved-placeholder)`  | Archetype-specific values missing (e.g., `HTTP_METHOD` for http-smoke).    | Provide the archetype values in the dispatch / contract definition. |
| `InvalidLivenessError`                             | `runtime_env.liveness` not in {L1, L2, L3}.                                | Schema validation upstream rejects this; fix the spec frontmatter.  |
| `TemplateNotFoundError`                            | `.claude/templates/runtime-connectivity/<archetype>.template.mjs` missing. | Confirm the template file exists; check `DEFAULT_TEMPLATE_DIR`.     |

## See Also

- [RUNTIME-CONNECTIVITY-ARCHETYPES.md](RUNTIME-CONNECTIVITY-ARCHETYPES.md) — archetype reference + per-archetype placeholder sets.
- [RUNTIME-CONNECTIVITY-LIB-API.md](RUNTIME-CONNECTIVITY-LIB-API.md) — API reference for `.claude/scripts/lib/e2e-test-writer/`.
- [SPEC-FRONTMATTER.md](SPEC-FRONTMATTER.md) — frontmatter field reference.
- [.claude/agents/e2e-test-writer.md](../agents/e2e-test-writer.md) — agent prompt of record.

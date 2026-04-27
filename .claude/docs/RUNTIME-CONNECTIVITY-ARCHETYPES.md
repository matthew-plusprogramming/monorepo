---
_source_modules: ['e2e-test-writer-lib']
title: Runtime Connectivity Archetype Reference
last_reviewed: 2026-04-21
---

# Runtime Connectivity Archetype Reference

Reference for the five canonical runtime-connectivity archetypes. Each archetype is a `.template.mjs` file at `.claude/templates/runtime-connectivity/<archetype>.template.mjs` with `// {{PLACEHOLDER}}` comment markers.

**Append-only contract**. Existing placeholders cannot be renamed or removed. New placeholders may be added. New archetypes require a PRD amendment.

## Archetype Selection Heuristic

Priority-ordered; first match wins within the event paradigm; cross-paradigm matches yield `AMBIGUOUS`.

| Priority | Spec signal                                                               | Archetype         |
| -------: | ------------------------------------------------------------------------- | ----------------- |
|        1 | `_template: event` + `text/event-stream` channel OR `Accept` header       | `sse-stream`      |
|        2 | `_template: event` + `ws://` or `wss://` channel                          | `ws-event`        |
|        3 | `_template: rest-api`                                                     | `http-smoke`      |
|        4 | `_template: behavioral` + file-write phrase                               | `cli-writes-file` |
|        5 | `_template: behavioral` + IPC/inter-process/unix-socket/named-pipe phrase | `ipc-ping-pong`   |
|        6 | Multiple paradigm groups matched                                          | `AMBIGUOUS`       |
|        7 | No match                                                                  | `NO-MATCH`        |

Paradigm groups: `event = {sse-stream, ws-event}`, `rest = {http-smoke}`, `cli = {cli-writes-file}`, `ipc = {ipc-ping-pong}`. Cross-paradigm matches (e.g., REST + WS) fail with `AMBIGUOUS`.

## Canonical Placeholder Set

All five archetypes share these six placeholders:

| Placeholder              | Source                                                   | Substituted form                                                                 |
| ------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `{{SPEC_ID}}`            | `manifest.id`                                            | `const SPEC_ID = "<manifest.id>";`                                               |
| `{{PORT}}`               | literal `0` per REQ-NFR-017 (ephemeral `listen(0)` bind) | `const PORT = 0;`                                                                |
| `{{HOST_DISCOVERY}}`     | derived from `runtime_env.prefer_ipv6`                   | `import os from 'node:os'; function discoverHost() { … }` (IPv4 or IPv6 variant) |
| `{{TIMEOUT_MS}}`         | `runtime_connectivity_budget_ms` or default `30000`      | `const TIMEOUT_MS = 30000;`                                                      |
| `{{LIVENESS_TIER}}`      | `runtime_env.liveness` or default `L1`                   | `const LIVENESS_TIER = "L1";`                                                    |
| `{{PROVISIONING_BLOCK}}` | derived from `LIVENESS_TIER`                             | L1 comment / L2 execSync block / L3 DockerComposeEnvironment block               |

**Grammar**: `/// {{([A-Z][A-Z0-9_]*)}}/` — double curly braces, comment-prefixed (the leading `// ` is consumed by substitution), identifier starts with uppercase letter.

## Archetype-Specific Placeholders

Each archetype adds a small set of placeholders that specify the primary event flow.

### http-smoke

**Use for**: REST endpoints. Spec declares a `_template: rest-api` contract.

**Primary event flow**: HTTP request to the bound server → expected response.

| Placeholder              | Purpose                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `{{HTTP_METHOD}}`        | Statement declaring `HTTP_METHOD` (e.g., `const HTTP_METHOD = "POST";`).           |
| `{{HTTP_PATH}}`          | Statement declaring `HTTP_PATH` (e.g., `const HTTP_PATH = "/api/login";`).         |
| `{{REQUEST_SHAPE}}`      | Statement declaring `REQUEST_SHAPE` (request body object or `undefined`).          |
| `{{RESPONSE_ASSERTION}}` | Assertion block over parsed response body (e.g., `expect(parsed.ok).toBe(true);`). |

**Emitted structure**: binds `createServer(...)` on port 0, awaits listen, computes `url = http://${host}:${port}${HTTP_PATH}`, fetches with the declared method/shape, asserts the declared response contract.

### ws-event

**Use for**: WebSocket channels. Spec declares a `_template: event` contract with a `ws://` or `wss://` channel.

**Primary event flow**: WS connect → trigger action → assert expected event received.

| Placeholder                   | Purpose                                                                |
| ----------------------------- | ---------------------------------------------------------------------- |
| `{{WS_PATH}}`                 | Statement declaring the WS path (e.g., `const WS_PATH = "/updates";`). |
| `{{TRIGGER_ACTION}}`          | Async block that triggers the server-side event.                       |
| `{{EXPECTED_EVENT_NAME}}`     | Statement declaring the expected event name.                           |
| `{{EVENT_PAYLOAD_ASSERTION}}` | Assertion block over the received payload.                             |

### sse-stream

**Use for**: Server-sent events. Spec declares a `_template: event` contract with `text/event-stream` channel or Accept header.

**Primary event flow**: SSE connect → trigger → assert expected frame.

| Placeholder                    | Purpose                                                |
| ------------------------------ | ------------------------------------------------------ |
| `{{SSE_PATH}}`                 | Statement declaring the SSE path.                      |
| `{{TRIGGER_ACTION}}`           | Async block triggering the server-side frame emission. |
| `{{EXPECTED_FRAME_ASSERTION}}` | Assertion block over the received SSE frame.           |

### cli-writes-file

**Use for**: CLI commands with file-writing side effects. Spec declares `_template: behavioral` with file-write phrase (`writes? (a |the )?file`, `creates? (a |an |the )?file`, `output file`, `file output`).

**Primary event flow**: CLI invoked → expected file appears at expected path with expected contents.

| Placeholder                           | Purpose                                                           |
| ------------------------------------- | ----------------------------------------------------------------- |
| `{{CLI_INVOCATION}}`                  | Statement declaring the CLI invocation command.                   |
| `{{EXPECTED_OUTPUT_PATH}}`            | Statement declaring the expected file path (under `mkdtempSync`). |
| `{{EXPECTED_FILE_CONTENT_ASSERTION}}` | Assertion block over the read-back file contents.                 |

Uses `mkdtempSync` from `node:os.tmpdir()` to sandbox the output. The named `import { tmpdir } from 'node:os'` coexists with the default `import os` added by `{{HOST_DISCOVERY}}` substitution (different binding names).

### ipc-ping-pong

**Use for**: IPC channels (unix domain sockets, named pipes, inter-process request/response). Spec declares `_template: behavioral` with IPC phrase (`ipc`, `inter-process`, `unix (domain )?socket`, `named pipe`, `ping.?pong`).

**Primary event flow**: IPC send request → assert response.

| Placeholder                       | Purpose                                         |
| --------------------------------- | ----------------------------------------------- |
| `{{IPC_CHANNEL}}`                 | Statement declaring the IPC channel identifier. |
| `{{REQUEST_MESSAGE}}`             | Statement declaring the request payload.        |
| `{{EXPECTED_RESPONSE_ASSERTION}}` | Assertion block over the received response.     |

## Placeholder Substitution Rules

1. **Single-pass `String.prototype.replaceAll` per placeholder**. No nesting, no conditional logic, no secondary substitution.
2. **Marker includes the `// ` prefix**. The raw template parses as valid JavaScript pre-substitution because every marker is a line comment. Substitution consumes the prefix; otherwise the replaced line would stay commented out (TECH-003).
3. **Fail-loud on unresolved markers** (EC-A2). After substitution, the engine scans for remaining `{{…}}` markers. Any match throws `UnresolvedPlaceholderError` naming the marker(s) and archetype. No partial file written.
4. **Values are full JavaScript fragments**. Canonical placeholders substitute to statement-level declarations (`const SPEC_ID = "…";`), scaffold blocks, or function declarations. Archetype-specific placeholders are supplied by the agent as complete statements.

## Scaffold Tier Substitution

The `{{PROVISIONING_BLOCK}}` placeholder expands per `runtime_env.liveness`:

### L1 (default)

```javascript
// no external provisioning required (L1 in-process)
```

### L2 (author-provisioned)

```javascript
import { execSync } from 'node:child_process';
beforeAll(() => {
  execSync('bash tests/e2e/provisioning/<SPEC_ID>.sh', { stdio: 'inherit' });
});
afterAll(() => {
  execSync('bash tests/e2e/provisioning/<SPEC_ID>.sh --teardown', {
    stdio: 'inherit',
  });
});
```

### L3 (testcontainers)

```javascript
import { DockerComposeEnvironment } from 'testcontainers';
/** @type {Awaited<ReturnType<InstanceType<typeof DockerComposeEnvironment>['up']>>} */
let env;
beforeAll(async () => {
  env = await new DockerComposeEnvironment(
    'tests/e2e/containers',
    '<SPEC_ID>.compose.yml',
  ).up();
});
afterAll(async () => {
  await env.down();
});
```

## Host Discovery Substitution

The `{{HOST_DISCOVERY}}` placeholder expands per `runtime_env.prefer_ipv6`. Both variants emit an ESM `import os from 'node:os'` (TECH-001: CJS `require` would `ReferenceError` at runtime in `.mjs`) plus a `discoverHost()` function.

### IPv4 (default, `prefer_ipv6: false | absent`)

```javascript
import os from 'node:os';
/** @returns {string} First non-loopback IPv4 address, or '127.0.0.1' fallback. */
function discoverHost() {
  const EXCLUDE = /^(docker0|br-|vEthernet|tailscale0|utun|tun\d|ppp)/;
  const ifaces = os.networkInterfaces();
  const candidates = Object.keys(ifaces)
    .filter((name) => !EXCLUDE.test(name))
    .sort()
    .flatMap((name) => (ifaces[name] || []).map((addr) => ({ name, ...addr })))
    .filter((entry) => entry.family === 'IPv4' && !entry.internal);
  return candidates[0]?.address || '127.0.0.1';
}
```

### IPv6 (`prefer_ipv6: true`)

Same exclusion regex and stable-sort ordering; filters `family === 'IPv6' && !entry.internal && !LINK_LOCAL.test(entry.address)` where `LINK_LOCAL = /^fe80::/i`. Fallback is `::1`.

## Emission Path

The agent writes to:

```
tests/e2e/<manifest.id>.runtime-connectivity.spec.mjs
```

Filename charset `manifest.id` is validated upstream by `contract-filename-discovery` (owned by `sg-e2e-gate5-enforcement`). Agent does NOT re-validate.

## See Also

- [RUNTIME-CONNECTIVITY-AUTHORING.md](RUNTIME-CONNECTIVITY-AUTHORING.md) — user guide for spec authors.
- [RUNTIME-CONNECTIVITY-LIB-API.md](RUNTIME-CONNECTIVITY-LIB-API.md) — API reference for the pure-function library.
- Template sources: `.claude/templates/runtime-connectivity/*.template.mjs`.
- Agent prompt: [.claude/agents/e2e-test-writer.md](../agents/e2e-test-writer.md) § Runtime Connectivity Smoke Test.

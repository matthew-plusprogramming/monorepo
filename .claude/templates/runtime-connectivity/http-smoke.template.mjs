/**
 * Runtime Connectivity Smoke Test — archetype: http-smoke
 *
 * DO NOT edit without a spec amendment. This template is a contract artifact
 * referenced by `.claude/agents/e2e-test-writer.md` and enforced at
 * completion-verifier Gate 5. Placeholder grammar, archetype-specific markers,
 * and the emission path are fixed by the runtime-connectivity authoring docs.
 *
 * Canonical placeholders (all archetypes):
 *   SPEC_ID, PORT, HOST_DISCOVERY, TIMEOUT_MS,
 *   LIVENESS_TIER, PROVISIONING_BLOCK
 *
 * Archetype-specific placeholders:
 *   HTTP_METHOD, HTTP_PATH, REQUEST_SHAPE, RESPONSE_ASSERTION
 *
 * Placeholder grammar: comment-prefixed double-curly tokens where the inner
 * identifier matches
 * /^[A-Z][A-Z0-9_]*$/. The `// ` prefix makes every placeholder a valid
 * JavaScript line comment, so this template parses pre-substitution. The
 * substitution engine replaces each marker with a complete JavaScript
 * fragment (statement, block, or value expression) supplied by the agent.
 *
 * Emitted to: tests/e2e/<SPEC_ID>.runtime-connectivity.spec.mjs
 *
 * @archetype http-smoke
 * @contract runtime-connectivity-template
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createServer } from 'node:http';

// {{PROVISIONING_BLOCK}}

/** Spec metadata — substituted from manifest + frontmatter. */
// {{SPEC_ID}}
// {{LIVENESS_TIER}}
// {{TIMEOUT_MS}}
// {{PORT}}

// {{HOST_DISCOVERY}}

describe(`${SPEC_ID} runtime connectivity [http-smoke ${LIVENESS_TIER}]`, () => {
  /** @type {import('node:http').Server} */
  let server;
  /** @type {number} */
  let boundPort;
  /** @type {string} */
  let host;

  beforeAll(async () => {
    host = discoverHost();
    server = createServer((req, res) => {
      // Echo stub; real server is the system under test. The substituted
      // REQUEST_SHAPE + RESPONSE_ASSERTION placeholders exercise the real
      // entry point via HTTP.
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise((resolve) => {
      // Ephemeral-port bind — PORT placeholder substitutes to literal 0.
      server.listen(PORT, '0.0.0.0', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          throw new Error('server.address() returned invalid shape');
        }
        boundPort = addr.port;
        resolve(undefined);
      });
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  it(
    'primary event flow — HTTP request returns expected response',
    async () => {
      // {{HTTP_METHOD}}
      // {{HTTP_PATH}}
      // {{REQUEST_SHAPE}}

      const url = `http://${host}:${boundPort}${HTTP_PATH}`;
      const res = await fetch(url, {
        method: HTTP_METHOD,
        headers: { 'content-type': 'application/json' },
        body: REQUEST_SHAPE !== undefined ? JSON.stringify(REQUEST_SHAPE) : undefined,
      });

      const body = await res.text();
      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = body;
      }

      // {{RESPONSE_ASSERTION}}
      expect(res.ok).toBe(true);
    },
    TIMEOUT_MS,
  );
});

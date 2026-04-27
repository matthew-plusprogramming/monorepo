/**
 * Runtime Connectivity Smoke Test — archetype: sse-stream
 *
 * DO NOT edit without a spec amendment. Contract artifact referenced by
 * `.claude/agents/e2e-test-writer.md`. Placeholder grammar + archetype-specific
 * markers are fixed by the runtime-connectivity authoring docs.
 *
 * Canonical placeholders:
 *   SPEC_ID, PORT, HOST_DISCOVERY, TIMEOUT_MS,
 *   LIVENESS_TIER, PROVISIONING_BLOCK
 *
 * Archetype-specific placeholders:
 *   SSE_PATH, TRIGGER_ACTION, EXPECTED_FRAME_ASSERTION
 *
 * Placeholder grammar: comment-prefixed double-curly tokens.
 *
 * Emitted to: tests/e2e/<SPEC_ID>.runtime-connectivity.spec.mjs
 *
 * @archetype sse-stream
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

describe(`${SPEC_ID} runtime connectivity [sse-stream ${LIVENESS_TIER}]`, () => {
  /** @type {import('node:http').Server} */
  let server;
  /** @type {number} */
  let boundPort;
  /** @type {string} */
  let host;

  beforeAll(async () => {
    host = discoverHost();
    server = createServer((req, res) => {
      // SSE stub; real server is the system under test. Substituted
      // TRIGGER_ACTION + EXPECTED_FRAME_ASSERTION placeholders exercise the
      // real stream.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write('data: {"type":"ready"}\n\n');
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
    'primary event flow — SSE trigger yields expected frame',
    async () => {
      // {{SSE_PATH}}
      const url = `http://${host}:${boundPort}${SSE_PATH}`;

      const res = await fetch(url, {
        headers: { Accept: 'text/event-stream' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.body) {
        throw new Error('SSE response body missing');
      }

      // {{TRIGGER_ACTION}}

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      /** @type {string} */
      let buffered = '';
      /** @type {string | null} */
      let firstFrame = null;
      const deadline = Date.now() + TIMEOUT_MS;

      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const boundary = buffered.indexOf('\n\n');
        if (boundary !== -1) {
          firstFrame = buffered.slice(0, boundary);
          break;
        }
      }
      try {
        await reader.cancel();
      } catch {
        /* ignore cancel errors */
      }

      // {{EXPECTED_FRAME_ASSERTION}}
      expect(firstFrame).not.toBeNull();
    },
    TIMEOUT_MS,
  );
});

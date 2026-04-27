/**
 * Runtime Connectivity Smoke Test — archetype: ws-event
 *
 * DO NOT edit without a spec amendment. Contract artifact referenced by
 * `.claude/agents/e2e-test-writer.md`. Placeholder grammar + archetype-specific
 * markers are fixed by the runtime-connectivity authoring docs.
 *
 * Canonical placeholders (all archetypes):
 *   SPEC_ID, PORT, HOST_DISCOVERY, TIMEOUT_MS,
 *   LIVENESS_TIER, PROVISIONING_BLOCK
 *
 * Archetype-specific placeholders:
 *   WS_PATH, TRIGGER_ACTION, EXPECTED_EVENT_NAME,
 *   EVENT_PAYLOAD_ASSERTION
 *
 * Placeholder grammar: comment-prefixed double-curly tokens — template parses
 * pre-substitution. Substitution engine replaces each marker with a complete
 * JavaScript fragment.
 *
 * Emitted to: tests/e2e/<SPEC_ID>.runtime-connectivity.spec.mjs
 *
 * @archetype ws-event
 * @contract runtime-connectivity-template
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

// {{PROVISIONING_BLOCK}}

/** Spec metadata — substituted from manifest + frontmatter. */
// {{SPEC_ID}}
// {{LIVENESS_TIER}}
// {{TIMEOUT_MS}}
// {{PORT}}

// {{HOST_DISCOVERY}}

describe(`${SPEC_ID} runtime connectivity [ws-event ${LIVENESS_TIER}]`, () => {
  /** @type {import('node:http').Server} */
  let httpServer;
  /** @type {WebSocketServer} */
  let wss;
  /** @type {number} */
  let boundPort;
  /** @type {string} */
  let host;

  beforeAll(async () => {
    host = discoverHost();
    httpServer = createServer();
    wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (ws) => {
      ws.on('message', (msg) => {
        // Stub echo; real server is the system under test. Substituted
        // TRIGGER_ACTION + EVENT_PAYLOAD_ASSERTION placeholders exercise the
        // real event flow.
        const parsed = (() => {
          try {
            return JSON.parse(String(msg));
          } catch {
            return { type: 'echo', payload: String(msg) };
          }
        })();
        ws.send(JSON.stringify(parsed));
      });
    });
    await new Promise((resolve) => {
      // Ephemeral-port bind — PORT placeholder substitutes to literal 0.
      httpServer.listen(PORT, '0.0.0.0', () => {
        const addr = httpServer.address();
        if (!addr || typeof addr === 'string') {
          throw new Error('server.address() returned invalid shape');
        }
        boundPort = addr.port;
        resolve(undefined);
      });
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => {
      wss.close(() => httpServer.close(() => resolve(undefined)));
    });
  });

  it(
    'primary event flow — WS trigger yields expected event',
    async () => {
      // {{WS_PATH}}
      const url = `ws://${host}:${boundPort}${WS_PATH}`;
      const client = new WebSocket(url);

      /** @type {Promise<unknown>} */
      const received = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('ws-event timed out')),
          TIMEOUT_MS,
        );
        client.on('message', (msg) => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(String(msg)));
          } catch {
            resolve(String(msg));
          }
        });
        client.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      await new Promise((resolve, reject) => {
        client.once('open', () => resolve(undefined));
        client.once('error', reject);
      });

      // {{TRIGGER_ACTION}}

      const event = await received;

      // {{EXPECTED_EVENT_NAME}}
      // {{EVENT_PAYLOAD_ASSERTION}}
      expect(event).toBeDefined();

      client.close();
    },
    TIMEOUT_MS,
  );
});

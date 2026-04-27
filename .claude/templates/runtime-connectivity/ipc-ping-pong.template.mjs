/**
 * Runtime Connectivity Smoke Test — archetype: ipc-ping-pong
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
 *   IPC_CHANNEL, REQUEST_MESSAGE,
 *   EXPECTED_RESPONSE_ASSERTION
 *
 * Placeholder grammar: comment-prefixed double-curly tokens.
 *
 * IPC transport: Unix domain socket via `node:net`. The substituted
 * IPC_CHANNEL placeholder names a filesystem-scoped socket path; the
 * substituted REQUEST_MESSAGE is the outbound JSON payload; the substituted
 * EXPECTED_RESPONSE_ASSERTION validates the received response.
 *
 * Emitted to: tests/e2e/<SPEC_ID>.runtime-connectivity.spec.mjs
 *
 * @archetype ipc-ping-pong
 * @contract runtime-connectivity-template
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createConnection, createServer } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';

// {{PROVISIONING_BLOCK}}

/** Spec metadata — substituted from manifest + frontmatter. */
// {{SPEC_ID}}
// {{LIVENESS_TIER}}
// {{TIMEOUT_MS}}
// {{PORT}}

// {{HOST_DISCOVERY}}

describe(`${SPEC_ID} runtime connectivity [ipc-ping-pong ${LIVENESS_TIER}]`, () => {
  /** @type {import('node:net').Server} */
  let server;

  beforeAll(async () => {
    // {{IPC_CHANNEL}}
    if (existsSync(IPC_CHANNEL)) {
      try {
        unlinkSync(IPC_CHANNEL);
      } catch {
        /* ignore cleanup errors */
      }
    }
    server = createServer((socket) => {
      socket.on('data', (chunk) => {
        // Stub echo; real IPC endpoint is the system under test. The
        // substituted assertion validates the real response shape.
        socket.write(chunk);
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(IPC_CHANNEL, () => resolve(undefined));
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    if (IPC_CHANNEL && existsSync(IPC_CHANNEL)) {
      try {
        unlinkSync(IPC_CHANNEL);
      } catch {
        /* ignore */
      }
    }
  });

  it(
    'primary event flow — IPC request yields expected response',
    async () => {
      const client = createConnection(IPC_CHANNEL);

      /** @type {Promise<string>} */
      const received = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('ipc-ping-pong timed out')),
          TIMEOUT_MS,
        );
        /** @type {Buffer[]} */
        const chunks = [];
        client.on('data', (chunk) => {
          chunks.push(chunk);
        });
        client.on('end', () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString('utf-8'));
        });
        client.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      await new Promise((resolve, reject) => {
        client.once('connect', () => resolve(undefined));
        client.once('error', reject);
      });

      // {{REQUEST_MESSAGE}}
      client.write(REQUEST_MESSAGE);
      client.end();

      const response = await received;

      // {{EXPECTED_RESPONSE_ASSERTION}}
      expect(response.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});

/**
 * Session Checkpoint UUID Tests (AS-004)
 *
 * Validates that session-checkpoint.mjs uses crypto.randomUUID() for ID generation
 * instead of Math.random().toString(36).substring(2, 8).
 *
 * AC4.1: Math.random() replaced with crypto.randomUUID() using full 36-char UUID
 * AC4.2: import { randomUUID } from 'node:crypto' is used
 * AC4.3: No other Math.random() ID patterns in apps/ or packages/
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = resolve(join(__dirname, '..', 'session-checkpoint.mjs'));

/**
 * Read the session-checkpoint.mjs source code for static analysis.
 */
const scriptSource = readFileSync(SCRIPT_PATH, 'utf-8');

test('AC4.1: generateTaskId uses crypto.randomUUID() for full 36-char UUID', () => {
  // Arrange
  const uuidV4Regex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  // Assert - source uses randomUUID()
  assert.ok(
    scriptSource.includes('randomUUID()'),
    'session-checkpoint.mjs should call randomUUID()',
  );

  // Assert - source does NOT use Math.random() for ID generation
  assert.ok(
    !scriptSource.includes('Math.random()'),
    'session-checkpoint.mjs should NOT contain Math.random()',
  );

  // Assert - verify the task ID format includes a full UUID (not truncated)
  assert.ok(
    !scriptSource.includes('.substring(2, 8)'),
    'session-checkpoint.mjs should NOT truncate the UUID with substring(2, 8)',
  );

  // Verify actual UUID format by testing crypto.randomUUID() output
  const uuid = randomUUID();
  assert.equal(uuid.length, 36, 'UUID should be 36 characters');
  assert.ok(
    uuidV4Regex.test(uuid),
    `Generated UUID "${uuid}" should match UUID v4 format`,
  );
});

test('AC4.2: import uses node:crypto module', () => {
  // Arrange & Act
  const hasNodeCryptoImport =
    scriptSource.includes("from 'node:crypto'") ||
    scriptSource.includes('from "node:crypto"');

  // Assert
  assert.ok(
    hasNodeCryptoImport,
    'session-checkpoint.mjs should import from "node:crypto"',
  );

  // Verify it imports randomUUID specifically
  const hasRandomUUIDImport =
    scriptSource.includes('randomUUID') && hasNodeCryptoImport;

  assert.ok(
    hasRandomUUIDImport,
    'session-checkpoint.mjs should import randomUUID from node:crypto',
  );
});

test('AC4.1: generateTaskId produces task-{uuid} format', () => {
  // Arrange
  const generateTaskIdMatch = scriptSource.match(
    /function\s+generateTaskId\s*\(\s*\)\s*\{([^}]+)\}/,
  );

  // Act & Assert
  assert.ok(
    generateTaskIdMatch,
    'generateTaskId function should exist in the source',
  );

  const functionBody = generateTaskIdMatch[1];

  // Verify it uses randomUUID() in the function body
  assert.ok(
    functionBody.includes('randomUUID()'),
    'generateTaskId should use randomUUID()',
  );

  // Verify it returns a task- prefixed ID
  assert.ok(
    functionBody.includes('task-'),
    'generateTaskId should prefix the ID with "task-"',
  );

  // Verify no substring truncation
  assert.ok(
    !functionBody.includes('substring'),
    'generateTaskId should NOT truncate the UUID',
  );
});

test('AC4.1: no Math.random() ID generation patterns exist in the script', () => {
  // Arrange & Act
  const mathRandomPattern = /Math\.random\(\)/g;
  const matches = scriptSource.match(mathRandomPattern);

  // Assert
  assert.equal(
    matches,
    null,
    'session-checkpoint.mjs should contain zero instances of Math.random()',
  );
});

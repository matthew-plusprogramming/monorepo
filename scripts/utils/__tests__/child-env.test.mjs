/**
 * AS-003: Minimal Environment Allowlist for Child Processes
 *
 * Tests verify that:
 * - buildChildEnv() returns only allowlisted vars (AC3.1)
 * - Default allowlist includes: PATH, HOME, USER, SHELL, TERM, NODE_ENV, LOG_LEVEL (AC3.2)
 * - CLAUDE_* and ANTHROPIC_* vars included via pattern matching (AC3.3)
 * - Additional keys parameter adds specific vars (AC3.4)
 * - Missing additional keys log a warning (AC3.5)
 * - Secrets not in allowlist are excluded (AWS_SECRET_ACCESS_KEY, etc.)
 * - Empty process.env returns only defined defaults
 */
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe, mock } from 'node:test';

/**
 * Helper to save and restore process.env around each test.
 * We manipulate process.env directly for isolation.
 */
const savedEnv = {};

const saveEnv = () => {
  Object.assign(savedEnv, process.env);
};

const restoreEnv = () => {
  // Remove all keys that were added during the test
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  // Restore original values
  for (const [key, value] of Object.entries(savedEnv)) {
    process.env[key] = value;
  }
};

describe('AS-003: buildChildEnv()', () => {
  beforeEach(() => {
    saveEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  test('AC3.1: buildChildEnv() returns only allowlisted vars', async () => {
    // Arrange
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/test';
    process.env.AWS_SECRET_ACCESS_KEY = 'super-secret-key';
    process.env.JWT_SECRET = 'jwt-secret-value';
    process.env.PEPPER = 'pepper-value';
    process.env.WEBHOOK_SECRET = 'webhook-secret';
    process.env.DATABASE_URL = 'postgres://secret@host/db';

    // Act
    const { buildChildEnv } = await import('../child-env.mjs');
    const env = buildChildEnv();

    // Assert
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/test');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.JWT_SECRET, undefined);
    assert.equal(env.PEPPER, undefined);
    assert.equal(env.WEBHOOK_SECRET, undefined);
    assert.equal(env.DATABASE_URL, undefined);
  });

  test('AC3.2: Default allowlist includes PATH, HOME, USER, SHELL, TERM, NODE_ENV, LOG_LEVEL', async () => {
    // Arrange
    process.env.PATH = '/usr/local/bin:/usr/bin';
    process.env.HOME = '/home/testuser';
    process.env.USER = 'testuser';
    process.env.SHELL = '/bin/zsh';
    process.env.TERM = 'xterm-256color';
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'debug';

    // Act
    const { buildChildEnv } = await import('../child-env.mjs');
    const env = buildChildEnv();

    // Assert
    assert.equal(env.PATH, '/usr/local/bin:/usr/bin');
    assert.equal(env.HOME, '/home/testuser');
    assert.equal(env.USER, 'testuser');
    assert.equal(env.SHELL, '/bin/zsh');
    assert.equal(env.TERM, 'xterm-256color');
    assert.equal(env.NODE_ENV, 'test');
    assert.equal(env.LOG_LEVEL, 'debug');
  });

  test('AC3.3: CLAUDE_* and ANTHROPIC_* vars are automatically included', async () => {
    // Arrange
    process.env.CLAUDE_API_KEY = 'claude-key-123';
    process.env.CLAUDE_MODEL = 'opus';
    process.env.ANTHROPIC_API_KEY = 'anthropic-key-456';
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
    process.env.NOT_CLAUDE_VAR = 'should-not-be-included';

    // Act
    const { buildChildEnv } = await import('../child-env.mjs');
    const env = buildChildEnv();

    // Assert
    assert.equal(env.CLAUDE_API_KEY, 'claude-key-123');
    assert.equal(env.CLAUDE_MODEL, 'opus');
    assert.equal(env.ANTHROPIC_API_KEY, 'anthropic-key-456');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
    assert.equal(env.NOT_CLAUDE_VAR, undefined);
  });

  test('AC3.4: Additional keys are merged into the allowlist', async () => {
    // Arrange
    process.env.PATH = '/usr/bin';
    process.env.CUSTOM_BUILD_DIR = '/opt/build';
    process.env.CDK_DEFAULT_ACCOUNT = '123456789012';

    // Act
    const { buildChildEnv } = await import('../child-env.mjs');
    const env = buildChildEnv(['CUSTOM_BUILD_DIR', 'CDK_DEFAULT_ACCOUNT']);

    // Assert
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.CUSTOM_BUILD_DIR, '/opt/build');
    assert.equal(env.CDK_DEFAULT_ACCOUNT, '123456789012');
  });

  test('AC3.5: Missing additional keys log a warning', async () => {
    // Arrange
    delete process.env.NONEXISTENT_KEY;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args.join(' '));
    };

    // Act
    const { buildChildEnv } = await import('../child-env.mjs');
    buildChildEnv(['NONEXISTENT_KEY']);

    // Assert
    const hasWarning = warnings.some((w) => w.includes('NONEXISTENT_KEY'));
    assert.equal(hasWarning, true, 'Expected a warning about missing NONEXISTENT_KEY');

    // Cleanup
    console.warn = originalWarn;
  });

  test('Secrets not in allowlist are excluded (AWS_SECRET_ACCESS_KEY, SESSION_SECRET, etc.)', async () => {
    // Arrange
    process.env.PATH = '/usr/bin';
    process.env.AWS_SECRET_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SESSION_TOKEN = 'FwoGZXIvYXdzEBYaDG...';
    process.env.SESSION_SECRET = 'my-session-secret';
    process.env.PASSWORD_HASH = '$argon2id$v=19...';

    // Act
    const { buildChildEnv } = await import('../child-env.mjs');
    const env = buildChildEnv();

    // Assert
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.AWS_SESSION_TOKEN, undefined);
    assert.equal(env.SESSION_SECRET, undefined);
    assert.equal(env.PASSWORD_HASH, undefined);
    assert.equal(env.PATH, '/usr/bin');
  });

  test('Missing default allowlist vars are omitted (not set to undefined)', async () => {
    // Arrange
    delete process.env.LOG_LEVEL;
    delete process.env.TERM;
    process.env.PATH = '/usr/bin';

    // Act
    const { buildChildEnv } = await import('../child-env.mjs');
    const env = buildChildEnv();

    // Assert
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'LOG_LEVEL'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'TERM'), false);
  });
});

/**
 * Tests for deployment verification CLI commands (record-deployment, record-deployment-failure)
 *
 * Spec: sg-deployment-verification-gaps
 * AC Groups: AC-1 (Deployment Detection), AC-2 (Deployment Failure)
 *
 * These tests exercise session-checkpoint.mjs CLI commands that write
 * deployment state to session.json. Uses the real project's session.json
 * with backup/restore.
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs deployment-verification-cli
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CHECKPOINT_SCRIPT = join(__dirname, '..', 'session-checkpoint.mjs');
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLAUDE_DIR = join(PROJECT_ROOT, '.claude');
const SESSION_PATH = join(CLAUDE_DIR, 'context', 'session.json');

/**
 * Run session-checkpoint.mjs with given arguments.
 */
function runCheckpoint(...args) {
  return new Promise((resolve) => {
    const child = spawn('node', [CHECKPOINT_SCRIPT, ...args], {
      cwd: PROJECT_ROOT,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => { resolve({ exitCode: code, stdout, stderr }); });
  });
}

/**
 * Create a minimal session.json suitable for deployment tests.
 */
function writeSession(overrides = {}) {
  const session = {
    version: '1.0.0',
    updated_at: new Date().toISOString(),
    active_work: {
      workflow: overrides.workflow || 'oneoff-spec',
      current_phase: overrides.currentPhase || 'implementing',
      objective: 'test deployment verification',
      started_at: new Date().toISOString(),
    },
    phase_checkpoint: {
      phase: overrides.currentPhase || 'implementing',
      enforcement_level: 'graduated',
      phase_skip_warnings: {},
      enforcement_counter: 0,
      _counter_checksum: 0xA3F5,
      next_actions: [],
    },
    subagent_tasks: {
      in_flight: [],
      completed_this_session: [],
    },
    history: [],
    ...(overrides.sessionExtras || {}),
  };
  mkdirSync(join(CLAUDE_DIR, 'context'), { recursive: true });
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
  return session;
}

/**
 * Read session.json back after a checkpoint operation.
 */
function readSession() {
  return JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));
}

// Backup/restore state
let sessionBackup = null;

beforeEach(() => {
  sessionBackup = existsSync(SESSION_PATH) ? readFileSync(SESSION_PATH, 'utf-8') : null;
});

afterEach(() => {
  if (sessionBackup !== null) writeFileSync(SESSION_PATH, sessionBackup);
  else if (existsSync(SESSION_PATH)) rmSync(SESSION_PATH);
});

// ============================================================
// AC-1.1: record-deployment writes correct deployment object
// ============================================================

describe('AC-1.1: record-deployment writes deployment object to session.json', () => {
  it('should set detected=true, timestamp, target, method, and reset verification fields', async () => {
    // Arrange
    writeSession();

    // Act
    const result = await runCheckpoint(
      'record-deployment',
      '--target', 'prod-us-east-1',
      '--method', 'pipeline',
    );

    // Assert
    expect(result.exitCode).toBe(0);
    const session = readSession();
    expect(session.deployment).toBeDefined();
    expect(session.deployment.detected).toBe(true);
    expect(session.deployment.target).toBe('prod-us-east-1');
    expect(session.deployment.method).toBe('pipeline');
    // Timestamp should be ISO 8601
    expect(session.deployment.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Verification fields reset to defaults
    expect(session.deployment.verified).toBe(false);
    expect(session.deployment.verify_build_passed).toBe(false);
    expect(session.deployment.verify_deploy_passed).toBe(false);
    expect(session.deployment.failed).toBe(false);
  });
});

// ============================================================
// AC-1.2: record-deployment rejects invalid input
// ============================================================

describe('AC-1.2: record-deployment rejects invalid target and method', () => {
  it('should reject target with special characters (e.g., semicolons)', async () => {
    // Arrange
    writeSession();

    // Act
    const result = await runCheckpoint(
      'record-deployment',
      '--target', 'prod;rm -rf /',
      '--method', 'pipeline',
    );

    // Assert
    expect(result.exitCode).not.toBe(0);
    // Session.json should NOT have a deployment object written
    const session = readSession();
    expect(session.deployment).toBeUndefined();
  });

  it('should reject target longer than 256 characters', async () => {
    // Arrange
    writeSession();
    const longTarget = 'a'.repeat(257);

    // Act
    const result = await runCheckpoint(
      'record-deployment',
      '--target', longTarget,
      '--method', 'pipeline',
    );

    // Assert
    expect(result.exitCode).not.toBe(0);
    const session = readSession();
    expect(session.deployment).toBeUndefined();
  });

  it('should reject method that is not "pipeline" or "manual"', async () => {
    // Arrange
    writeSession();

    // Act
    const result = await runCheckpoint(
      'record-deployment',
      '--target', 'staging',
      '--method', 'auto-detect',
    );

    // Assert
    expect(result.exitCode).not.toBe(0);
    const session = readSession();
    expect(session.deployment).toBeUndefined();
  });

  it('should accept target with allowed special chars: dots, hyphens, slashes, colons', async () => {
    // Arrange
    writeSession();

    // Act
    const result = await runCheckpoint(
      'record-deployment',
      '--target', 'aws/prod-us-east-1:443',
      '--method', 'pipeline',
    );

    // Assert
    expect(result.exitCode).toBe(0);
    const session = readSession();
    expect(session.deployment.target).toBe('aws/prod-us-east-1:443');
  });

  it('should accept target exactly 256 characters long', async () => {
    // Arrange
    writeSession();
    const maxTarget = 'a'.repeat(256);

    // Act
    const result = await runCheckpoint(
      'record-deployment',
      '--target', maxTarget,
      '--method', 'pipeline',
    );

    // Assert
    expect(result.exitCode).toBe(0);
    const session = readSession();
    expect(session.deployment.target).toBe(maxTarget);
  });
});

// ============================================================
// AC-1.3: record-deployment overwrites prior deployment (clean slate)
// ============================================================

describe('AC-1.3: record-deployment overwrites prior deployment object', () => {
  it('should overwrite prior deployment including stale verification state', async () => {
    // Arrange - Create session with prior deployment that has verification state
    writeSession({
      sessionExtras: {
        deployment: {
          detected: true,
          timestamp: '2026-04-14T10:00:00Z',
          target: 'old-staging',
          method: 'manual',
          verified: true,
          verify_build_passed: true,
          verify_deploy_passed: true,
          failed: false,
        },
      },
    });

    // Act - Record a new deployment
    const result = await runCheckpoint(
      'record-deployment',
      '--target', 'new-prod',
      '--method', 'pipeline',
    );

    // Assert - All verification fields reset, new target/method
    expect(result.exitCode).toBe(0);
    const session = readSession();
    expect(session.deployment.target).toBe('new-prod');
    expect(session.deployment.method).toBe('pipeline');
    expect(session.deployment.verified).toBe(false);
    expect(session.deployment.verify_build_passed).toBe(false);
    expect(session.deployment.verify_deploy_passed).toBe(false);
    expect(session.deployment.failed).toBe(false);
  });
});

// ============================================================
// AC-1.4: record-deployment --manual sets method to "manual"
// ============================================================

describe('AC-1.4: record-deployment --manual flag', () => {
  it('should set method to "manual" when --manual flag is used', async () => {
    // Arrange
    writeSession();

    // Act
    const result = await runCheckpoint(
      'record-deployment',
      '--target', 'prod-manual',
      '--manual',
    );

    // Assert
    expect(result.exitCode).toBe(0);
    const session = readSession();
    expect(session.deployment.method).toBe('manual');
    expect(session.deployment.detected).toBe(true);
  });

  it('should treat manual deployment identically to pipeline (same fields)', async () => {
    // Arrange
    writeSession();

    // Act
    const result = await runCheckpoint(
      'record-deployment',
      '--target', 'staging',
      '--manual',
    );

    // Assert
    expect(result.exitCode).toBe(0);
    const session = readSession();
    // Same shape as pipeline deployment
    expect(session.deployment).toHaveProperty('detected', true);
    expect(session.deployment).toHaveProperty('timestamp');
    expect(session.deployment).toHaveProperty('target', 'staging');
    expect(session.deployment).toHaveProperty('method', 'manual');
    expect(session.deployment).toHaveProperty('verified', false);
    expect(session.deployment).toHaveProperty('verify_build_passed', false);
    expect(session.deployment).toHaveProperty('verify_deploy_passed', false);
    expect(session.deployment).toHaveProperty('failed', false);
  });
});

// ============================================================
// AC-2.1: record-deployment-failure sets deployment.failed to true
// ============================================================

describe('AC-2.1: record-deployment-failure sets failed=true', () => {
  it('should set deployment.failed to true when called after deployment', async () => {
    // Arrange - First record a deployment
    writeSession();
    await runCheckpoint('record-deployment', '--target', 'prod', '--method', 'pipeline');

    // Act
    const result = await runCheckpoint('record-deployment-failure');

    // Assert
    expect(result.exitCode).toBe(0);
    const session = readSession();
    expect(session.deployment.failed).toBe(true);
    // Other fields should still exist
    expect(session.deployment.detected).toBe(true);
  });

  it('should warn if called without prior deployment detection', async () => {
    // Arrange - Session with no deployment
    writeSession();

    // Act
    const result = await runCheckpoint('record-deployment-failure');

    // Assert - Should still succeed (or warn) but set failed flag
    // The precondition is a warning, not a hard error
    const session = readSession();
    expect(session.deployment).toBeDefined();
    expect(session.deployment.failed).toBe(true);
  });
});

// ============================================================
// AC-2.2: deployment.failed absolute precedence (data verification)
// Full stop-hook behavioral test is in deployment-verification-gate.test.mjs
// ============================================================

describe('AC-2.2: deployment.failed absolute precedence (data verification)', () => {
  it('should record failed=true even when verify fields are already set', async () => {
    // Arrange - Deployment with some verification done
    writeSession({
      sessionExtras: {
        deployment: {
          detected: true,
          timestamp: '2026-04-14T10:00:00Z',
          target: 'prod',
          method: 'pipeline',
          verified: false,
          verify_build_passed: true,
          verify_deploy_passed: false,
          failed: false,
        },
      },
    });

    // Act
    const result = await runCheckpoint('record-deployment-failure');

    // Assert - failed=true takes precedence
    expect(result.exitCode).toBe(0);
    const session = readSession();
    expect(session.deployment.failed).toBe(true);
  });
});

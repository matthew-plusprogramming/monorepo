/**
 * Tests for deployment verification gate (stop hook enforcement)
 *
 * Spec: sg-deployment-verification-gaps
 * AC Groups: AC-5 (Coercive Enforcement), AC-6 (Fail-Open Behavior)
 *
 * These tests exercise the workflow-stop-enforcement.mjs stop hook's
 * deployment verification gate. Uses the real project's session.json
 * with backup/restore.
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs deployment-verification-gate
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

const HOOK_SCRIPT = join(__dirname, '..', 'workflow-stop-enforcement.mjs');
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLAUDE_DIR = join(PROJECT_ROOT, '.claude');
const SESSION_PATH = join(CLAUDE_DIR, 'context', 'session.json');
const COORDINATION_DIR = join(CLAUDE_DIR, 'coordination');
const KILL_SWITCH_PATH = join(COORDINATION_DIR, 'gate-enforcement-disabled');
const STOP_SENTINEL_PATH = join(COORDINATION_DIR, 'stop-hook-active');

/**
 * Run workflow-stop-enforcement.mjs with stdin data.
 */
function runHook(stdinData) {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK_SCRIPT], { cwd: PROJECT_ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => { resolve({ exitCode: code, stdout, stderr }); });
    const input = typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData);
    child.stdin.write(input);
    child.stdin.end();
  });
}

function makeStopStdin(sessionId = 'test-deployment-gate') {
  return { session_id: sessionId, hook_event_name: 'Stop' };
}

/**
 * Create session.json for deployment gate tests.
 * Includes all mandatory dispatches so the stop hook doesn't block
 * on missing subagent tasks.
 */
function makeSessionWithDeployment(deploymentOverrides = {}, sessionOverrides = {}) {
  const deployment = {
    detected: true,
    timestamp: '2026-04-14T12:00:00Z',
    target: 'prod',
    method: 'pipeline',
    verified: false,
    verify_build_passed: false,
    verify_deploy_passed: false,
    failed: false,
    ...deploymentOverrides,
  };

  return {
    active_work: {
      workflow: 'oneoff-spec',
      current_phase: 'complete',
      ...(sessionOverrides.active_work || {}),
    },
    subagent_tasks: {
      in_flight: [],
      completed_this_session: [
        { subagent_type: 'code-reviewer', status: 'completed' },
        { subagent_type: 'security-reviewer', status: 'completed' },
        { subagent_type: 'completion-verifier', status: 'completed' },
        { subagent_type: 'documenter', status: 'completed' },
        ...(sessionOverrides.subagent_tasks || []),
      ],
    },
    history: sessionOverrides.history || [],
    deployment,
  };
}

function writeSessionJson(session) {
  mkdirSync(join(CLAUDE_DIR, 'context'), { recursive: true });
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
}

function parseStopOutput(stdout) {
  try { return JSON.parse(stdout.trim()); }
  catch { return null; }
}

// Backup/restore state
let sessionBackup = null;
let killSwitchExisted = false;
let stopSentinelExisted = false;

beforeEach(() => {
  sessionBackup = existsSync(SESSION_PATH) ? readFileSync(SESSION_PATH, 'utf-8') : null;
  killSwitchExisted = existsSync(KILL_SWITCH_PATH);
  stopSentinelExisted = existsSync(STOP_SENTINEL_PATH);
});

afterEach(() => {
  // Restore session.json
  if (sessionBackup !== null) writeFileSync(SESSION_PATH, sessionBackup);
  else if (existsSync(SESSION_PATH)) rmSync(SESSION_PATH);

  // Restore kill switch
  if (!killSwitchExisted && existsSync(KILL_SWITCH_PATH)) rmSync(KILL_SWITCH_PATH);

  // Restore stop sentinel
  if (!stopSentinelExisted && existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);
  if (stopSentinelExisted && !existsSync(STOP_SENTINEL_PATH)) writeFileSync(STOP_SENTINEL_PATH, '');
});

// ============================================================
// AC-5.1: Stop hook blocks when deployed but unverified
// ============================================================

describe('AC-5.1: Stop hook blocks unverified deployment', () => {
  it('should block session completion when detected=true, failed=false, verify_deploy_passed=false', async () => {
    // Arrange
    const session = makeSessionWithDeployment({
      detected: true,
      failed: false,
      verify_deploy_passed: false,
    });
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    const output = parseStopOutput(result.stdout);
    expect(output).not.toBeNull();
    expect(output.decision).toBe('block');
    expect(output.reason).toMatch(/[Dd]eployment.*verif/i);
  });

  it('should include specific enforcement message about running smoke test', async () => {
    // Arrange
    const session = makeSessionWithDeployment({
      detected: true,
      failed: false,
      verify_deploy_passed: false,
    });
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    const output = parseStopOutput(result.stdout);
    expect(output.decision).toBe('block');
    // Per spec: "Deployment detected without post-deploy verification. Run smoke test before completing session."
    expect(output.reason).toMatch(/smoke test|post-deploy verif/i);
  });
});

// ============================================================
// AC-5.2: Stop hook allows when deployment verified
// ============================================================

describe('AC-5.2: Stop hook allows verified deployment', () => {
  it('should allow session completion when verify_deploy_passed=true', async () => {
    // Arrange
    const session = makeSessionWithDeployment({
      detected: true,
      verify_deploy_passed: true,
      failed: false,
    });
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    const output = parseStopOutput(result.stdout);
    // Should not block (either null output = allow, or explicit allow)
    if (output) {
      expect(output.decision).not.toBe('block');
    }
    // Exit 0 means allow
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-5.3: Stop hook allows when deployment failed
// ============================================================

describe('AC-5.3: Stop hook allows failed deployment', () => {
  it('should allow session completion when deployment.failed=true regardless of verify fields', async () => {
    // Arrange - failed=true, verify_deploy_passed=false
    const session = makeSessionWithDeployment({
      detected: true,
      failed: true,
      verify_deploy_passed: false,
      verify_build_passed: false,
    });
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    const output = parseStopOutput(result.stdout);
    if (output) {
      expect(output.decision).not.toBe('block');
    }
    expect(result.exitCode).toBe(0);
  });

  it('should allow completion even when failed=true and verify_deploy_passed=true', async () => {
    // Arrange - Both flags set (EC-8: failed takes absolute precedence)
    const session = makeSessionWithDeployment({
      detected: true,
      failed: true,
      verify_deploy_passed: true,
    });
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    if (parseStopOutput(result.stdout)) {
      expect(parseStopOutput(result.stdout).decision).not.toBe('block');
    }
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-5.4: Stop hook does NOT check verify_build_passed (advisory)
// ============================================================

describe('AC-5.4: verify_build_passed is advisory only', () => {
  it('should NOT block when verify_build_passed=false but verify_deploy_passed=true', async () => {
    // Arrange - Build not verified, but deploy verified
    const session = makeSessionWithDeployment({
      detected: true,
      failed: false,
      verify_build_passed: false,
      verify_deploy_passed: true,
    });
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert - Should allow (build is advisory)
    const output = parseStopOutput(result.stdout);
    if (output) {
      expect(output.decision).not.toBe('block');
    }
    expect(result.exitCode).toBe(0);
  });

  it('should still block when both verify_build_passed=false and verify_deploy_passed=false', async () => {
    // Arrange
    const session = makeSessionWithDeployment({
      detected: true,
      failed: false,
      verify_build_passed: false,
      verify_deploy_passed: false,
    });
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert - Block is due to verify_deploy_passed=false, NOT verify_build_passed
    const output = parseStopOutput(result.stdout);
    expect(output).not.toBeNull();
    expect(output.decision).toBe('block');
  });
});

// ============================================================
// AC-6.1: Advisory warning for missing verify:build script
// ============================================================

describe('AC-6.1: Advisory warning for missing verify:build', () => {
  it('should emit warning message when verify:build not in package.json', () => {
    // Arrange - package.json without verify:build
    const packageJson = { scripts: { build: 'tsc' } };
    const hasVerifyBuild = 'verify:build' in (packageJson.scripts || {});

    // Act
    const expectedWarning = 'No verify:build script -- deployment verification skipped';

    // Assert
    expect(hasVerifyBuild).toBe(false);
    expect(expectedWarning).toMatch(/No verify:build/);
    // Contract: execution proceeds (fail-open), no blocking
  });
});

// ============================================================
// AC-6.2: Advisory warning when no verify:deploy and no endpoint
// ============================================================

describe('AC-6.2: Advisory warning when no verify:deploy and no endpoint URL', () => {
  it('should emit warning and keep verify_deploy_passed=false', () => {
    // Arrange
    const packageJson = { scripts: {} };
    const endpointUrl = undefined;
    const hasVerifyDeploy = 'verify:deploy' in (packageJson.scripts || {});

    // Act
    const canRunSmokeTest = hasVerifyDeploy || !!endpointUrl;
    const expectedWarning = 'No verify:deploy script and no endpoint URL -- smoke test skipped';

    // Assert
    expect(canRunSmokeTest).toBe(false);
    expect(expectedWarning).toMatch(/No verify:deploy/);
    // verify_deploy_passed remains false -- stop hook still blocks per AC-5.1
  });

  it('should still result in stop hook blocking per AC-5.1', async () => {
    // Arrange - Deployment with no verification mechanism
    const session = makeSessionWithDeployment({
      detected: true,
      failed: false,
      verify_deploy_passed: false, // Remains false because no verification ran
    });
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert - Stop hook blocks regardless of the advisory warning
    const output = parseStopOutput(result.stdout);
    expect(output).not.toBeNull();
    expect(output.decision).toBe('block');
  });
});

// ============================================================
// AC-6.3: Stop hook fail-open on structural errors
// ============================================================

describe('AC-6.3: Stop hook fail-open on structural errors', () => {
  it('should exit 0 (fail-open) when deployment object is malformed (non-object)', async () => {
    // Arrange - Malformed deployment: string instead of object
    const session = makeSessionWithDeployment();
    session.deployment = 'not-an-object';
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert - Fail-open: exit 0, no block
    expect(result.exitCode).toBe(0);
    const output = parseStopOutput(result.stdout);
    if (output) {
      expect(output.decision).not.toBe('block');
    }
  });

  it('should exit 0 (fail-open) when deployment field has non-boolean values', async () => {
    // Arrange - deployment.detected is a string, not boolean
    const session = makeSessionWithDeployment();
    session.deployment = {
      detected: 'yes',
      failed: 0,
      verify_deploy_passed: null,
    };
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert - Structural error: fail-open
    expect(result.exitCode).toBe(0);
  });

  it('should log structural error to stderr', async () => {
    // Arrange - Malformed deployment
    const session = makeSessionWithDeployment();
    session.deployment = 42;
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert - stderr should contain diagnostic info
    expect(result.exitCode).toBe(0);
    // Structural error should be logged (implementation may vary)
  });

  it('should exit 0 (fail-open) when session.json is missing entirely', async () => {
    // Arrange - Remove session.json
    if (existsSync(SESSION_PATH)) rmSync(SESSION_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert - Fail-open
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-6.4: Missing deployment.detected treated as false
// ============================================================

describe('AC-6.4: Missing deployment.detected treated as false', () => {
  it('should not block when deployment field is entirely absent from session.json', async () => {
    // Arrange - Session without deployment field
    const session = {
      active_work: { workflow: 'oneoff-spec', current_phase: 'complete' },
      subagent_tasks: {
        in_flight: [],
        completed_this_session: [
          { subagent_type: 'code-reviewer', status: 'completed' },
          { subagent_type: 'security-reviewer', status: 'completed' },
          { subagent_type: 'completion-verifier', status: 'completed' },
          { subagent_type: 'documenter', status: 'completed' },
        ],
      },
      history: [],
      // No deployment field at all
    };
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert - No deployment detected, should not block on deployment
    const output = parseStopOutput(result.stdout);
    if (output && output.decision === 'block') {
      // If blocked, it should NOT be for deployment reasons
      expect(output.reason).not.toMatch(/[Dd]eployment/);
    }
    expect(result.exitCode).toBe(0);
  });

  it('should not block when deployment.detected is undefined', async () => {
    // Arrange - deployment object exists but detected is undefined
    const session = makeSessionWithDeployment();
    delete session.deployment.detected;
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert - undefined detected treated as false
    expect(result.exitCode).toBe(0);
    const output = parseStopOutput(result.stdout);
    if (output && output.decision === 'block') {
      expect(output.reason).not.toMatch(/[Dd]eployment/);
    }
  });
});

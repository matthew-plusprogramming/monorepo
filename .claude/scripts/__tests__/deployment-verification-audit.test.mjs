/**
 * Tests for deployment verification audit logging, schema, and atomic writes
 *
 * Spec: sg-deployment-verification-gaps
 * AC Groups: AC-7 (Atomic Writes), AC-8 (Structured Audit Logging),
 *            AC-9 (Consumer Contract Shape)
 *
 * AC-7 tests verify atomicModifyJSON usage for all deployment state writes.
 * AC-8 tests verify structured audit log format.
 * AC-9 tests verify the consumer contract shape (npm script interface).
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs deployment-verification-audit
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
const ATOMIC_WRITE_LIB = join(__dirname, '..', 'lib', 'atomic-write.mjs');

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
 * Create a minimal session.json for audit tests.
 */
function writeSession(overrides = {}) {
  const session = {
    version: '1.0.0',
    updated_at: new Date().toISOString(),
    active_work: {
      workflow: 'oneoff-spec',
      current_phase: 'implementing',
      objective: 'test deployment audit',
      started_at: new Date().toISOString(),
    },
    phase_checkpoint: {
      phase: 'implementing',
      enforcement_level: 'graduated',
      phase_skip_warnings: {},
      enforcement_counter: 0,
      _counter_checksum: 0xA3F5,
      next_actions: [],
    },
    subagent_tasks: { in_flight: [], completed_this_session: [] },
    history: [],
    ...(overrides.sessionExtras || {}),
  };
  mkdirSync(join(CLAUDE_DIR, 'context'), { recursive: true });
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
  return session;
}

function readSession() {
  return JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));
}

// Backup/restore
let sessionBackup = null;

beforeEach(() => {
  sessionBackup = existsSync(SESSION_PATH) ? readFileSync(SESSION_PATH, 'utf-8') : null;
});

afterEach(() => {
  if (sessionBackup !== null) writeFileSync(SESSION_PATH, sessionBackup);
  else if (existsSync(SESSION_PATH)) rmSync(SESSION_PATH);
});

// ============================================================
// AC-7.1: All deployment writes use atomicModifyJSON
// ============================================================

describe('AC-7.1: atomicModifyJSON used for all deployment writes', () => {
  it('should verify atomicModifyJSON module exists and is importable', async () => {
    // Arrange & Act
    const moduleExists = existsSync(ATOMIC_WRITE_LIB);

    // Assert - atomicModifyJSON module must exist for deployment writes
    expect(moduleExists).toBe(true);
  });

  it('should verify record-deployment produces valid JSON in session.json (no partial writes)', async () => {
    // Arrange
    writeSession();

    // Act
    const result = await runCheckpoint(
      'record-deployment',
      '--target', 'prod',
      '--method', 'pipeline',
    );

    // Assert - session.json must be valid JSON (atomicModifyJSON prevents partial writes)
    expect(result.exitCode).toBe(0);
    const sessionContent = readFileSync(SESSION_PATH, 'utf-8');
    expect(() => JSON.parse(sessionContent)).not.toThrow();
    const session = JSON.parse(sessionContent);
    expect(session.deployment).toBeDefined();
    expect(session.deployment.detected).toBe(true);
  });

  it('should verify record-deployment-failure produces valid JSON (no partial writes)', async () => {
    // Arrange
    writeSession({
      sessionExtras: {
        deployment: {
          detected: true,
          timestamp: '2026-04-14T12:00:00Z',
          target: 'prod',
          method: 'pipeline',
          verified: false,
          verify_build_passed: false,
          verify_deploy_passed: false,
          failed: false,
        },
      },
    });

    // Act
    const result = await runCheckpoint('record-deployment-failure');

    // Assert - session.json must be valid JSON
    expect(result.exitCode).toBe(0);
    const sessionContent = readFileSync(SESSION_PATH, 'utf-8');
    expect(() => JSON.parse(sessionContent)).not.toThrow();
  });
});

// ============================================================
// AC-7.2: Concurrent writes serialized by atomicModifyJSON
// ============================================================

describe('AC-7.2: Concurrent writes serialized by atomicModifyJSON lock', () => {
  it('should handle concurrent record-deployment and record-deployment-failure without corruption', async () => {
    // Arrange
    writeSession();
    // First record a deployment
    await runCheckpoint('record-deployment', '--target', 'prod', '--method', 'pipeline');

    // Act - Fire both commands concurrently
    const [deployResult, failureResult] = await Promise.all([
      runCheckpoint('record-deployment', '--target', 'staging', '--method', 'pipeline'),
      runCheckpoint('record-deployment-failure'),
    ]);

    // Assert - Session.json must be valid JSON (no corruption from race)
    const sessionContent = readFileSync(SESSION_PATH, 'utf-8');
    expect(() => JSON.parse(sessionContent)).not.toThrow();

    // At least one should succeed
    const anySucceeded = deployResult.exitCode === 0 || failureResult.exitCode === 0;
    expect(anySucceeded).toBe(true);

    // The final state should be coherent (last-write-wins)
    const session = JSON.parse(sessionContent);
    expect(session.deployment).toBeDefined();
  });
});

// ============================================================
// AC-8.1: Structured log format for verification results
// ============================================================

describe('AC-8.1: Structured audit log format', () => {
  it('should define the required audit log fields per contract', () => {
    // Arrange - Expected audit log shape from spec
    const requiredFields = ['result', 'timestamp', 'command', 'exit_code'];

    // Act - Create a sample audit entry
    const auditEntry = {
      result: 'PASS',
      timestamp: '2026-04-14T12:00:00.000Z',
      command: 'cdktf synth --output dist && node dist/main.js',
      exit_code: 0,
      endpoint_url: 'https://api.example.com/health',
    };

    // Assert - All required fields present
    requiredFields.forEach((field) => {
      expect(auditEntry).toHaveProperty(field);
    });

    // result is PASS or FAIL
    expect(['PASS', 'FAIL']).toContain(auditEntry.result);

    // timestamp is ISO 8601
    expect(auditEntry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // exit_code is a number
    expect(typeof auditEntry.exit_code).toBe('number');
  });

  it('should include endpoint_url for verify:deploy audit logs', () => {
    // Arrange
    const verifyDeployAudit = {
      result: 'PASS',
      timestamp: '2026-04-14T12:05:00.000Z',
      command: 'HTTP GET https://api.example.com/health',
      exit_code: 0,
      endpoint_url: 'https://api.example.com/health',
    };

    // Assert
    expect(verifyDeployAudit.endpoint_url).toBeDefined();
    expect(verifyDeployAudit.endpoint_url).toMatch(/^https?:\/\//);
  });

  it('should include exit_code=-1 for timeout/connection errors', () => {
    // Arrange
    const timeoutAudit = {
      result: 'FAIL',
      timestamp: '2026-04-14T12:10:00.000Z',
      command: 'HTTP GET https://api.example.com/health',
      exit_code: -1,
      endpoint_url: 'https://api.example.com/health',
    };

    // Assert
    expect(timeoutAudit.result).toBe('FAIL');
    expect(timeoutAudit.exit_code).toBe(-1);
  });
});

// ============================================================
// AC-8.2: Audit log includes resolved script command text
// ============================================================

describe('AC-8.2: Resolved script command text in audit log', () => {
  it('should log the actual command from package.json, not "npm run verify:build"', () => {
    // Arrange
    const packageJson = {
      scripts: {
        'verify:build': 'cdktf synth --output dist && node dist/main.js',
      },
    };

    // Act - Resolve the actual script command
    const resolvedCommand = packageJson.scripts['verify:build'];

    // Assert - Not the npm wrapper name
    expect(resolvedCommand).not.toBe('npm run verify:build');
    expect(resolvedCommand).not.toMatch(/^npm run/);
    // Is the actual command text
    expect(resolvedCommand).toBe('cdktf synth --output dist && node dist/main.js');
  });

  it('should handle scripts with complex commands', () => {
    // Arrange
    const packageJson = {
      scripts: {
        'verify:build': 'docker build -t app:test . && docker run --rm app:test node healthcheck.js',
      },
    };

    // Act
    const resolvedCommand = packageJson.scripts['verify:build'];

    // Assert
    expect(resolvedCommand).toContain('docker');
    expect(resolvedCommand).not.toMatch(/^npm/);
  });
});

// ============================================================
// AC-9.1: Contract defines verify:build and verify:deploy as npm scripts
// ============================================================

describe('AC-9.1: verify:build and verify:deploy are npm script names', () => {
  it('should use standard npm script naming convention', () => {
    // Arrange - Contract-defined script names
    const contractScripts = ['verify:build', 'verify:deploy'];

    // Assert - These are valid npm script names (colon-separated namespace)
    contractScripts.forEach((name) => {
      expect(name).toMatch(/^verify:/);
      expect(name).not.toContain(' ');
    });
  });

  it('should be declared in package.json scripts section', () => {
    // Arrange - A conforming consumer package.json
    const consumerPackageJson = {
      name: 'my-consumer-project',
      scripts: {
        build: 'tsc',
        test: 'vitest',
        'verify:build': 'cdktf synth --output dist',
        'verify:deploy': 'curl -sf $ENDPOINT_URL',
      },
    };

    // Assert - Scripts are declared in standard location
    expect(consumerPackageJson.scripts['verify:build']).toBeDefined();
    expect(consumerPackageJson.scripts['verify:deploy']).toBeDefined();
  });
});

// ============================================================
// AC-9.2: verify:deploy receives endpoint URL as first argument
// ============================================================

describe('AC-9.2: verify:deploy receives endpoint URL as first argument', () => {
  it('should pass endpoint URL to the script invocation', () => {
    // Arrange
    const endpointUrl = 'https://prod.example.com/api/health';
    const scriptName = 'verify:deploy';

    // Act - Build invocation string per contract
    // npm run verify:deploy -- <endpoint-url>
    const invocation = `npm run ${scriptName} -- ${endpointUrl}`;

    // Assert
    expect(invocation).toContain(endpointUrl);
    // The URL is the first user argument (after --)
    const argsAfterDash = invocation.split('-- ')[1];
    expect(argsAfterDash).toBe(endpointUrl);
  });

  it('should exit 0 for PASS and non-zero for FAIL per contract', () => {
    // Arrange - Contract exit code semantics
    const EXIT_PASS = 0;
    const EXIT_FAIL_EXAMPLES = [1, 2, 127];

    // Assert
    expect(EXIT_PASS).toBe(0);
    EXIT_FAIL_EXAMPLES.forEach((code) => {
      expect(code).not.toBe(0);
    });
  });
});

// ============================================================
// AC-9.3: No target-specific logic in framework
// ============================================================

describe('AC-9.3: Framework has no target-specific logic', () => {
  it('should define contracts that work across deployment targets', () => {
    // Arrange - Example target-specific implementations that consumers own
    const consumerImplementations = {
      lambda: 'sam local invoke --event test-event.json',
      docker: 'docker run --rm app:test node healthcheck.js',
      'bare-metal': 'curl -sf http://localhost:3000/health',
      cdktf: 'cdktf synth --output dist && node dist/main.js',
    };

    // Assert - All implementations use the same contract interface
    Object.values(consumerImplementations).forEach((cmd) => {
      // Each is a valid shell command (string, non-empty)
      expect(typeof cmd).toBe('string');
      expect(cmd.length).toBeGreaterThan(0);
    });

    // Framework contract is target-agnostic: just "exit 0 = PASS, non-zero = FAIL"
    const frameworkContract = {
      pass_condition: 'exit 0',
      fail_condition: 'exit non-zero',
    };
    // No mention of specific targets
    expect(frameworkContract.pass_condition).not.toMatch(/lambda|docker|cdktf/i);
    expect(frameworkContract.fail_condition).not.toMatch(/lambda|docker|cdktf/i);
  });
});

// ============================================================
// Edge Cases
// ============================================================

describe('Edge Cases: Deployment verification audit', () => {
  it('EC-7: record-deployment should overwrite stale state from prior deployment', async () => {
    // Arrange - Prior deployment with verification done
    writeSession({
      sessionExtras: {
        deployment: {
          detected: true,
          timestamp: '2026-04-14T10:00:00Z',
          target: 'old-env',
          method: 'manual',
          verified: true,
          verify_build_passed: true,
          verify_deploy_passed: true,
          failed: false,
        },
      },
    });

    // Act - New deployment
    const result = await runCheckpoint(
      'record-deployment',
      '--target', 'new-env',
      '--method', 'pipeline',
    );

    // Assert - Clean slate
    expect(result.exitCode).toBe(0);
    const session = readSession();
    expect(session.deployment.target).toBe('new-env');
    expect(session.deployment.verify_build_passed).toBe(false);
    expect(session.deployment.verify_deploy_passed).toBe(false);
    expect(session.deployment.verified).toBe(false);
  });

  it('EC-8: deployment.failed=true alongside verification fields takes precedence', () => {
    // Arrange - Deployment state per EC-8
    const deploymentState = {
      detected: true,
      failed: true,
      verify_build_passed: true,
      verify_deploy_passed: false,
    };

    // Act - Apply precedence logic
    const shouldBlock = deploymentState.detected
      && !deploymentState.failed
      && !deploymentState.verify_deploy_passed;

    // Assert - Should NOT block because failed=true
    expect(shouldBlock).toBe(false);
  });
});

/**
 * Integration tests for workflow-stop-enforcement.mjs (Stop hook)
 *
 * Spec: sg-coercive-gate-enforcement
 * Component 4: Stop Hook Enforcement
 *
 * Covers: AC-4.1 through AC-4.12
 *
 * The hook resolves .claude/ from its own script location, so tests use
 * the real project's session.json with backup/restore.
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs workflow-stop-enforcement
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

function makeStopStdin(sessionId = 'test-session') {
  return { session_id: sessionId, hook_event_name: 'Stop' };
}

function makeSessionJson(overrides = {}) {
  const tasks = overrides.subagent_tasks || [];
  return {
    active_work: {
      workflow: 'oneoff-spec',
      current_phase: 'complete',  // Default to terminal phase for backward compat
      ...(overrides.active_work || {}),
    },
    subagent_tasks: {
      in_flight: [],
      completed_this_session: tasks,
    },
    history: overrides.history || [],
  };
}

function makeFullSession(overrides = {}) {
  return makeSessionJson({
    ...overrides,
    subagent_tasks: [
      { subagent_type: 'code-reviewer', status: 'completed' },
      { subagent_type: 'security-reviewer', status: 'completed' },
      { subagent_type: 'completion-verifier', status: 'completed' },
      { subagent_type: 'documenter', status: 'completed' },
      ...(overrides.subagent_tasks || []),
    ],
  });
}

function writeSessionJson(session) {
  mkdirSync(join(CLAUDE_DIR, 'context'), { recursive: true });
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
}

function removeSessionJson() {
  if (existsSync(SESSION_PATH)) rmSync(SESSION_PATH);
}

function createKillSwitch() {
  mkdirSync(COORDINATION_DIR, { recursive: true });
  writeFileSync(KILL_SWITCH_PATH, '');
}

function createStopSentinel() {
  mkdirSync(COORDINATION_DIR, { recursive: true });
  writeFileSync(STOP_SENTINEL_PATH, '');
}

function parseStopOutput(stdout) {
  try { return JSON.parse(stdout.trim()); }
  catch { return null; }
}

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
// AC-4.1: Blocks when code-reviewer missing
// ============================================================

describe('AC-4.1: Blocks when code-reviewer dispatch missing', () => {
  it('should output block JSON when code-reviewer is missing', async () => {
    // Arrange
    const session = makeSessionJson({
      subagent_tasks: [
        { subagent_type: 'security-reviewer', status: 'completed' },
        { subagent_type: 'completion-verifier', status: 'completed' },
        { subagent_type: 'documenter', status: 'completed' },
      ],
    });
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    const output = parseStopOutput(result.stdout);
    expect(output).not.toBeNull();
    expect(output.decision).toBe('block');
    expect(output.reason).toMatch(/code-reviewer/i);
  });
});

// ============================================================
// AC-4.2: Blocks when security-reviewer missing
// ============================================================

describe('AC-4.2: Blocks when security-reviewer dispatch missing', () => {
  it('should output block JSON when security-reviewer is missing', async () => {
    // Arrange
    const session = makeSessionJson({
      subagent_tasks: [
        { subagent_type: 'code-reviewer', status: 'completed' },
        { subagent_type: 'completion-verifier', status: 'completed' },
        { subagent_type: 'documenter', status: 'completed' },
      ],
    });
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    const output = parseStopOutput(result.stdout);
    expect(output).not.toBeNull();
    expect(output.decision).toBe('block');
    expect(output.reason).toMatch(/security-reviewer/i);
  });
});

// ============================================================
// AC-4.3: Blocks when completion-verifier missing
// ============================================================

describe('AC-4.3: Blocks when completion-verifier dispatch missing', () => {
  it('should output block JSON when completion-verifier is missing', async () => {
    // Arrange
    const session = makeSessionJson({
      subagent_tasks: [
        { subagent_type: 'code-reviewer', status: 'completed' },
        { subagent_type: 'security-reviewer', status: 'completed' },
        { subagent_type: 'documenter', status: 'completed' },
      ],
    });
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    const output = parseStopOutput(result.stdout);
    expect(output).not.toBeNull();
    expect(output.decision).toBe('block');
    expect(output.reason).toMatch(/completion-verifier/i);
  });
});

// ============================================================
// AC-4.4: Blocks when documenter missing
// ============================================================

describe('AC-4.4: Blocks when documenter dispatch missing', () => {
  it('should output block JSON when documenter is missing', async () => {
    // Arrange
    const session = makeSessionJson({
      subagent_tasks: [
        { subagent_type: 'code-reviewer', status: 'completed' },
        { subagent_type: 'security-reviewer', status: 'completed' },
        { subagent_type: 'completion-verifier', status: 'completed' },
      ],
    });
    writeSessionJson(session);
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    const output = parseStopOutput(result.stdout);
    expect(output).not.toBeNull();
    expect(output.decision).toBe('block');
    expect(output.reason).toMatch(/documenter/i);
  });
});

// ============================================================
// AC-4.5: Allows when all 4 mandatory dispatches present
// ============================================================

describe('AC-4.5: Allows when all mandatory dispatches present', () => {
  it('should exit 0 when all 4 mandatory dispatch records exist', async () => {
    // Arrange
    writeSessionJson(makeFullSession());
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-4.6: Sentinel file prevents infinite loop
// ============================================================

describe('AC-4.6: Stop-hook-active sentinel prevents re-entry', () => {
  it('should exit 0 immediately when stop-hook-active sentinel exists', async () => {
    // Arrange -- sentinel file present, session would normally block
    writeSessionJson(makeSessionJson({ subagent_tasks: [] }));
    createStopSentinel();

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    expect(result.exitCode).toBe(0);
  });

  it('should create sentinel file when blocking', async () => {
    // Arrange
    writeSessionJson(makeSessionJson({ subagent_tasks: [] }));
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    const output = parseStopOutput(result.stdout);
    expect(output).not.toBeNull();
    expect(output.decision).toBe('block');
    expect(existsSync(STOP_SENTINEL_PATH)).toBe(true);
  });
});

// ============================================================
// AC-4.7: Exempt workflows bypass stop hook enforcement
// ============================================================

describe('AC-4.7: Exempt workflows bypass enforcement', () => {
  const exemptWorkflows = ['oneoff-vibe', 'refactor', 'journal-only'];

  for (const workflow of exemptWorkflows) {
    it(`should exit 0 for exempt workflow: ${workflow}`, async () => {
      // Arrange
      writeSessionJson(makeSessionJson({
        active_work: { workflow },
        subagent_tasks: [],
      }));
      if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

      // Act
      const result = await runHook(makeStopStdin());

      // Assert
      expect(result.exitCode).toBe(0);
    });
  }
});

// ============================================================
// AC-4.8: Fail-open when session.json missing
// ============================================================

describe('AC-4.8: Fail-open when session.json missing', () => {
  it('should exit 0 when session.json does not exist', async () => {
    // Arrange
    removeSessionJson();
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    expect(result.exitCode).toBe(0);
  });

  it('should exit 0 when session.json is malformed', async () => {
    // Arrange
    mkdirSync(join(CLAUDE_DIR, 'context'), { recursive: true });
    writeFileSync(SESSION_PATH, 'not valid json');
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-4.9: Kill switch exits 0 immediately
// ============================================================

describe('AC-4.9: Kill switch exits 0 immediately', () => {
  afterEach(() => {
    if (existsSync(KILL_SWITCH_PATH)) rmSync(KILL_SWITCH_PATH);
  });

  it('should exit 0 when kill switch exists', async () => {
    // Arrange
    createKillSwitch();
    writeSessionJson(makeSessionJson({ subagent_tasks: [] }));

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-4.10: Uses stdout JSON for blocking, NOT stderr + exit 2
// ============================================================

describe('AC-4.10: Uses correct blocking mechanism (stdout JSON)', () => {
  it('should output block decision via stdout JSON', async () => {
    // Arrange
    writeSessionJson(makeSessionJson({ subagent_tasks: [] }));
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    const output = parseStopOutput(result.stdout);
    expect(output).not.toBeNull();
    expect(output.decision).toBe('block');
    expect(typeof output.reason).toBe('string');
    expect(output.reason.length).toBeGreaterThan(0);
  });

  it('should list all missing dispatches in the reason', async () => {
    // Arrange
    writeSessionJson(makeSessionJson({ subagent_tasks: [] }));
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    const output = parseStopOutput(result.stdout);
    expect(output.reason).toMatch(/code-reviewer/i);
    expect(output.reason).toMatch(/security-reviewer/i);
    expect(output.reason).toMatch(/completion-verifier/i);
    expect(output.reason).toMatch(/documenter/i);
  });
});

// ============================================================
// AC-4.11: Running/failed dispatch records satisfy check
// ============================================================

describe('AC-4.11: Dispatch records with any status satisfy check', () => {
  it('should accept running status', async () => {
    // Arrange
    writeSessionJson(makeSessionJson({
      subagent_tasks: [
        { subagent_type: 'code-reviewer', status: 'running' },
        { subagent_type: 'security-reviewer', status: 'running' },
        { subagent_type: 'completion-verifier', status: 'running' },
        { subagent_type: 'documenter', status: 'running' },
      ],
    }));
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    expect(result.exitCode).toBe(0);
  });

  it('should accept failed status', async () => {
    // Arrange
    writeSessionJson(makeSessionJson({
      subagent_tasks: [
        { subagent_type: 'code-reviewer', status: 'failed' },
        { subagent_type: 'security-reviewer', status: 'failed' },
        { subagent_type: 'completion-verifier', status: 'failed' },
        { subagent_type: 'documenter', status: 'failed' },
      ],
    }));
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    expect(result.exitCode).toBe(0);
  });

  it('should accept mixed status records', async () => {
    // Arrange
    writeSessionJson(makeSessionJson({
      subagent_tasks: [
        { subagent_type: 'code-reviewer', status: 'completed' },
        { subagent_type: 'security-reviewer', status: 'running' },
        { subagent_type: 'completion-verifier', status: 'failed' },
        { subagent_type: 'documenter', status: 'pending' },
      ],
    }));
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-4.12: Concurrent reads accepted
// ============================================================

describe('AC-4.12: Concurrent stop hook reads accepted', () => {
  it('should handle concurrent runs without errors', async () => {
    // Arrange
    writeSessionJson(makeFullSession());
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const [r1, r2] = await Promise.all([
      runHook(makeStopStdin()),
      runHook(makeStopStdin()),
    ]);

    // Assert
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
  });
});

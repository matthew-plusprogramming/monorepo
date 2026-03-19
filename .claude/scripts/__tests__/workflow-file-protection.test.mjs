/**
 * Integration tests for Write protection of enforcement files
 *
 * Spec: sg-coercive-gate-enforcement
 * Component 3: Agent Write Protection
 *
 * Covers: AC-3.1, AC-3.2, AC-3.3, AC-3.4
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs workflow-file-protection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLAUDE_DIR = join(PROJECT_ROOT, '.claude');
const COORDINATION_DIR = join(CLAUDE_DIR, 'coordination');
const KILL_SWITCH_PATH = join(COORDINATION_DIR, 'gate-enforcement-disabled');

/**
 * The write protection may be a separate script or part of gate enforcement.
 * Try the dedicated script first, then fall back.
 */
const WRITE_HOOK_SCRIPT = join(__dirname, '..', 'workflow-file-protection.mjs');
const GATE_HOOK_SCRIPT = join(__dirname, '..', 'workflow-gate-enforcement.mjs');

function getHookScript() {
  if (existsSync(WRITE_HOOK_SCRIPT)) return WRITE_HOOK_SCRIPT;
  if (existsSync(GATE_HOOK_SCRIPT)) return GATE_HOOK_SCRIPT;
  return WRITE_HOOK_SCRIPT;
}

function runHook(stdinData) {
  const hookScript = getHookScript();
  return new Promise((resolve) => {
    const child = spawn('node', [hookScript], { cwd: PROJECT_ROOT });
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

function makeWriteStdin(sessionId, filePath) {
  return {
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: filePath },
  };
}

function createKillSwitch() {
  mkdirSync(COORDINATION_DIR, { recursive: true });
  writeFileSync(KILL_SWITCH_PATH, '');
}

let killSwitchExisted = false;

beforeEach(() => {
  killSwitchExisted = existsSync(KILL_SWITCH_PATH);
});

afterEach(() => {
  if (!killSwitchExisted && existsSync(KILL_SWITCH_PATH)) {
    rmSync(KILL_SWITCH_PATH);
  }
});

// ============================================================
// AC-3.1: Blocks writes to gate-override.json
// ============================================================

describe('AC-3.1: Blocks write to gate-override.json', () => {
  it('should exit 2 when agent writes to gate-override.json', async () => {
    // Arrange
    const filePath = join(COORDINATION_DIR, 'gate-override.json');

    // Act
    const result = await runHook(makeWriteStdin('test-session', filePath));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/gate-override|blocked|protection/i);
  });
});

// ============================================================
// AC-3.2: Blocks writes to gate-enforcement-disabled
// ============================================================

describe('AC-3.2: Blocks write to gate-enforcement-disabled', () => {
  it('should exit 2 when agent writes to gate-enforcement-disabled', async () => {
    // Arrange
    const filePath = join(COORDINATION_DIR, 'gate-enforcement-disabled');

    // Act
    const result = await runHook(makeWriteStdin('test-session', filePath));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/gate-enforcement-disabled|blocked|protection/i);
  });
});

// ============================================================
// AC-3.3: Allows writes to all other files
// ============================================================

describe('AC-3.3: Allows writes to other files', () => {
  it('should exit 0 for normal source code files', async () => {
    // Arrange
    const filePath = join(PROJECT_ROOT, 'src', 'service.mjs');

    // Act
    const result = await runHook(makeWriteStdin('test-session', filePath));

    // Assert
    expect(result.exitCode).toBe(0);
  });

  it('should exit 0 for session.json', async () => {
    // Arrange
    const filePath = join(CLAUDE_DIR, 'context', 'session.json');

    // Act
    const result = await runHook(makeWriteStdin('test-session', filePath));

    // Assert
    expect(result.exitCode).toBe(0);
  });

  it('should exit 0 for other coordination files', async () => {
    // Arrange
    const filePath = join(COORDINATION_DIR, 'trace-reads.json');

    // Act
    const result = await runHook(makeWriteStdin('test-session', filePath));

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-3.4: Kill switch does NOT disable write protection
// ============================================================

describe('AC-3.4: Kill switch does NOT disable write protection', () => {
  afterEach(() => {
    if (existsSync(KILL_SWITCH_PATH)) rmSync(KILL_SWITCH_PATH);
  });

  it('should STILL block write to gate-override.json with kill switch active', async () => {
    // Arrange
    createKillSwitch();
    const filePath = join(COORDINATION_DIR, 'gate-override.json');

    // Act
    const result = await runHook(makeWriteStdin('test-session', filePath));

    // Assert
    expect(result.exitCode).toBe(2);
  });

  it('should STILL block write to gate-enforcement-disabled with kill switch active', async () => {
    // Arrange
    createKillSwitch();
    const filePath = join(COORDINATION_DIR, 'gate-enforcement-disabled');

    // Act
    const result = await runHook(makeWriteStdin('test-session', filePath));

    // Assert
    expect(result.exitCode).toBe(2);
  });

  it('should allow writes to normal files with kill switch active', async () => {
    // Arrange
    createKillSwitch();
    const filePath = join(PROJECT_ROOT, 'src', 'normal-file.mjs');

    // Act
    const result = await runHook(makeWriteStdin('test-session', filePath));

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

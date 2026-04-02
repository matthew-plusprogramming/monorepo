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

// Test spec group and PRD constants for PRD staleness tests (AC-2.x)
const PRD_TEST_SPEC_GROUP_ID = 'sg-test-prd-staleness';
const PRD_TEST_SPEC_GROUP_DIR = join(CLAUDE_DIR, 'specs', 'groups', PRD_TEST_SPEC_GROUP_ID);
const PRD_TEST_MANIFEST_PATH = join(PRD_TEST_SPEC_GROUP_DIR, 'manifest.json');
const PRD_TEST_REQ_PATH = join(PRD_TEST_SPEC_GROUP_DIR, 'requirements.md');
const PRD_TEST_FILE_PATH = join(CLAUDE_DIR, 'prds', 'test-prd-staleness.md');

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

// ============================================================
// PRD Staleness Warning Tests (AC-2.1 through AC-2.7)
// Spec: sg-manifest-prd-staleness-fix, REQ-002
// ============================================================

/**
 * Helper: write a test manifest for PRD staleness tests.
 */
function writePrdTestManifest(manifestOverrides = {}) {
  mkdirSync(PRD_TEST_SPEC_GROUP_DIR, { recursive: true });
  const manifest = {
    id: PRD_TEST_SPEC_GROUP_ID,
    spec_group_id: PRD_TEST_SPEC_GROUP_ID,
    title: 'Test PRD Staleness',
    workflow: 'oneoff-spec',
    review_state: 'APPROVED',
    work_state: 'READY_TO_MERGE',
    convergence: {
      spec_complete: true,
      all_acs_implemented: true,
      all_tests_passing: true,
      unifier_passed: true,
      code_review_passed: true,
      security_review_passed: true,
      completion_verification_passed: true,
      docs_generated: true,
      investigation_converged: true,
      challenger_converged: true,
    },
    decision_log: [],
    ...manifestOverrides,
  };
  writeFileSync(PRD_TEST_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Helper: write a test PRD file with the given state.
 */
function writePrdTestFile(state = 'draft') {
  mkdirSync(join(CLAUDE_DIR, 'prds'), { recursive: true });
  const content = `---\nid: test-prd-staleness\nstate: ${state}\ntitle: Test PRD\n---\n\n# Test PRD\n`;
  writeFileSync(PRD_TEST_FILE_PATH, content);
}

/**
 * Helper: create a session pointing to the PRD test spec group with
 * all mandatory dispatches satisfied and phase=complete.
 */
function makePrdTestSession() {
  return {
    active_work: {
      workflow: 'oneoff-spec',
      current_phase: 'complete',
      spec_group_id: PRD_TEST_SPEC_GROUP_ID,
    },
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
  };
}

// Track PRD test artifacts for cleanup
let prdSpecGroupExisted = false;
let prdFileExisted = false;

// Note: session backup/restore is handled by the existing beforeEach/afterEach above.

describe('AC-2.1: PRD warning when linked PRD state is draft and work_state is READY_TO_MERGE', () => {
  beforeEach(() => {
    prdSpecGroupExisted = existsSync(PRD_TEST_SPEC_GROUP_DIR);
    prdFileExisted = existsSync(PRD_TEST_FILE_PATH);
  });

  afterEach(() => {
    if (!prdSpecGroupExisted && existsSync(PRD_TEST_SPEC_GROUP_DIR)) {
      rmSync(PRD_TEST_SPEC_GROUP_DIR, { recursive: true });
    }
    if (!prdFileExisted && existsSync(PRD_TEST_FILE_PATH)) {
      rmSync(PRD_TEST_FILE_PATH);
    }
  });

  it('should emit PRD warning when linked PRD state is draft (via manifest prd.file_path)', async () => {
    // Arrange
    writeSessionJson(makePrdTestSession());
    writePrdTestManifest({
      prd: { file_path: '.claude/prds/test-prd-staleness.md' },
    });
    writePrdTestFile('draft');
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    expect(result.exitCode).toBe(0);
    const output = parseStopOutput(result.stdout);
    expect(output).not.toBeNull();
    expect(output.additionalContext).toMatch(/WARNING.*PRD.*draft/i);
    expect(output.additionalContext).toMatch(/prd status/i);
  });
});

describe('AC-2.2: No PRD warning when PRD state is shipped', () => {
  beforeEach(() => {
    prdSpecGroupExisted = existsSync(PRD_TEST_SPEC_GROUP_DIR);
    prdFileExisted = existsSync(PRD_TEST_FILE_PATH);
  });

  afterEach(() => {
    if (!prdSpecGroupExisted && existsSync(PRD_TEST_SPEC_GROUP_DIR)) {
      rmSync(PRD_TEST_SPEC_GROUP_DIR, { recursive: true });
    }
    if (!prdFileExisted && existsSync(PRD_TEST_FILE_PATH)) {
      rmSync(PRD_TEST_FILE_PATH);
    }
  });

  it('should not emit PRD warning when PRD state is shipped', async () => {
    // Arrange
    writeSessionJson(makePrdTestSession());
    writePrdTestManifest({
      prd: { file_path: '.claude/prds/test-prd-staleness.md' },
    });
    writePrdTestFile('shipped');
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    expect(result.exitCode).toBe(0);
    // Should have no stdout output (bare exit 0 when no warnings/blocks)
    expect(result.stdout.trim()).toBe('');
  });
});

describe('AC-2.3: No PRD warning when no PRD linked', () => {
  beforeEach(() => {
    prdSpecGroupExisted = existsSync(PRD_TEST_SPEC_GROUP_DIR);
  });

  afterEach(() => {
    if (!prdSpecGroupExisted && existsSync(PRD_TEST_SPEC_GROUP_DIR)) {
      rmSync(PRD_TEST_SPEC_GROUP_DIR, { recursive: true });
    }
  });

  it('should not emit PRD warning when no PRD is linked in manifest', async () => {
    // Arrange - no prd field in manifest at all
    writeSessionJson(makePrdTestSession());
    writePrdTestManifest({});
    // Also create requirements.md WITHOUT prd_path
    writeFileSync(
      PRD_TEST_REQ_PATH,
      '---\nspec_group: sg-test-prd-staleness\n---\n\n# Requirements\n'
    );
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});

describe('AC-2.4: No PRD warning when PRD file does not exist', () => {
  beforeEach(() => {
    prdSpecGroupExisted = existsSync(PRD_TEST_SPEC_GROUP_DIR);
  });

  afterEach(() => {
    if (!prdSpecGroupExisted && existsSync(PRD_TEST_SPEC_GROUP_DIR)) {
      rmSync(PRD_TEST_SPEC_GROUP_DIR, { recursive: true });
    }
  });

  it('should not emit PRD warning when PRD file does not exist on disk', async () => {
    // Arrange
    writeSessionJson(makePrdTestSession());
    writePrdTestManifest({
      prd: { file_path: '.claude/prds/nonexistent-prd.md' },
    });
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});

describe('AC-2.5: Session not blocked when PRD check throws', () => {
  beforeEach(() => {
    prdSpecGroupExisted = existsSync(PRD_TEST_SPEC_GROUP_DIR);
  });

  afterEach(() => {
    if (!prdSpecGroupExisted && existsSync(PRD_TEST_SPEC_GROUP_DIR)) {
      rmSync(PRD_TEST_SPEC_GROUP_DIR, { recursive: true });
    }
  });

  it('should still allow completion when PRD check encounters errors (fail-open)', async () => {
    // Arrange - manifest references PRD but manifest content is malformed
    writeSessionJson(makePrdTestSession());
    mkdirSync(PRD_TEST_SPEC_GROUP_DIR, { recursive: true });
    // Write a manifest that will trigger the PRD check but references broken PRD
    writePrdTestManifest({
      prd: { file_path: '.claude/prds/test-prd-staleness.md' },
    });
    // Write a PRD file with malformed frontmatter
    mkdirSync(join(CLAUDE_DIR, 'prds'), { recursive: true });
    writeFileSync(PRD_TEST_FILE_PATH, 'no frontmatter at all just text');
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert -- should NOT block even if PRD parsing fails
    expect(result.exitCode).toBe(0);
    // stdout should be empty or only contain non-blocking output (no "block" decision)
    if (result.stdout.trim()) {
      const output = parseStopOutput(result.stdout);
      if (output) {
        expect(output.decision).not.toBe('block');
      }
    }
  });

  afterEach(() => {
    if (existsSync(PRD_TEST_FILE_PATH)) rmSync(PRD_TEST_FILE_PATH);
  });
});

describe('AC-2.6: Fall back to requirements.md prd_path when manifest has no prd field', () => {
  beforeEach(() => {
    prdSpecGroupExisted = existsSync(PRD_TEST_SPEC_GROUP_DIR);
    prdFileExisted = existsSync(PRD_TEST_FILE_PATH);
  });

  afterEach(() => {
    if (!prdSpecGroupExisted && existsSync(PRD_TEST_SPEC_GROUP_DIR)) {
      rmSync(PRD_TEST_SPEC_GROUP_DIR, { recursive: true });
    }
    if (!prdFileExisted && existsSync(PRD_TEST_FILE_PATH)) {
      rmSync(PRD_TEST_FILE_PATH);
    }
  });

  it('should locate PRD via requirements.md prd_path frontmatter', async () => {
    // Arrange - no prd field in manifest, but requirements.md has prd_path
    writeSessionJson(makePrdTestSession());
    writePrdTestManifest({});
    writeFileSync(
      PRD_TEST_REQ_PATH,
      '---\nspec_group: sg-test-prd-staleness\nprd_path: .claude/prds/test-prd-staleness.md\n---\n\n# Requirements\n'
    );
    writePrdTestFile('draft');
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    expect(result.exitCode).toBe(0);
    const output = parseStopOutput(result.stdout);
    expect(output).not.toBeNull();
    expect(output.additionalContext).toMatch(/WARNING.*PRD.*draft/i);
  });
});

describe('AC-2.7: Locate PRD via manifest prd.prd_path when prd.file_path is absent', () => {
  beforeEach(() => {
    prdSpecGroupExisted = existsSync(PRD_TEST_SPEC_GROUP_DIR);
    prdFileExisted = existsSync(PRD_TEST_FILE_PATH);
  });

  afterEach(() => {
    if (!prdSpecGroupExisted && existsSync(PRD_TEST_SPEC_GROUP_DIR)) {
      rmSync(PRD_TEST_SPEC_GROUP_DIR, { recursive: true });
    }
    if (!prdFileExisted && existsSync(PRD_TEST_FILE_PATH)) {
      rmSync(PRD_TEST_FILE_PATH);
    }
  });

  it('should locate PRD via manifest prd.prd_path field', async () => {
    // Arrange - use prd.prd_path instead of prd.file_path
    writeSessionJson(makePrdTestSession());
    writePrdTestManifest({
      prd: { prd_path: '.claude/prds/test-prd-staleness.md' },
    });
    writePrdTestFile('draft');
    if (existsSync(STOP_SENTINEL_PATH)) rmSync(STOP_SENTINEL_PATH);

    // Act
    const result = await runHook(makeStopStdin());

    // Assert
    expect(result.exitCode).toBe(0);
    const output = parseStopOutput(result.stdout);
    expect(output).not.toBeNull();
    expect(output.additionalContext).toMatch(/WARNING.*PRD.*draft/i);
  });
});

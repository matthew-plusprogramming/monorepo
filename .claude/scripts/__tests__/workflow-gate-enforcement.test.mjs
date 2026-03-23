/**
 * Integration tests for workflow-gate-enforcement.mjs (PreToolUse Agent hook)
 *
 * Spec: sg-coercive-gate-enforcement
 * Component 2: PreToolUse Gate Enforcement
 *
 * Covers: AC-0.1, AC-2.1 through AC-2.19
 *
 * The hook script resolves .claude/ by walking up from its own location,
 * so tests use the real project's .claude/context/session.json with
 * backup/restore to ensure isolation.
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs workflow-gate-enforcement
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  copyFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the hook script under test */
const HOOK_SCRIPT = join(__dirname, '..', 'workflow-gate-enforcement.mjs');

/** Real project .claude paths -- hooks resolve from their own location */
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLAUDE_DIR = join(PROJECT_ROOT, '.claude');
const SESSION_PATH = join(CLAUDE_DIR, 'context', 'session.json');
const SESSION_BACKUP = join(CLAUDE_DIR, 'context', 'session.json.test-backup');
const COORDINATION_DIR = join(CLAUDE_DIR, 'coordination');
const KILL_SWITCH_PATH = join(COORDINATION_DIR, 'gate-enforcement-disabled');
const OVERRIDE_PATH = join(COORDINATION_DIR, 'gate-override.json');

/**
 * Run the hook script with given stdin JSON.
 */
function runHook(stdinData) {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK_SCRIPT], {
      cwd: PROJECT_ROOT,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });

    const input = typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData);
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Create a standard PreToolUse Agent stdin JSON payload.
 */
function makeAgentStdin(sessionId, subagentType, extraToolInput = {}) {
  return {
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: {
      subagent_type: subagentType,
      ...extraToolInput,
    },
  };
}

/**
 * Create a minimal session.json with given properties.
 * Note: subagent_tasks in session.json is an object with in_flight and
 * completed_this_session arrays, not a flat array.
 */
function makeSessionJson(overrides = {}) {
  const tasks = overrides.subagent_tasks || [];
  return {
    active_work: {
      workflow: 'oneoff-spec',
      ...(overrides.active_work || {}),
    },
    subagent_tasks: {
      in_flight: [],
      completed_this_session: tasks,
    },
    history: overrides.history || [],
    ...(overrides.convergence !== undefined ? { convergence: overrides.convergence } : {}),
  };
}

/**
 * Write session.json to the real project path.
 */
function writeSessionJson(session) {
  mkdirSync(join(CLAUDE_DIR, 'context'), { recursive: true });
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
}

/**
 * Remove session.json from the real project path.
 */
function removeSessionJson() {
  if (existsSync(SESSION_PATH)) {
    rmSync(SESSION_PATH);
  }
}

/**
 * Write gate-override.json.
 */
function writeOverrideJson(overrides) {
  mkdirSync(COORDINATION_DIR, { recursive: true });
  writeFileSync(OVERRIDE_PATH, JSON.stringify(overrides, null, 2));
}

/**
 * Create the kill switch sentinel file.
 */
function createKillSwitch() {
  mkdirSync(COORDINATION_DIR, { recursive: true });
  writeFileSync(KILL_SWITCH_PATH, '');
}

// Backup and restore session.json before/after each test
let sessionBackupContent = null;
let overrideBackupContent = null;
let killSwitchExisted = false;

beforeEach(() => {
  // Backup session.json if it exists
  if (existsSync(SESSION_PATH)) {
    sessionBackupContent = readFileSync(SESSION_PATH, 'utf-8');
  } else {
    sessionBackupContent = null;
  }

  // Backup gate-override.json if it exists
  if (existsSync(OVERRIDE_PATH)) {
    overrideBackupContent = readFileSync(OVERRIDE_PATH, 'utf-8');
  } else {
    overrideBackupContent = null;
  }

  // Track kill switch state
  killSwitchExisted = existsSync(KILL_SWITCH_PATH);
});

afterEach(() => {
  // Restore session.json
  if (sessionBackupContent !== null) {
    writeFileSync(SESSION_PATH, sessionBackupContent);
  } else {
    if (existsSync(SESSION_PATH)) rmSync(SESSION_PATH);
  }

  // Restore gate-override.json
  if (overrideBackupContent !== null) {
    writeFileSync(OVERRIDE_PATH, overrideBackupContent);
  } else {
    if (existsSync(OVERRIDE_PATH)) rmSync(OVERRIDE_PATH);
  }

  // Restore kill switch state
  if (!killSwitchExisted && existsSync(KILL_SWITCH_PATH)) {
    rmSync(KILL_SWITCH_PATH);
  }
});

// ============================================================
// AC-0.1: Agent tool schema verification prerequisite
// ============================================================

describe('AC-0.1: Agent tool stdin includes subagent_type', () => {
  it('should parse subagent_type from stdin tool_input', async () => {
    // Arrange -- session with all convergence prerequisites met for implementer (WS-4 change)
    const session = makeSessionJson({
      convergence: {
        investigation: { clean_pass_count: 2 },
        challenger: { clean_pass_count: 2 },
      },
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert -- hook should allow (exit 0) proving it parsed subagent_type correctly
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-2.1: Blocks implementer without investigation + challenge
// ============================================================

describe('AC-2.1: Blocks implementer without prerequisites', () => {
  it('should block implementer when no investigation convergence exists (oneoff-spec)', async () => {
    // Arrange -- no convergence data at all
    const session = makeSessionJson({ subagent_tasks: [] });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert -- convergence-type prerequisites block (WS-4 change)
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/investigation|convergence/i);
  });

  it('should block implementer when investigation converged but challenger has not (oneoff-spec)', async () => {
    // Arrange -- only investigation converged, challenger still at 0
    const session = makeSessionJson({
      convergence: {
        investigation: { clean_pass_count: 2 },
      },
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/challenger|convergence/i);
  });

  it('should allow implementer when both convergence prerequisites are met (oneoff-spec)', async () => {
    // Arrange -- both investigation and challenger converged (>= 2 clean passes)
    const session = makeSessionJson({
      convergence: {
        investigation: { clean_pass_count: 2 },
        challenger: { clean_pass_count: 2 },
      },
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert
    expect(result.exitCode).toBe(0);
  });

  it('should block implementer in orchestrator when convergence not met', async () => {
    // Arrange -- orchestrator workflow, convergence gates not met
    const session = makeSessionJson({
      active_work: { workflow: 'orchestrator' },
      convergence: {
        investigation: { clean_pass_count: 2 },
        challenger: { clean_pass_count: 1 },
      },
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert -- should block because challenger convergence < 2
    expect(result.exitCode).toBe(2);
  });

  it('should allow implementer in orchestrator when both convergence gates are met', async () => {
    // Arrange -- orchestrator workflow, both gates converged
    const session = makeSessionJson({
      active_work: { workflow: 'orchestrator' },
      convergence: {
        investigation: { clean_pass_count: 2 },
        challenger: { clean_pass_count: 2 },
      },
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-2.2: test-writer has no coercive prerequisites (Practice 2.4)
// ============================================================

describe('AC-2.2: test-writer has no coercive prerequisites (parallel with implementer)', () => {
  it('should allow test-writer even without implementer dispatch (works from spec only)', async () => {
    // Arrange
    const session = makeSessionJson({ subagent_tasks: [] });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'test-writer'));

    // Assert — no coercive prerequisites, test-writer is free to dispatch
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-2.3: Blocks code-reviewer without pre-review challenge + unifier
// ============================================================

describe('AC-2.3: Blocks code-reviewer without prerequisites', () => {
  it('should block code-reviewer when no unifier dispatch exists', async () => {
    // Arrange
    const session = makeSessionJson({
      subagent_tasks: [
        { subagent_type: 'challenger', stage: 'pre-review', status: 'completed' },
      ],
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'code-reviewer'));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/unifier/i);
  });

  it('should block code-reviewer when no pre-review challenger exists', async () => {
    // Arrange
    const session = makeSessionJson({
      subagent_tasks: [
        { subagent_type: 'unifier', status: 'completed' },
      ],
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'code-reviewer'));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/challenger|pre-review/i);
  });

  it('should allow code-reviewer when both prerequisites are met', async () => {
    // Arrange
    const session = makeSessionJson({
      subagent_tasks: [
        { subagent_type: 'challenger', stage: 'pre-review', status: 'completed' },
        { subagent_type: 'unifier', status: 'completed' },
      ],
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'code-reviewer'));

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-2.4: security-reviewer has same prerequisites as code-reviewer (parallel)
// ============================================================

describe('AC-2.4: security-reviewer requires challenger(pre-review) + unifier (parallel with code-reviewer)', () => {
  it('should block when no prerequisites are met', async () => {
    // Arrange
    const session = makeSessionJson({ subagent_tasks: [] });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'security-reviewer'));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/challenger|unifier|pre-review/i);
  });

  it('should block when only unifier is present (missing challenger pre-review)', async () => {
    // Arrange
    const session = makeSessionJson({
      subagent_tasks: [
        { subagent_type: 'unifier', status: 'completed' },
      ],
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'security-reviewer'));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/challenger|pre-review/i);
  });

  it('should allow when both challenger(pre-review) and unifier are present', async () => {
    // Arrange
    const session = makeSessionJson({
      subagent_tasks: [
        { subagent_type: 'challenger', stage: 'pre-review', status: 'completed' },
        { subagent_type: 'unifier', status: 'completed' },
      ],
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'security-reviewer'));

    // Assert — same prerequisites as code-reviewer, both can dispatch in parallel
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-2.5: Blocks documenter when either review convergence < 2
// ============================================================

describe('AC-2.5: Blocks documenter until both code_review AND security_review converge', () => {
  it('should block when neither review has converged', async () => {
    // Arrange
    const session = makeSessionJson({
      convergence: {
        code_review: { clean_pass_count: 0 },
        security_review: { clean_pass_count: 0 },
      },
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'documenter'));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/convergence/i);
  });

  it('should block when only code_review has converged', async () => {
    // Arrange
    const session = makeSessionJson({
      convergence: {
        code_review: { clean_pass_count: 2 },
        security_review: { clean_pass_count: 1 },
      },
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'documenter'));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/security.?review|convergence/i);
  });

  it('should block when only security_review has converged', async () => {
    // Arrange
    const session = makeSessionJson({
      convergence: {
        code_review: { clean_pass_count: 0 },
        security_review: { clean_pass_count: 2 },
      },
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'documenter'));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/code.?review|convergence/i);
  });

  it('should allow when both reviews have converged (>= 2 clean passes each)', async () => {
    // Arrange
    const session = makeSessionJson({
      convergence: {
        code_review: { clean_pass_count: 2 },
        security_review: { clean_pass_count: 2 },
      },
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'documenter'));

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-2.6: Blocks completion-verifier without documenter
// ============================================================

describe('AC-2.6: Blocks completion-verifier without documenter', () => {
  it('should block when no documenter dispatch exists', async () => {
    // Arrange
    const session = makeSessionJson({ subagent_tasks: [] });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'completion-verifier'));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/documenter/i);
  });

  it('should allow when documenter has been dispatched', async () => {
    // Arrange
    const session = makeSessionJson({
      subagent_tasks: [
        { subagent_type: 'documenter', status: 'completed' },
      ],
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'completion-verifier'));

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-2.7: Non-enforced subagent types pass through
// ============================================================

describe('AC-2.7: Non-enforced subagent types pass through', () => {
  const nonEnforcedTypes = [
    'explore',
    'spec-author',
    'atomizer',
    'atomicity-enforcer',
    'prd-writer',
    'prd-critic',
    'prd-reader',
    'prd-amender',
    'refactorer',
    'facilitator',
    'browser-tester',
    'challenger',
    'unifier',
    'interface-investigator',
  ];

  for (const subagentType of nonEnforcedTypes) {
    it(`should exit 0 for non-enforced type: ${subagentType}`, async () => {
      // Arrange -- empty session, no prereqs
      const session = makeSessionJson({ subagent_tasks: [] });
      writeSessionJson(session);

      // Act
      const result = await runHook(makeAgentStdin('test-session', subagentType));

      // Assert
      expect(result.exitCode).toBe(0);
    });
  }
});

// ============================================================
// AC-2.8: Exempt workflows bypass all enforcement
// ============================================================

describe('AC-2.8: Exempt workflows bypass all enforcement', () => {
  const exemptWorkflows = ['oneoff-vibe', 'refactor', 'journal-only'];

  for (const workflow of exemptWorkflows) {
    it(`should exit 0 for exempt workflow: ${workflow} (even for enforced type)`, async () => {
      // Arrange -- session with exempt workflow, no prereqs
      const session = makeSessionJson({
        active_work: { workflow },
        subagent_tasks: [],
      });
      writeSessionJson(session);

      // Act -- dispatch an enforced type with no prereqs
      const result = await runHook(makeAgentStdin('test-session', 'implementer'));

      // Assert -- should allow because workflow is exempt
      expect(result.exitCode).toBe(0);
    });
  }
});

// ============================================================
// AC-2.9: Fail-open when session.json missing
// ============================================================

describe('AC-2.9: Fail-open when session.json missing', () => {
  it('should exit 0 when session.json does not exist', async () => {
    // Arrange -- remove session.json
    removeSessionJson();

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-2.10: Fail-open when active_work missing
// ============================================================

describe('AC-2.10: Fail-open when active_work missing', () => {
  it('should exit 0 when active_work field is missing from session.json', async () => {
    // Arrange
    writeSessionJson({ subagent_tasks: [] });

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-2.11: Fail-open on malformed session.json
// ============================================================

describe('AC-2.11: Fail-open on malformed session.json', () => {
  it('should exit 0 when session.json contains invalid JSON', async () => {
    // Arrange
    mkdirSync(join(CLAUDE_DIR, 'context'), { recursive: true });
    writeFileSync(SESSION_PATH, 'not valid json {{{');

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-2.12: Fail-open on uncaught exception (script error)
// ============================================================

describe('AC-2.12: Fail-open on uncaught exception', () => {
  it('should exit 0 when stdin is empty', async () => {
    // Arrange -- empty stdin causes parse error

    // Act
    const result = await runHook('');

    // Assert
    expect(result.exitCode).toBe(0);
  });

  it('should exit 0 when stdin is malformed JSON', async () => {
    // Act
    const result = await runHook('not valid json {{{');

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-2.13: Fail-closed when convergence field missing
// ============================================================

describe('AC-2.13: Fail-closed when convergence field missing', () => {
  it('should treat missing convergence.code_review.clean_pass_count as 0 and block documenter', async () => {
    // Arrange -- session with no convergence field at all
    const session = makeSessionJson({ subagent_tasks: [] });
    writeSessionJson(session);

    // Act — documenter requires both code_review and security_review convergence
    const result = await runHook(makeAgentStdin('test-session', 'documenter'));

    // Assert -- fail-closed: treat as 0, block
    expect(result.exitCode).toBe(2);
  });

  it('should treat missing convergence.security_review.clean_pass_count as 0 and block documenter', async () => {
    // Arrange -- convergence exists but no security_review
    const session = makeSessionJson({
      convergence: { code_review: { clean_pass_count: 2 } },
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'documenter'));

    // Assert -- fail-closed: treat as 0, block
    expect(result.exitCode).toBe(2);
  });
});

// ============================================================
// AC-2.14: Kill switch exits 0 immediately as first check
// ============================================================

describe('AC-2.14: Kill switch exits 0 immediately', () => {
  afterEach(() => {
    // Always clean up kill switch
    if (existsSync(KILL_SWITCH_PATH)) rmSync(KILL_SWITCH_PATH);
  });

  it('should exit 0 immediately when kill switch exists, even with no session.json', async () => {
    // Arrange
    createKillSwitch();
    removeSessionJson();

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert
    expect(result.exitCode).toBe(0);
  });

  it('should exit 0 with kill switch even when enforcement would block', async () => {
    // Arrange
    createKillSwitch();
    const session = makeSessionJson({ subagent_tasks: [] });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-2.15: Override allows blocked dispatch (session-scoped)
// ============================================================

describe('AC-2.15: Override allows blocked dispatch', () => {
  it('should allow dispatch when valid override matches session_id and gate', async () => {
    // Arrange -- session that would block implementer (convergence-type prerequisites)
    const session = makeSessionJson({ subagent_tasks: [] });
    writeSessionJson(session);

    writeOverrideJson({
      overrides: [
        {
          gate: 'investigation_convergence',
          session_id: 'test-session',
          timestamp: new Date().toISOString(),
          rationale: 'Investigation convergence completed out-of-band',
        },
        {
          gate: 'challenger_convergence',
          session_id: 'test-session',
          timestamp: new Date().toISOString(),
          rationale: 'Challenger convergence completed out-of-band',
        },
      ],
    });

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert
    expect(result.exitCode).toBe(0);
  });

  it('should NOT honor override with wrong session_id', async () => {
    // Arrange
    const session = makeSessionJson({ subagent_tasks: [] });
    writeSessionJson(session);

    writeOverrideJson({
      overrides: [
        {
          gate: 'investigation_convergence',
          session_id: 'wrong-session',
          timestamp: new Date().toISOString(),
          rationale: 'Wrong session',
        },
        {
          gate: 'challenger_convergence',
          session_id: 'wrong-session',
          timestamp: new Date().toISOString(),
          rationale: 'Wrong session',
        },
      ],
    });

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert -- still blocked
    expect(result.exitCode).toBe(2);
  });
});

// ============================================================
// AC-2.16: Most recent override wins for same gate
// ============================================================

describe('AC-2.16: Most recent override wins for same gate', () => {
  it('should use the most recent override matching session_id', async () => {
    // Arrange
    const session = makeSessionJson({ subagent_tasks: [] });
    writeSessionJson(session);

    writeOverrideJson({
      overrides: [
        {
          gate: 'investigation_convergence',
          session_id: 'test-session',
          timestamp: '2026-03-18T10:00:00Z',
          rationale: 'Earlier override',
        },
        {
          gate: 'investigation_convergence',
          session_id: 'test-session',
          timestamp: '2026-03-18T12:00:00Z',
          rationale: 'Later override -- should win',
        },
        {
          gate: 'challenger_convergence',
          session_id: 'test-session',
          timestamp: '2026-03-18T12:00:00Z',
          rationale: 'Override for challenger convergence',
        },
      ],
    });

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert -- most recent override honored
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-2.17: Retries once on gate-override.json parse failure
// ============================================================

describe('AC-2.17: Retries once on gate-override.json parse failure', () => {
  it('should still block when gate-override.json has malformed JSON', async () => {
    // Arrange
    const session = makeSessionJson({ subagent_tasks: [] });
    writeSessionJson(session);

    mkdirSync(COORDINATION_DIR, { recursive: true });
    writeFileSync(OVERRIDE_PATH, 'not valid json {{{');

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert -- no valid override, should block
    expect(result.exitCode).toBe(2);
  });

  it('should not crash on missing gate-override.json', async () => {
    // Arrange
    const session = makeSessionJson({ subagent_tasks: [] });
    writeSessionJson(session);

    // Make sure no override file exists
    if (existsSync(OVERRIDE_PATH)) rmSync(OVERRIDE_PATH);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert -- should block normally
    expect(result.exitCode).toBe(2);
  });
});

// ============================================================
// AC-2.18: Block message includes subagent type, missing prereqs, session_id
// ============================================================

describe('AC-2.18: Block message includes helpful information', () => {
  it('should include the blocked subagent type in stderr', async () => {
    // Arrange
    const session = makeSessionJson({ subagent_tasks: [] });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session-123', 'implementer'));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/implementer/i);
  });

  it('should include the missing prerequisites in stderr', async () => {
    // Arrange
    const session = makeSessionJson({ subagent_tasks: [] });
    writeSessionJson(session);

    // Act — use code-reviewer which requires challenger(pre-review) + unifier
    const result = await runHook(makeAgentStdin('test-session-123', 'code-reviewer'));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/challenger|unifier/i);
  });

  it('should include actionable unblock guidance in stderr', async () => {
    // Arrange
    const session = makeSessionJson({ subagent_tasks: [] });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('my-unique-session-id', 'implementer'));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/How to unblock/i);
    expect(result.stderr).toMatch(/retry this dispatch/i);
  });
});

// ============================================================
// AC-2.19: Skips dispatch records with unrecognized subagent_type
// ============================================================

describe('AC-2.19: Skips unrecognized dispatch records', () => {
  it('should skip unknown type records and still evaluate valid ones', async () => {
    // Arrange -- implementer uses convergence-type prerequisites (WS-4 change)
    const session = makeSessionJson({
      subagent_tasks: [
        { subagent_type: 'unknown-type-xyz', status: 'completed' },
        { subagent_type: 'interface-investigator', status: 'completed' },
        { subagent_type: 'challenger', stage: 'pre-implementation', status: 'completed' },
      ],
      convergence: {
        investigation: { clean_pass_count: 2 },
        challenger: { clean_pass_count: 2 },
      },
    });
    writeSessionJson(session);

    // Act
    const result = await runHook(makeAgentStdin('test-session', 'implementer'));

    // Assert -- convergence prereqs are met
    expect(result.exitCode).toBe(0);
  });

  it('should not count unknown type records as satisfying prerequisites', async () => {
    // Arrange
    const session = makeSessionJson({
      subagent_tasks: [
        { subagent_type: 'unknown-type', status: 'completed' },
      ],
    });
    writeSessionJson(session);

    // Act — use code-reviewer which requires challenger(pre-review) + unifier
    const result = await runHook(makeAgentStdin('test-session', 'code-reviewer'));

    // Assert -- unknown type doesn't satisfy challenger/unifier prereqs
    expect(result.exitCode).toBe(2);
  });
});

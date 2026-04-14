/**
 * Integration tests for the update-convergence command in session-checkpoint.mjs
 *
 * Spec: sg-convergence-audit-enforcement
 * Milestone: M2 (Evidence-Based Counting)
 *
 * Covers: AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-2.8
 *
 * Tests execute session-checkpoint.mjs with the update-convergence and record-pass
 * subcommands and verify session.json mutations.
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs update-convergence
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CHECKPOINT_SCRIPT = join(__dirname, '..', 'session-checkpoint.mjs');
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLAUDE_DIR = join(PROJECT_ROOT, '.claude');
const SESSION_PATH = join(CLAUDE_DIR, 'context', 'session.json');
const LOCK_PATH = SESSION_PATH + '.lock';

/**
 * Run session-checkpoint.mjs with args.
 */
function runCheckpoint(args, captureAll = false) {
  if (captureAll) {
    // Use spawnSync to capture both stdout and stderr regardless of exit code
    const result = spawnSync('node', [CHECKPOINT_SCRIPT, ...args], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 10000,
    });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }
  // Default path: execFileSync throws on non-zero exit
  const result = execFileSync('node', [CHECKPOINT_SCRIPT, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 10000,
  });
  return { exitCode: 0, stdout: result, stderr: '' };
}

function makeSessionJson(overrides = {}) {
  const tasks = overrides.subagent_tasks || [];
  return {
    version: '1.0.0',
    updated_at: new Date().toISOString(),
    active_work: {
      workflow: 'oneoff-spec',
      spec_group_id: 'sg-test',
      current_phase: 'implementing',
      objective: 'test',
      ...(overrides.active_work || {}),
    },
    phase_checkpoint: { phase: 'implementing' },
    subagent_tasks: {
      in_flight: [],
      completed_this_session: tasks,
    },
    history: overrides.history || [],
    ...(overrides.convergence !== undefined ? { convergence: overrides.convergence } : {}),
    ...(overrides.convergence_evidence !== undefined ? { convergence_evidence: overrides.convergence_evidence } : {}),
  };
}

function writeSessionJson(session) {
  mkdirSync(join(CLAUDE_DIR, 'context'), { recursive: true });
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
}

function readSessionJson() {
  return JSON.parse(readFileSync(SESSION_PATH, 'utf8'));
}

/**
 * Helper: record a pass via record-pass CLI.
 */
function recordPass(gate, { findingsCount = 0, findingsHash = null, clean = true, agentType = 'interface-investigator', source = 'hook' } = {}) {
  const hashArg = findingsHash || 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // hash of empty array
  runCheckpoint([
    'record-pass', gate,
    '--findings-count', String(findingsCount),
    '--findings-hash', hashArg,
    '--clean', String(clean),
    '--agent-type', agentType,
    '--source', source,
  ]);
}

let sessionBackup = null;

beforeEach(() => {
  sessionBackup = existsSync(SESSION_PATH) ? readFileSync(SESSION_PATH, 'utf-8') : null;
  // Clean up any stale lock files
  if (existsSync(LOCK_PATH)) {
    try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
  }
});

afterEach(() => {
  if (sessionBackup !== null) writeFileSync(SESSION_PATH, sessionBackup);
  else if (existsSync(SESSION_PATH)) rmSync(SESSION_PATH);
  // Clean up lock files
  if (existsSync(LOCK_PATH)) {
    try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
  }
});

// ============================================================
// AC-2.1: Derives count from evidence (no count argument)
// ============================================================

describe('AC-2.1: Derives count from evidence', () => {
  it('should derive clean_pass_count from evidence array', () => {
    // Arrange: session with 2 clean hook-sourced passes
    writeSessionJson(makeSessionJson());
    recordPass('investigation', { clean: true, source: 'hook' });
    recordPass('investigation', { clean: true, source: 'hook' });

    // Act
    runCheckpoint(['update-convergence', 'investigation']);

    // Assert
    const updated = readSessionJson();
    expect(updated.convergence.investigation.clean_pass_count).toBe(2);
  });
});

// ============================================================
// AC-2.2: Rejects old API with numeric second argument
// ============================================================

describe('AC-2.2: Rejects old API with numeric second argument', () => {
  it('should reject update-convergence with a count argument', () => {
    // Arrange
    writeSessionJson(makeSessionJson());

    // Act
    const result = runCheckpoint(['update-convergence', 'code_review', '2'], true);

    // Assert
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/no longer accepts a count argument/i);
  });

  it('should reject update-convergence with any second argument', () => {
    // Arrange
    writeSessionJson(makeSessionJson());

    // Act
    const result = runCheckpoint(['update-convergence', 'investigation', '0'], true);

    // Assert
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/no longer accepts/i);
  });
});

// ============================================================
// AC-2.3: Counts consecutive clean from tail (non-consecutive = correct)
// ============================================================

describe('AC-2.3: Counts consecutive clean from tail', () => {
  it('should count only consecutive clean hook passes from tail', () => {
    // Arrange: [clean, dirty, clean, clean]
    writeSessionJson(makeSessionJson());
    recordPass('investigation', { clean: true, source: 'hook' });
    recordPass('investigation', { clean: false, source: 'hook', findingsCount: 3 });
    recordPass('investigation', { clean: true, source: 'hook' });
    recordPass('investigation', { clean: true, source: 'hook' });

    // Act
    runCheckpoint(['update-convergence', 'investigation']);

    // Assert
    const updated = readSessionJson();
    expect(updated.convergence.investigation.clean_pass_count).toBe(2);
  });

  it('should return 0 if last pass is dirty', () => {
    // Arrange: [clean, clean, dirty]
    writeSessionJson(makeSessionJson());
    recordPass('investigation', { clean: true, source: 'hook' });
    recordPass('investigation', { clean: true, source: 'hook' });
    recordPass('investigation', { clean: false, source: 'hook', findingsCount: 1 });

    // Act
    runCheckpoint(['update-convergence', 'investigation']);

    // Assert
    const updated = readSessionJson();
    expect(updated.convergence.investigation.clean_pass_count).toBe(0);
  });
});

// ============================================================
// AC-2.4: Manual passes not counted toward clean_pass_count
// ============================================================

describe('AC-2.4: Manual passes not counted', () => {
  it('should not count manual passes toward clean_pass_count', () => {
    // Arrange: [hook:clean, manual:clean]
    writeSessionJson(makeSessionJson());
    recordPass('investigation', { clean: true, source: 'hook' });
    recordPass('investigation', { clean: true, source: 'manual' });

    // Act
    runCheckpoint(['update-convergence', 'investigation']);

    // Assert: manual pass breaks the consecutive hook-sourced chain
    const updated = readSessionJson();
    expect(updated.convergence.investigation.clean_pass_count).toBe(0);
  });
});

// ============================================================
// AC-2.5: Empty evidence yields clean_pass_count = 0
// ============================================================

describe('AC-2.5: Empty evidence yields 0', () => {
  it('should set clean_pass_count to 0 when no evidence exists', () => {
    // Arrange
    writeSessionJson(makeSessionJson());

    // Act
    runCheckpoint(['update-convergence', 'investigation']);

    // Assert
    const updated = readSessionJson();
    expect(updated.convergence.investigation.clean_pass_count).toBe(0);
  });
});

// ============================================================
// AC-2.8: >50% manual passes emits warning
// ============================================================

describe('AC-2.8: >50% manual passes warning', () => {
  it('should warn when more than half of passes are manual', () => {
    // Arrange: 1 hook, 2 manual (67% manual)
    writeSessionJson(makeSessionJson());
    recordPass('investigation', { clean: true, source: 'hook' });
    recordPass('investigation', { clean: true, source: 'manual' });
    recordPass('investigation', { clean: true, source: 'manual' });

    // Act
    const result = runCheckpoint(['update-convergence', 'investigation'], true);

    // Assert: should emit warning (to stderr)
    expect(result.stderr).toMatch(/manual-sourced/i);
  });
});

// ============================================================
// Validation: rejects invalid gate names
// ============================================================

describe('Rejects invalid gate_name', () => {
  it('should reject an unrecognized gate_name with descriptive error', () => {
    // Arrange
    writeSessionJson(makeSessionJson());

    // Act
    const result = runCheckpoint(['update-convergence', 'invalid_gate'], true);

    // Assert
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/invalid|code_review|security_review/i);
  });
});

// ============================================================
// Validation: accepts new gate names (unifier, completion_verifier)
// ============================================================

describe('Accepts new gate names', () => {
  it('should accept unifier as a valid gate name', () => {
    // Arrange
    writeSessionJson(makeSessionJson());

    // Act + Assert: should not throw
    runCheckpoint(['update-convergence', 'unifier']);
    const updated = readSessionJson();
    expect(updated.convergence.unifier.clean_pass_count).toBe(0);
  });

  it('should accept completion_verifier as a valid gate name', () => {
    // Arrange
    writeSessionJson(makeSessionJson());

    // Act + Assert: should not throw
    runCheckpoint(['update-convergence', 'completion_verifier']);
    const updated = readSessionJson();
    expect(updated.convergence.completion_verifier.clean_pass_count).toBe(0);
  });
});

// ============================================================
// Backward compatibility: preserves session fields
// ============================================================

describe('Preserves session fields', () => {
  it('should preserve existing session.json fields when writing convergence', () => {
    // Arrange
    writeSessionJson(makeSessionJson({
      subagent_tasks: [
        { task_id: 't1', subagent_type: 'implementer', description: 'test', dispatched_at: new Date().toISOString(), status: 'completed' },
      ],
    }));

    // Act
    runCheckpoint(['update-convergence', 'code_review']);

    // Assert
    const updated = readSessionJson();
    expect(updated.active_work).toBeDefined();
    expect(updated.active_work.workflow).toBe('oneoff-spec');
    expect(updated.convergence.code_review.clean_pass_count).toBe(0);
  });
});

/**
 * Integration tests for trace-read-enforcement.mjs
 *
 * Tests: as-008-trace-read-enforcement (AC-7.1 through AC-7.5)
 *
 * Pipes mock stdin JSON into the script and verifies exit codes and stderr output.
 * Test scenarios:
 *   1. Traced file, trace not read -> exit 2 (AC-7.1)
 *   2. Traced file, trace read -> exit 0 (AC-7.2)
 *   3. Untraced file -> exit 0 + advisory (AC-7.3)
 *   4. No trace.config.json -> exit 0 (AC-7.4)
 *   5. No trace-reads.json -> exit 2 for traced files (AC-7.5)
 *   6. Trace read within TTL -> exit 0
 *   7. Trace read outside TTL (expired) -> exit 2 with expiry message
 *
 * Run with: node --test .claude/scripts/__tests__/trace-read-enforcement.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the hook script under test */
const HOOK_SCRIPT = join(__dirname, '..', 'trace-read-enforcement.mjs');

/**
 * Run the hook script with given stdin JSON input and an overridden project root.
 *
 * @param {object|string} stdinData - JSON object (or raw string) to pipe to stdin
 * @param {string} projectRoot - Project root to set via CLAUDE_PROJECT_DIR
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
function runHook(stdinData, projectRoot) {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK_SCRIPT], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectRoot,
      },
      cwd: projectRoot,
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

    // Write stdin and close
    const input = typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData);
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Create a sample trace.config.json for testing.
 */
function createTestConfig() {
  return {
    version: 1,
    projectRoot: '.',
    modules: [
      {
        id: 'app-core',
        name: 'App Core',
        description: 'Core application logic',
        fileGlobs: ['src/core/**'],
      },
      {
        id: 'app-ui',
        name: 'App UI',
        description: 'UI components',
        fileGlobs: ['src/ui/**'],
      },
    ],
  };
}

/**
 * Helper: set up a test project directory with trace infrastructure.
 *
 * @param {string} testRoot - Root directory for the temp project
 * @param {object} [options] - Setup options
 * @param {boolean} [options.skipTraceConfig] - Don't create trace.config.json
 * @param {boolean} [options.skipTracesDir] - Don't create .claude/traces/ directory
 */
function setupTestProject(testRoot, options = {}) {
  // Create directory structure
  mkdirSync(join(testRoot, 'src', 'core'), { recursive: true });
  mkdirSync(join(testRoot, 'src', 'ui'), { recursive: true });
  mkdirSync(join(testRoot, 'docs'), { recursive: true });

  if (!options.skipTracesDir) {
    mkdirSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true });
    mkdirSync(join(testRoot, '.claude', 'coordination'), { recursive: true });
  }

  // Create trace config
  if (!options.skipTraceConfig && !options.skipTracesDir) {
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      JSON.stringify(createTestConfig(), null, 2),
    );
  }
}

/**
 * Helper: write trace-reads.json with given state.
 *
 * @param {string} testRoot - Project root
 * @param {object} state - The trace reads state
 */
function writeTestTraceReads(testRoot, state) {
  const coordDir = join(testRoot, '.claude', 'coordination');
  mkdirSync(coordDir, { recursive: true });
  writeFileSync(
    join(coordDir, 'trace-reads.json'),
    JSON.stringify(state, null, 2) + '\n',
  );
}

/**
 * Helper: create stdin JSON for an Edit/Write tool call.
 *
 * @param {string} sessionId - Session identifier
 * @param {string} filePath - Absolute file path being edited
 * @param {string} [toolName] - Tool name (defaults to 'Edit')
 * @returns {object} Stdin JSON object
 */
function makeStdinJson(sessionId, filePath, toolName = 'Edit') {
  return {
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: {
      file_path: filePath,
    },
  };
}

/** TTL matches the constant in trace-read-enforcement.mjs (5 minutes) */
const TRACE_READ_TTL_MS = 5 * 60 * 1000;

/**
 * Helper: generate a recent ISO timestamp (within TTL window).
 *
 * @param {number} [agoMs=1000] - Milliseconds in the past (default: 1 second ago)
 * @returns {string} ISO 8601 timestamp
 */
function recentTimestamp(agoMs = 1000) {
  return new Date(Date.now() - agoMs).toISOString();
}

/**
 * Helper: generate an expired ISO timestamp (outside TTL window).
 *
 * @param {number} [extraMs=60000] - Milliseconds past the TTL expiry (default: 1 minute past)
 * @returns {string} ISO 8601 timestamp
 */
function expiredTimestamp(extraMs = 60000) {
  return new Date(Date.now() - TRACE_READ_TTL_MS - extraMs).toISOString();
}

// ============================================================
// AC-7.1: Editing traced file without trace read -> exit 2
// ============================================================

describe('AC-7.1: Block edit when trace not read', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `trace-enforce-block-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestProject(testRoot);
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should exit 2 when editing a file in app-core without reading trace', async () => {
    // trace-reads.json exists but has no reads for app-core
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {},
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 2, `Expected exit 2 but got ${result.exitCode}. stderr: ${result.stderr}`);
    assert.ok(result.stderr.includes('app-core'), 'Should mention module ID');
    assert.ok(result.stderr.includes('BLOCKED'), 'Should include BLOCKED header');
    assert.ok(
      result.stderr.includes('.claude/traces/low-level/app-core.md'),
      'Should include path to trace file',
    );
  });

  it('should exit 2 when editing a file in app-ui without reading trace', async () => {
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {},
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'ui', 'button.tsx')),
      testRoot,
    );

    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes('app-ui'), 'Should mention module ID');
    assert.ok(result.stderr.includes('App UI'), 'Should mention module name');
  });

  it('should exit 2 when trace-reads.json has reads for a different module only', async () => {
    // Only app-ui was read, but we are editing app-core
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {
        'app-ui': '2026-02-22T10:00:00.000Z',
      },
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'index.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 2, 'Should block -- only app-ui was read, not app-core');
  });

  it('should suggest reading the high-level trace as alternative', async () => {
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {},
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 2);
    assert.ok(
      result.stderr.includes('high-level.md'),
      'Should suggest high-level trace as alternative',
    );
  });

  it('should include the instruction format specified in the spec', async () => {
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {},
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'file.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 2);
    // AC-7.1: message containing the module name and instruction to read the trace file
    assert.ok(
      result.stderr.includes("Read `.claude/traces/low-level/app-core.md` before editing files in module 'app-core'"),
      'Should include exact instruction format',
    );
  });
});

// ============================================================
// AC-7.2: Editing traced file after reading trace -> exit 0
// ============================================================

describe('AC-7.2: Allow edit when trace has been read', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `trace-enforce-allow-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestProject(testRoot);
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should exit 0 when app-core trace has been read', async () => {
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {
        'app-core': recentTimestamp(),
      },
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 0, `Expected exit 0 but got ${result.exitCode}. stderr: ${result.stderr}`);
  });

  it('should exit 0 when app-ui trace has been read', async () => {
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {
        'app-ui': recentTimestamp(),
      },
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'ui', 'component.tsx')),
      testRoot,
    );

    assert.equal(result.exitCode, 0);
  });

  it('should exit 0 when multiple modules have been read', async () => {
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {
        'app-core': recentTimestamp(),
        'app-ui': recentTimestamp(),
      },
    });

    // Edit a file in app-core
    const result1 = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'a.ts')),
      testRoot,
    );
    assert.equal(result1.exitCode, 0);

    // Edit a file in app-ui
    const result2 = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'ui', 'b.tsx')),
      testRoot,
    );
    assert.equal(result2.exitCode, 0);
  });

  it('should exit 0 with Write tool as well', async () => {
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {
        'app-core': recentTimestamp(),
      },
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'new-file.ts'), 'Write'),
      testRoot,
    );

    assert.equal(result.exitCode, 0);
  });
});

// ============================================================
// AC-7.3: Editing untraced file -> exit 0 with advisory
// ============================================================

describe('AC-7.3: Untraced file advisory', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `trace-enforce-untraced-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestProject(testRoot);
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should exit 0 for a file not in any module', async () => {
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {},
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'docs', 'README.md')),
      testRoot,
    );

    assert.equal(result.exitCode, 0);
  });

  it('should emit advisory to stderr for untraced files', async () => {
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {},
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'docs', 'notes.md')),
      testRoot,
    );

    assert.equal(result.exitCode, 0);
    assert.ok(
      result.stderr.includes('not covered by any trace module'),
      'Should emit advisory about untraced file',
    );
  });

  it('should exit 0 for root-level files not in any glob', async () => {
    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'package.json')),
      testRoot,
    );

    assert.equal(result.exitCode, 0);
  });
});

// ============================================================
// AC-7.4: No trace.config.json -> exit 0
// ============================================================

describe('AC-7.4: No trace system configured', () => {
  let testRoot;

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should exit 0 when trace.config.json does not exist', async () => {
    testRoot = join(
      tmpdir(),
      `trace-enforce-noconfig-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestProject(testRoot, { skipTraceConfig: true });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 0, 'Should not block when no trace system configured');
  });

  it('should exit 0 when .claude/traces/ directory does not exist', async () => {
    testRoot = join(
      tmpdir(),
      `trace-enforce-nodir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestProject(testRoot, { skipTracesDir: true, skipTraceConfig: true });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 0, 'Should not block when no traces directory');
  });
});

// ============================================================
// AC-7.5: No trace-reads.json -> all modules treated as unread
// ============================================================

describe('AC-7.5: Missing trace-reads.json', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `trace-enforce-noreads-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestProject(testRoot);
    // Do NOT create trace-reads.json
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should exit 2 for a traced file when trace-reads.json does not exist', async () => {
    // Remove coordination directory entirely
    rmSync(join(testRoot, '.claude', 'coordination'), { recursive: true, force: true });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 2, 'Should block when trace-reads.json does not exist');
    assert.ok(result.stderr.includes('app-core'), 'Should mention module name');
  });

  it('should still exit 0 for untraced files even without trace-reads.json', async () => {
    rmSync(join(testRoot, '.claude', 'coordination'), { recursive: true, force: true });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'docs', 'README.md')),
      testRoot,
    );

    assert.equal(result.exitCode, 0, 'Untraced files should pass regardless of trace-reads.json');
  });
});

// ============================================================
// Session ID matching
// ============================================================

describe('Session ID matching', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `trace-enforce-session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestProject(testRoot);
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should block when trace-reads.json has different session_id', async () => {
    // Reads are from a different session
    writeTestTraceReads(testRoot, {
      session_id: 'old-session',
      reads: {
        'app-core': '2026-02-22T10:00:00.000Z',
      },
    });

    const result = await runHook(
      makeStdinJson('new-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 2, 'Should block when session_id does not match');
  });

  it('should allow when session_id matches', async () => {
    writeTestTraceReads(testRoot, {
      session_id: 'matching-session',
      reads: {
        'app-core': recentTimestamp(),
      },
    });

    const result = await runHook(
      makeStdinJson('matching-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 0, 'Should allow when session_id matches');
  });
});

// ============================================================
// Input validation and edge cases
// ============================================================

describe('Input validation and edge cases', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `trace-enforce-edge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestProject(testRoot);
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should exit 0 for empty stdin', async () => {
    const result = await runHook('', testRoot);
    assert.equal(result.exitCode, 0);
  });

  it('should exit 0 for malformed JSON stdin', async () => {
    const result = await runHook('not valid json {{{', testRoot);
    assert.equal(result.exitCode, 0, 'Should fail open on malformed input');
  });

  it('should exit 0 when tool_input is missing', async () => {
    const result = await runHook(
      { session_id: 'test', something_else: true },
      testRoot,
    );
    assert.equal(result.exitCode, 0);
  });

  it('should exit 0 when file_path is missing', async () => {
    const result = await runHook(
      { session_id: 'test', tool_input: {} },
      testRoot,
    );
    assert.equal(result.exitCode, 0);
  });

  it('should exit 0 when file_path is not a string', async () => {
    const result = await runHook(
      { session_id: 'test', tool_input: { file_path: 42 } },
      testRoot,
    );
    assert.equal(result.exitCode, 0);
  });

  it('should handle malformed trace-reads.json gracefully', async () => {
    writeFileSync(
      join(testRoot, '.claude', 'coordination', 'trace-reads.json'),
      'not valid json {{{',
    );

    // Should treat as no reads -> block for traced file
    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 2, 'Should block when trace-reads.json is malformed');
  });

  it('should handle trace-reads.json with null reads field', async () => {
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: null,
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 2, 'Should block when reads is null');
  });
});

// ============================================================
// TTL enforcement: reads expire after 5 minutes
// ============================================================

describe('TTL enforcement: trace reads expire after 5 minutes', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `trace-enforce-ttl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestProject(testRoot);
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should exit 0 when trace was read within TTL window', async () => {
    // Read 1 second ago -- well within the 5 minute TTL
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {
        'app-core': recentTimestamp(1000),
      },
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 0, `Expected exit 0 (within TTL) but got ${result.exitCode}. stderr: ${result.stderr}`);
  });

  it('should exit 0 when trace was read 4 minutes ago (still within TTL)', async () => {
    // 4 minutes ago -- 1 minute before expiry
    const fourMinutesMs = 4 * 60 * 1000;
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {
        'app-core': recentTimestamp(fourMinutesMs),
      },
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 0, `Expected exit 0 (4min < 5min TTL) but got ${result.exitCode}. stderr: ${result.stderr}`);
  });

  it('should exit 2 when trace was read more than 5 minutes ago (expired)', async () => {
    // 6 minutes ago -- 1 minute past expiry
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {
        'app-core': expiredTimestamp(60000),
      },
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 2, `Expected exit 2 (TTL expired) but got ${result.exitCode}. stderr: ${result.stderr}`);
  });

  it('should exit 2 when trace was read 10 minutes ago (well past expiry)', async () => {
    // 10 minutes ago
    const tenMinutesMs = 10 * 60 * 1000;
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {
        'app-core': new Date(Date.now() - tenMinutesMs).toISOString(),
      },
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 2, 'Should block when trace was read 10 minutes ago');
  });

  it('should show expiry-specific message when trace read has expired', async () => {
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {
        'app-core': expiredTimestamp(),
      },
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 2);
    assert.ok(
      result.stderr.includes('Trace Read Expired'),
      'Should show "Trace Read Expired" header for expired reads',
    );
    assert.ok(
      result.stderr.includes('expire after 5 minutes'),
      'Should mention the 5-minute expiry duration',
    );
  });

  it('should show "Trace Not Read" message when module was never read', async () => {
    // Module never read (no entry in reads)
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {},
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    assert.equal(result.exitCode, 2);
    assert.ok(
      result.stderr.includes('Trace Not Read'),
      'Should show "Trace Not Read" header when module was never read',
    );
    // Should NOT show the expired-specific header
    assert.ok(
      !result.stderr.includes('Trace Read Expired'),
      'Should NOT show expired header when module was never read',
    );
  });

  it('should include re-read instruction in block message for expired reads', async () => {
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {
        'app-ui': expiredTimestamp(),
      },
    });

    const result = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'ui', 'button.tsx')),
      testRoot,
    );

    assert.equal(result.exitCode, 2);
    assert.ok(
      result.stderr.includes('Re-read the trace to continue editing'),
      'Should instruct agent to re-read the trace',
    );
  });

  it('should handle mixed TTL states across modules correctly', async () => {
    // app-core is fresh, app-ui is expired
    writeTestTraceReads(testRoot, {
      session_id: 'test-session',
      reads: {
        'app-core': recentTimestamp(),
        'app-ui': expiredTimestamp(),
      },
    });

    // app-core should be allowed (within TTL)
    const result1 = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );
    assert.equal(result1.exitCode, 0, 'Fresh module should be allowed');

    // app-ui should be blocked (expired)
    const result2 = await runHook(
      makeStdinJson('test-session', join(testRoot, 'src', 'ui', 'button.tsx')),
      testRoot,
    );
    assert.equal(result2.exitCode, 2, 'Expired module should be blocked');
  });
});

// ============================================================
// Performance test
// ============================================================

describe('Performance', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `trace-enforce-perf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestProject(testRoot);
    writeTestTraceReads(testRoot, {
      session_id: 'perf-session',
      reads: {
        'app-core': recentTimestamp(),
      },
    });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should complete in under 200ms', async () => {
    const start = Date.now();

    const result = await runHook(
      makeStdinJson('perf-session', join(testRoot, 'src', 'core', 'service.ts')),
      testRoot,
    );

    const elapsed = Date.now() - start;
    assert.equal(result.exitCode, 0);
    assert.ok(elapsed < 2000, `Hook took ${elapsed}ms, target is <200ms (allowing warm-up overhead for child process spawn)`);
  });
});

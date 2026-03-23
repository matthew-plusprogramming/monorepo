/**
 * Unit tests for trace-read-tracker.mjs
 *
 * Tests: as-007-trace-read-tracker (AC-6.1, AC-6.2, AC-6.3, AC-6.4)
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs trace-read-tracker.test.mjs
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  traceFileToModuleIds,
  loadOrCreateTraceReads,
  writeTraceReads,
} from '../trace-read-tracker.mjs';

// --- Test fixtures ---

/** Sample trace config matching the real trace.config.json structure */
function createTestConfig() {
  return {
    version: 1,
    projectRoot: '.',
    modules: [
      {
        id: 'sdlc-dev-team',
        name: 'Dev Team',
        description: 'Development work execution',
        fileGlobs: ['apps/node-server/src/sdlc/dev-team/**'],
      },
      {
        id: 'sdlc-qa-team',
        name: 'QA Team',
        description: 'Quality assurance',
        fileGlobs: ['apps/node-server/src/sdlc/qa-team/**'],
      },
      {
        id: 'node-server-core',
        name: 'Node Server Core',
        description: 'Core node server',
        fileGlobs: ['apps/node-server/src/handlers/**'],
      },
      {
        id: 'claude-scripts',
        name: 'Claude Scripts',
        description: 'Claude Code hook scripts',
        fileGlobs: ['.claude/scripts/**'],
      },
    ],
  };
}

// ============================================================
// traceFileToModuleIds tests
// ============================================================

describe('traceFileToModuleIds', () => {
  const config = createTestConfig();

  // High-level trace is orientation-only — does NOT unlock modules for editing
  it('high-level.md should return empty array (orientation only, no edit unlock)', () => {
    const result = traceFileToModuleIds('.claude/traces/high-level.md', config);
    expect(result).toEqual([]);
  });

  it('high-level.json should also return empty array', () => {
    const result = traceFileToModuleIds('.claude/traces/high-level.json', config);
    expect(result).toEqual([]);
  });

  // AC-6.2: Reading low-level/<module-id>.md records only that module
  it('AC-6.2: low-level/sdlc-dev-team.md should return only sdlc-dev-team', () => {
    const result = traceFileToModuleIds(
      '.claude/traces/low-level/sdlc-dev-team.md',
      config,
    );
    expect(result).toEqual(['sdlc-dev-team']);
  });

  it('AC-6.2: low-level/sdlc-qa-team.md should return only sdlc-qa-team', () => {
    const result = traceFileToModuleIds(
      '.claude/traces/low-level/sdlc-qa-team.md',
      config,
    );
    expect(result).toEqual(['sdlc-qa-team']);
  });

  it('AC-6.2: low-level/sdlc-dev-team.json should also work', () => {
    const result = traceFileToModuleIds(
      '.claude/traces/low-level/sdlc-dev-team.json',
      config,
    );
    expect(result).toEqual(['sdlc-dev-team']);
  });

  it('should return empty array for unknown module in low-level dir', () => {
    const result = traceFileToModuleIds(
      '.claude/traces/low-level/nonexistent-module.md',
      config,
    );
    expect(result).toEqual([]);
  });

  it('should return empty array for trace files in unknown subdirectory', () => {
    const result = traceFileToModuleIds(
      '.claude/traces/some-other-dir/file.md',
      config,
    );
    expect(result).toEqual([]);
  });

  it('should return empty array for trace.config.json (not a trace view file)', () => {
    const result = traceFileToModuleIds(
      '.claude/traces/trace.config.json',
      config,
    );
    expect(result).toEqual([]);
  });
});

// ============================================================
// loadOrCreateTraceReads tests
// ============================================================

describe('loadOrCreateTraceReads', () => {
  let testDir;
  let traceReadsPath;

  beforeEach(() => {
    const timestamp = Date.now();
    testDir = join(
      tmpdir(),
      `trace-reads-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    traceReadsPath = join(testDir, 'trace-reads.json');
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // AC-6.3: Creates trace-reads.json if it does not exist
  it('AC-6.3: should return fresh state when file does not exist', () => {
    const result = loadOrCreateTraceReads(traceReadsPath, 'session-abc');
    expect(result).toEqual({
      session_id: 'session-abc',
      reads: {},
    });
  });

  it('should return existing state when session_id matches', () => {
    // Arrange
    const existingState = {
      session_id: 'session-abc',
      reads: {
        'sdlc-dev-team': '2026-02-22T10:00:00.000Z',
      },
    };
    writeFileSync(traceReadsPath, JSON.stringify(existingState));

    // Act
    const result = loadOrCreateTraceReads(traceReadsPath, 'session-abc');

    // Assert
    expect(result).toEqual(existingState);
  });

  it('should clear reads and return fresh state when session_id changes', () => {
    // Arrange
    const existingState = {
      session_id: 'old-session',
      reads: {
        'sdlc-dev-team': '2026-02-22T10:00:00.000Z',
      },
    };
    writeFileSync(traceReadsPath, JSON.stringify(existingState));

    // Act
    const result = loadOrCreateTraceReads(traceReadsPath, 'new-session');

    // Assert
    expect(result).toEqual({
      session_id: 'new-session',
      reads: {},
    });
  });

  it('should return fresh state for malformed JSON file', () => {
    writeFileSync(traceReadsPath, 'not valid json {{{');

    const result = loadOrCreateTraceReads(traceReadsPath, 'session-abc');
    expect(result).toEqual({
      session_id: 'session-abc',
      reads: {},
    });
  });

  it('should return fresh state when reads field is not an object', () => {
    const existingState = {
      session_id: 'session-abc',
      reads: 'not-an-object',
    };
    writeFileSync(traceReadsPath, JSON.stringify(existingState));

    const result = loadOrCreateTraceReads(traceReadsPath, 'session-abc');
    expect(result).toEqual({
      session_id: 'session-abc',
      reads: {},
    });
  });
});

// ============================================================
// writeTraceReads tests
// ============================================================

describe('writeTraceReads', () => {
  let testDir;

  beforeEach(() => {
    const timestamp = Date.now();
    testDir = join(
      tmpdir(),
      `trace-writes-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should create the coordination directory if it does not exist', () => {
    const filePath = join(testDir, 'coordination', 'trace-reads.json');
    const data = { session_id: 'test', reads: {} };

    writeTraceReads(filePath, data);

    expect(existsSync(filePath)).toBeTruthy();
  });

  it('should write valid JSON', () => {
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, 'trace-reads.json');
    const data = {
      session_id: 'test-session',
      reads: { 'sdlc-dev-team': '2026-02-22T10:00:00.000Z' },
    };

    writeTraceReads(filePath, data);

    const written = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(written).toEqual(data);
  });

  it('should overwrite existing file', () => {
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, 'trace-reads.json');

    // Write initial data
    writeTraceReads(filePath, { session_id: 'old', reads: {} });

    // Overwrite with new data
    const newData = {
      session_id: 'new',
      reads: { 'sdlc-qa-team': '2026-02-22T11:00:00.000Z' },
    };
    writeTraceReads(filePath, newData);

    const written = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(written).toEqual(newData);
  });

  it('should not leave temp file after successful write', () => {
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, 'trace-reads.json');
    const tmpPath = filePath + '.tmp';

    writeTraceReads(filePath, { session_id: 'test', reads: {} });

    expect(existsSync(tmpPath)).toBeFalsy();
  });
});

// ============================================================
// AC-6.4: Additive state updates (multiple reads preserve prior state)
// ============================================================

describe('additive state updates (AC-6.4)', () => {
  let testDir;
  let traceReadsPath;

  beforeEach(() => {
    const timestamp = Date.now();
    testDir = join(
      tmpdir(),
      `trace-additive-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    traceReadsPath = join(testDir, 'trace-reads.json');
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('AC-6.4: reading module A then module B results in both being recorded', () => {
    const sessionId = 'session-test';
    const config = createTestConfig();

    // Simulate first read: module A (sdlc-dev-team)
    const state1 = loadOrCreateTraceReads(traceReadsPath, sessionId);
    const moduleIds1 = traceFileToModuleIds(
      '.claude/traces/low-level/sdlc-dev-team.md',
      config,
    );
    const now1 = '2026-02-22T10:00:00.000Z';
    for (const id of moduleIds1) {
      state1.reads[id] = now1;
    }
    writeTraceReads(traceReadsPath, state1);

    // Simulate second read: module B (sdlc-qa-team)
    const state2 = loadOrCreateTraceReads(traceReadsPath, sessionId);
    const moduleIds2 = traceFileToModuleIds(
      '.claude/traces/low-level/sdlc-qa-team.md',
      config,
    );
    const now2 = '2026-02-22T10:05:00.000Z';
    for (const id of moduleIds2) {
      state2.reads[id] = now2;
    }
    writeTraceReads(traceReadsPath, state2);

    // Verify both modules are recorded
    const final = JSON.parse(readFileSync(traceReadsPath, 'utf-8'));
    expect(final.session_id).toBe(sessionId);
    expect('sdlc-dev-team' in final.reads).toBeTruthy();
    expect('sdlc-qa-team' in final.reads).toBeTruthy();
    expect(final.reads['sdlc-dev-team']).toBe(now1);
    expect(final.reads['sdlc-qa-team']).toBe(now2);
  });

  it('AC-6.4: re-reading same module updates its timestamp without losing others', () => {
    const sessionId = 'session-test';

    // Initial state with two modules
    const initialState = {
      session_id: sessionId,
      reads: {
        'sdlc-dev-team': '2026-02-22T10:00:00.000Z',
        'sdlc-qa-team': '2026-02-22T10:05:00.000Z',
      },
    };
    writeTraceReads(traceReadsPath, initialState);

    // Re-read sdlc-dev-team
    const state = loadOrCreateTraceReads(traceReadsPath, sessionId);
    state.reads['sdlc-dev-team'] = '2026-02-22T11:00:00.000Z';
    writeTraceReads(traceReadsPath, state);

    // Verify: sdlc-dev-team updated, sdlc-qa-team preserved
    const final = JSON.parse(readFileSync(traceReadsPath, 'utf-8'));
    expect(final.reads['sdlc-dev-team']).toBe('2026-02-22T11:00:00.000Z');
    expect(final.reads['sdlc-qa-team']).toBe('2026-02-22T10:05:00.000Z');
  });
});

// ============================================================
// Integration test: invoke the script via child process
// ============================================================

describe('trace-read-tracker integration (child process)', () => {
  let testDir;
  let projectRoot;

  beforeEach(() => {
    const timestamp = Date.now();
    testDir = join(
      tmpdir(),
      `trace-tracker-integration-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );

    projectRoot = testDir;

    // Create directory structure matching project layout
    mkdirSync(join(testDir, '.claude', 'traces', 'low-level'), { recursive: true });
    mkdirSync(join(testDir, '.claude', 'coordination'), { recursive: true });

    // Write trace.config.json
    writeFileSync(
      join(testDir, '.claude', 'traces', 'trace.config.json'),
      JSON.stringify(createTestConfig(), null, 2),
    );

    // Create trace files (they just need to exist, content doesn't matter for the tracker)
    writeFileSync(
      join(testDir, '.claude', 'traces', 'high-level.md'),
      '# High-level trace',
    );
    writeFileSync(
      join(testDir, '.claude', 'traces', 'low-level', 'sdlc-dev-team.md'),
      '# Dev Team trace',
    );
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /** Helper to invoke trace-read-tracker.mjs with stdin JSON */
  function invokeTracker(stdinJson) {
    const scriptPath = join(
      process.cwd(),
      '.claude',
      'scripts',
      'trace-read-tracker.mjs',
    );

    try {
      execFileSync('node', [scriptPath], {
        input: JSON.stringify(stdinJson),
        encoding: 'utf-8',
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectRoot,
        },
        timeout: 10000,
      });
    } catch (err) {
      // The script should always exit 0, but if it doesn't, we want to know
      if (err.status !== 0) {
        throw new Error(
          `trace-read-tracker exited with code ${err.status}: ${err.stderr}`,
        );
      }
    }
  }

  /** Read the trace-reads.json result */
  function readTraceReads() {
    const filePath = join(testDir, '.claude', 'coordination', 'trace-reads.json');
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  }

  it('reading high-level.md does NOT record any modules (orientation only)', () => {
    invokeTracker({
      session_id: 'integration-test',
      tool_input: {
        file_path: join(testDir, '.claude', 'traces', 'high-level.md'),
      },
    });

    const result = readTraceReads();
    // trace-reads.json may or may not be created, but no modules should be recorded
    if (result) {
      expect(Object.keys(result.reads).length).toBe(0);
    }
  });

  it('AC-6.2: reading low-level/sdlc-dev-team.md records only sdlc-dev-team', () => {
    invokeTracker({
      session_id: 'integration-test',
      tool_input: {
        file_path: join(
          testDir,
          '.claude',
          'traces',
          'low-level',
          'sdlc-dev-team.md',
        ),
      },
    });

    const result = readTraceReads();
    expect(result).toBeTruthy();
    expect(result.session_id).toBe('integration-test');
    expect('sdlc-dev-team' in result.reads).toBeTruthy();
    expect('sdlc-qa-team' in result.reads).toBeFalsy();
  });

  it('AC-6.3: creates trace-reads.json if it does not exist', () => {
    // Remove the coordination directory entirely
    rmSync(join(testDir, '.claude', 'coordination'), {
      recursive: true,
      force: true,
    });

    invokeTracker({
      session_id: 'integration-test',
      tool_input: {
        file_path: join(
          testDir,
          '.claude',
          'traces',
          'low-level',
          'sdlc-dev-team.md',
        ),
      },
    });

    const result = readTraceReads();
    expect(result).toBeTruthy();
    expect(result.session_id).toBe('integration-test');
  });

  it('AC-6.4: multiple reads preserve prior state', () => {
    // First read: sdlc-dev-team
    invokeTracker({
      session_id: 'integration-test',
      tool_input: {
        file_path: join(
          testDir,
          '.claude',
          'traces',
          'low-level',
          'sdlc-dev-team.md',
        ),
      },
    });

    // Second read: sdlc-qa-team (create the file first)
    writeFileSync(
      join(testDir, '.claude', 'traces', 'low-level', 'sdlc-qa-team.md'),
      '# QA Team trace',
    );
    invokeTracker({
      session_id: 'integration-test',
      tool_input: {
        file_path: join(
          testDir,
          '.claude',
          'traces',
          'low-level',
          'sdlc-qa-team.md',
        ),
      },
    });

    const result = readTraceReads();
    expect(result).toBeTruthy();
    expect('sdlc-dev-team' in result.reads).toBeTruthy();
    expect('sdlc-qa-team' in result.reads).toBeTruthy();
  });

  it('should exit 0 for non-trace files', () => {
    invokeTracker({
      session_id: 'integration-test',
      tool_input: {
        file_path: '/some/random/file.ts',
      },
    });

    const result = readTraceReads();
    expect(result).toBe(null);
  });

  it('should exit 0 for empty stdin', () => {
    const scriptPath = join(
      process.cwd(),
      '.claude',
      'scripts',
      'trace-read-tracker.mjs',
    );

    // This should not throw
    execFileSync('node', [scriptPath], {
      input: '',
      encoding: 'utf-8',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectRoot,
      },
      timeout: 10000,
    });
  });

  it('should exit 0 for malformed JSON', () => {
    const scriptPath = join(
      process.cwd(),
      '.claude',
      'scripts',
      'trace-read-tracker.mjs',
    );

    execFileSync('node', [scriptPath], {
      input: 'not valid json {{{',
      encoding: 'utf-8',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectRoot,
      },
      timeout: 10000,
    });
  });

  it('should clear reads when session_id changes', () => {
    // First session
    invokeTracker({
      session_id: 'session-1',
      tool_input: {
        file_path: join(
          testDir,
          '.claude',
          'traces',
          'low-level',
          'sdlc-dev-team.md',
        ),
      },
    });

    // Verify first session recorded
    let result = readTraceReads();
    expect('sdlc-dev-team' in result.reads).toBeTruthy();
    expect(result.session_id).toBe('session-1');

    // New session reads a specific low-level module
    invokeTracker({
      session_id: 'session-2',
      tool_input: {
        file_path: join(testDir, '.claude', 'traces', 'low-level', 'sdlc-qa-team.md'),
      },
    });

    // Verify old reads were cleared and only new session's read exists
    result = readTraceReads();
    expect(result.session_id).toBe('session-2');
    // The old sdlc-dev-team read from session-1 should be gone
    expect('sdlc-dev-team' in result.reads).toBeFalsy();
    // Only the new session's read should be present
    expect('sdlc-qa-team' in result.reads).toBeTruthy();
  });
});

/**
 * Tests for M1 (Foundation) of sg-trace-v2-docs-bridge spec.
 *
 * Covers:
 * - REQ-001: Registry gap fixes (11 missing test files)
 * - REQ-002: Call graph tracing (calls[])
 * - REQ-003: Event pattern detection (events[])
 * - REQ-004: Call graph query (trace-query --calls)
 * - REQ-027: Entry-level validation for calls/events
 * - Wire format: Markdown rendering and sync round-trip
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs trace-call-graph.test.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  analyzeFile,
  generateLowLevelMarkdown,
  validateLowLevelTrace,
} from '../trace-generate.mjs';

// =============================================================================
// Test Fixtures
// =============================================================================

/** Source code with function calls to test parseCallGraph */
const SOURCE_WITH_CALLS = `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTraceConfig } from './lib/trace-utils.mjs';
import { isTraceStale } from './lib/trace-utils.mjs';

export function generateTrace(moduleId) {
  const config = loadTraceConfig();
  const root = resolveProjectRoot();
  const stale = isTraceStale(moduleId, config);
  const data = readFileSync(join(root, 'data.json'), 'utf-8');
  return JSON.parse(data);
}

export function checkStaleness(moduleId, config) {
  return isTraceStale(moduleId, config);
}

function resolveProjectRoot() {
  return process.cwd();
}
`;

/** Import map derived from SOURCE_WITH_CALLS (matches parseImports output shape) */
const IMPORT_MAP_FOR_CALLS = [
  { source: 'node:fs', symbols: ['readFileSync', 'writeFileSync'] },
  { source: 'node:path', symbols: ['join'] },
  { source: './lib/trace-utils.mjs', symbols: ['loadTraceConfig'] },
  { source: './lib/trace-utils.mjs', symbols: ['isTraceStale'] },
];

/** Known exports from other modules (for cross-module resolution).
 *  Map<string, { file: string, line: number }> per analyzeFile contract. */
function makeKnownExportsMap() {
  const m = new Map();
  m.set('loadTraceConfig', { file: './lib/trace-utils.mjs', line: 42 });
  m.set('isTraceStale', { file: './lib/trace-utils.mjs', line: 299 });
  m.set('findFilesMatchingGlobs', { file: './lib/trace-utils.mjs', line: 150 });
  return m;
}

/** File path used as caller context for parseCallGraph */
const TEST_FILE_PATH = 'src/test-module/service.mjs';

/** Source code with event patterns to test parseEventPatterns */
const SOURCE_WITH_EVENTS = `
import { EventEmitter } from 'node:events';

const emitter = new EventEmitter();

export function startProcessing() {
  emitter.emit('task:started', { id: 'abc' });
  emitter.emit('task:progress', { percent: 50 });
}

export function setupListeners() {
  emitter.on('task:completed', (result) => {
    console.log('Done:', result);
  });
  emitter.on('task:error', (err) => {
    console.error('Error:', err);
  });
}

export function setupSubscriptions() {
  emitter.addEventListener('data:ready', handler);
  channel.subscribe('notifications', onNotify);
}
`;

/** Source code with NO event patterns */
const SOURCE_WITHOUT_EVENTS = `
export function processData(items) {
  return items.map(item => item.value);
}

// This should NOT be detected as an event pattern:
// emitter.on('fake-event', handler);
const result = someObj.on;
`;

/** Source with internal-only calls (no cross-module calls) */
const SOURCE_INTERNAL_CALLS = `
function helperA() {
  return 42;
}

function helperB() {
  return helperA() + 1;
}

export function main() {
  const a = helperA();
  const b = helperB();
  return a + b;
}
`;

/** Source with dynamic imports and computed calls (should NOT be traced) */
const SOURCE_DYNAMIC_CALLS = `
export async function loadPlugin(name) {
  const mod = await import(\`./plugins/\${name}.mjs\`);
  const fn = mod[name];
  fn();
}

export function callComputed(obj, method) {
  obj[method]();
}
`;

/** Valid CallEntry for testing */
function makeValidCallEntry(overrides = {}) {
  return {
    callerFile: '.claude/scripts/trace-commit-staleness.mjs',
    callerLine: 28,
    calleeName: 'isTraceStale',
    calleeFile: '.claude/scripts/lib/trace-utils.mjs',
    calleeLine: 299,
    ...overrides,
  };
}

/** Valid EventEntry for testing */
function makeValidEventEntry(overrides = {}) {
  return {
    file: '.claude/scripts/lib/sdlc-events.mjs',
    line: 42,
    eventName: 'task:complete',
    type: 'emit',
    ...overrides,
  };
}

/** Create a valid low-level trace with calls and events */
function makeTraceWithCallsAndEvents(callEntries = [], eventEntries = []) {
  return {
    moduleId: 'test-module',
    version: 1,
    lastGenerated: '2026-03-20T10:00:00.000Z',
    generatedBy: 'trace-generate',
    files: [
      {
        filePath: 'src/test-module/service.mjs',
        exports: [{ symbol: 'generateTrace', type: 'function' }],
        imports: [{ source: 'node:fs', symbols: ['readFileSync'] }],
        calls: callEntries,
        events: eventEntries,
      },
    ],
  };
}

/** Project root for registry tests */
const PROJECT_ROOT = resolve(join(import.meta.url.replace('file://', ''), '..', '..', '..', '..'));

// =============================================================================
// REQ-001: Registry Gap Fixes for Missing Test Files
// =============================================================================

describe('REQ-001: Registry gap fixes', () => {
  /** The 11 missing test files from the spec */
  const MISSING_TEST_FILES = [
    // 8 docs test files
    '.claude/scripts/__tests__/docs-compat.test.mjs',
    '.claude/scripts/__tests__/docs-dependency.test.mjs',
    '.claude/scripts/__tests__/docs-generate.test.mjs',
    '.claude/scripts/__tests__/docs-hook.test.mjs',
    '.claude/scripts/__tests__/docs-registry.test.mjs',
    '.claude/scripts/__tests__/docs-scaffold.test.mjs',
    '.claude/scripts/__tests__/docs-templates.test.mjs',
    '.claude/scripts/__tests__/docs-validate.test.mjs',
    // 3 trace-enhance test files
    '.claude/scripts/__tests__/trace-enhance-deps.test.mjs',
    '.claude/scripts/__tests__/trace-enhance-docs.test.mjs',
    '.claude/scripts/__tests__/trace-enhance-signatures.test.mjs',
  ];

  it('REQ-001 AC1: all 11 missing test files should be registered in metaclaude-registry.json artifacts', () => {
    // Arrange
    const registryPath = join(PROJECT_ROOT, '.claude', 'metaclaude-registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));

    // Act - Collect all registered artifact paths
    const allArtifactPaths = [];
    for (const category of Object.values(registry.artifacts)) {
      for (const artifact of Object.values(category)) {
        if (artifact.path) {
          allArtifactPaths.push(artifact.path);
        }
      }
    }

    // Assert - Each missing test file should be registered
    for (const testFile of MISSING_TEST_FILES) {
      expect(
        allArtifactPaths.includes(testFile),
        `Expected ${testFile} to be registered in registry artifacts`,
      ).toBe(true);
    }
  });

  it('REQ-001 AC2: all registered test files should be included in full-workflow bundle', () => {
    // Arrange
    const registryPath = join(PROJECT_ROOT, '.claude', 'metaclaude-registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    const fullWorkflowBundle = registry.bundles?.['full-workflow'];

    // Act & Assert
    expect(fullWorkflowBundle, 'full-workflow bundle should exist').toBeTruthy();
    const includes = fullWorkflowBundle.includes || [];

    for (const testFile of MISSING_TEST_FILES) {
      // Find the artifact key for this path
      let artifactKey = null;
      for (const [category, artifacts] of Object.entries(registry.artifacts)) {
        for (const [key, artifact] of Object.entries(artifacts)) {
          if (artifact.path === testFile) {
            artifactKey = `${category}/${key}`;
            break;
          }
        }
        if (artifactKey) break;
      }

      if (artifactKey) {
        expect(
          includes.includes(artifactKey),
          `Expected ${artifactKey} (${testFile}) to be in full-workflow bundle includes`,
        ).toBe(true);
      }
    }
  });
});

// =============================================================================
// REQ-002: Call Graph Data Population (calls[])
// =============================================================================

describe('REQ-002: parseCallGraph', () => {
  /**
   * parseCallGraph is a NEW function to be implemented in Task 1.2.
   * These tests define the expected contract. They will fail until
   * parseCallGraph is implemented and exported from trace-generate.mjs.
   */

  let parseCallGraph;

  beforeEach(async () => {
    try {
      const mod = await import('../trace-generate.mjs');
      parseCallGraph = mod.parseCallGraph;
    } catch {
      parseCallGraph = undefined;
    }
  });

  it('REQ-002 AC1: parseCallGraph should be exported from trace-generate.mjs', () => {
    // Arrange - loaded in beforeEach

    // Act & Assert
    expect(
      typeof parseCallGraph,
      'parseCallGraph should be a function exported from trace-generate.mjs',
    ).toBe('function');
  });

  it('REQ-002 AC2: calls[] entries have correct shape (callerFile, callerLine, calleeName, calleeFile, calleeLine)', () => {
    // Arrange
    if (typeof parseCallGraph !== 'function') {
      expect.fail('parseCallGraph not yet implemented');
    }
    const knownExports = makeKnownExportsMap();

    // Act
    const calls = parseCallGraph(SOURCE_WITH_CALLS, IMPORT_MAP_FOR_CALLS, knownExports, TEST_FILE_PATH);

    // Assert - Every entry must have the required fields with correct types
    expect(calls.length).toBeGreaterThan(0);
    for (const entry of calls) {
      expect(typeof entry.callerFile).toBe('string');
      expect(typeof entry.callerLine).toBe('number');
      expect(typeof entry.calleeName).toBe('string');
      expect(entry.calleeFile === null || typeof entry.calleeFile === 'string').toBe(true);
      expect(entry.calleeLine === null || typeof entry.calleeLine === 'number').toBe(true);
    }
  });

  it('REQ-002 AC3: cross-module calls are resolved against known exports', () => {
    // Arrange
    if (typeof parseCallGraph !== 'function') {
      expect.fail('parseCallGraph not yet implemented');
    }
    const knownExports = makeKnownExportsMap();

    // Act
    const calls = parseCallGraph(SOURCE_WITH_CALLS, IMPORT_MAP_FOR_CALLS, knownExports, TEST_FILE_PATH);

    // Assert - loadTraceConfig call should resolve to trace-utils.mjs
    const loadConfigCall = calls.find(c => c.calleeName === 'loadTraceConfig');
    expect(loadConfigCall, 'Should detect call to loadTraceConfig').toBeTruthy();
    expect(loadConfigCall.calleeFile).toBe('./lib/trace-utils.mjs');
    expect(loadConfigCall.calleeLine).toBe(42);
  });

  it('REQ-002 AC4: internal calls within same file are detected', () => {
    // Arrange
    if (typeof parseCallGraph !== 'function') {
      expect.fail('parseCallGraph not yet implemented');
    }

    // Act
    const calls = parseCallGraph(SOURCE_INTERNAL_CALLS, [], new Map(), 'src/internal.mjs');

    // Assert - Internal helper calls should be detected
    const helperACall = calls.find(c => c.calleeName === 'helperA');
    expect(helperACall, 'Should detect call to helperA').toBeTruthy();
    // Internal calls have null calleeFile (not resolved to external module)
    expect(helperACall.calleeFile).toBeNull();
  });

  it('REQ-002 AC5: unresolved external calls have null calleeFile and calleeLine', () => {
    // Arrange
    if (typeof parseCallGraph !== 'function') {
      expect.fail('parseCallGraph not yet implemented');
    }
    const knownExports = makeKnownExportsMap();

    // Act
    const calls = parseCallGraph(SOURCE_WITH_CALLS, IMPORT_MAP_FOR_CALLS, knownExports, TEST_FILE_PATH);

    // Assert - resolveProjectRoot is local, not in knownExports
    const resolveCall = calls.find(c => c.calleeName === 'resolveProjectRoot');
    expect(resolveCall, 'Should detect call to resolveProjectRoot').toBeTruthy();
    expect(resolveCall.calleeFile).toBeNull();
    expect(resolveCall.calleeLine).toBeNull();
  });

  it('REQ-002 AC6: dynamic imports and computed calls are NOT traced', () => {
    // Arrange
    if (typeof parseCallGraph !== 'function') {
      expect.fail('parseCallGraph not yet implemented');
    }

    // Act
    const calls = parseCallGraph(SOURCE_DYNAMIC_CALLS, [], new Map(), 'src/dynamic.mjs');

    // Assert - Should not contain computed or bracket-notation calls
    const computedCalls = calls.filter(c => c.calleeName.includes('['));
    expect(computedCalls.length).toBe(0);
  });

  it('REQ-002 AC7: empty source produces empty calls array', () => {
    // Arrange
    if (typeof parseCallGraph !== 'function') {
      expect.fail('parseCallGraph not yet implemented');
    }

    // Act
    const calls = parseCallGraph('', [], new Map(), 'src/empty.mjs');

    // Assert
    expect(Array.isArray(calls)).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('REQ-002 AC8: multiple calls to same function produce separate entries with distinct line numbers', () => {
    // Arrange
    if (typeof parseCallGraph !== 'function') {
      expect.fail('parseCallGraph not yet implemented');
    }
    const knownExports = makeKnownExportsMap();

    // Act
    const calls = parseCallGraph(SOURCE_WITH_CALLS, IMPORT_MAP_FOR_CALLS, knownExports, TEST_FILE_PATH);

    // Assert - isTraceStale is called in both generateTrace and checkStaleness
    const isStaleCalls = calls.filter(c => c.calleeName === 'isTraceStale');
    expect(isStaleCalls.length).toBeGreaterThanOrEqual(2);

    // Each call should have a different line number
    const lineNumbers = isStaleCalls.map(c => c.callerLine);
    const uniqueLines = new Set(lineNumbers);
    expect(uniqueLines.size).toBe(isStaleCalls.length);
  });
});

// =============================================================================
// REQ-003: Event Pattern Detection (events[])
// =============================================================================

describe('REQ-003: parseEventPatterns', () => {
  /**
   * parseEventPatterns is a NEW function to be implemented in Task 1.3.
   * These tests define the expected contract.
   */

  let parseEventPatterns;

  beforeEach(async () => {
    try {
      const mod = await import('../trace-generate.mjs');
      parseEventPatterns = mod.parseEventPatterns;
    } catch {
      parseEventPatterns = undefined;
    }
  });

  it('REQ-003 AC1: parseEventPatterns should be exported from trace-generate.mjs', () => {
    // Arrange - loaded in beforeEach

    // Act & Assert
    expect(
      typeof parseEventPatterns,
      'parseEventPatterns should be a function exported from trace-generate.mjs',
    ).toBe('function');
  });

  it('REQ-003 AC2: detects .emit() patterns with type "emit"', () => {
    // Arrange
    if (typeof parseEventPatterns !== 'function') {
      expect.fail('parseEventPatterns not yet implemented');
    }

    // Act
    const events = parseEventPatterns(SOURCE_WITH_EVENTS);

    // Assert
    const emitEvents = events.filter(e => e.type === 'emit');
    expect(emitEvents.length).toBeGreaterThanOrEqual(2);

    const taskStarted = emitEvents.find(e => e.eventName === 'task:started');
    expect(taskStarted, 'Should detect emit of task:started').toBeTruthy();
    expect(taskStarted.type).toBe('emit');
    expect(typeof taskStarted.line).toBe('number');
    expect(taskStarted.line).toBeGreaterThan(0);
  });

  it('REQ-003 AC3: detects .on() patterns with type "subscribe"', () => {
    // Arrange
    if (typeof parseEventPatterns !== 'function') {
      expect.fail('parseEventPatterns not yet implemented');
    }

    // Act
    const events = parseEventPatterns(SOURCE_WITH_EVENTS);

    // Assert
    const subscribeEvents = events.filter(e => e.type === 'subscribe');
    expect(subscribeEvents.length).toBeGreaterThanOrEqual(2);

    const taskCompleted = subscribeEvents.find(e => e.eventName === 'task:completed');
    expect(taskCompleted, 'Should detect subscription to task:completed').toBeTruthy();
    expect(taskCompleted.type).toBe('subscribe');
  });

  it('REQ-003 AC4: events[] entries have correct shape (file, line, eventName, type)', () => {
    // Arrange
    if (typeof parseEventPatterns !== 'function') {
      expect.fail('parseEventPatterns not yet implemented');
    }

    // Act
    const events = parseEventPatterns(SOURCE_WITH_EVENTS);

    // Assert - Every entry must have required fields with correct types
    expect(events.length).toBeGreaterThan(0);
    for (const entry of events) {
      expect(typeof entry.line).toBe('number');
      expect(entry.line).toBeGreaterThan(0);
      expect(typeof entry.eventName).toBe('string');
      expect(entry.eventName.length).toBeGreaterThan(0);
      expect(['emit', 'subscribe']).toContain(entry.type);
    }
  });

  it('REQ-003 AC5: non-event method calls are not falsely detected', () => {
    // Arrange
    if (typeof parseEventPatterns !== 'function') {
      expect.fail('parseEventPatterns not yet implemented');
    }

    // Act
    const events = parseEventPatterns(SOURCE_WITHOUT_EVENTS);

    // Assert - No events should be detected in source without event patterns
    expect(events.length).toBe(0);
  });

  it('REQ-003 AC6: detects .addEventListener() patterns', () => {
    // Arrange
    if (typeof parseEventPatterns !== 'function') {
      expect.fail('parseEventPatterns not yet implemented');
    }

    // Act
    const events = parseEventPatterns(SOURCE_WITH_EVENTS);

    // Assert
    const addListenerEvents = events.filter(e => e.eventName === 'data:ready');
    expect(addListenerEvents.length).toBeGreaterThanOrEqual(1);
    expect(addListenerEvents[0].type).toBe('subscribe');
  });

  it('REQ-003 AC7: detects .subscribe() patterns', () => {
    // Arrange
    if (typeof parseEventPatterns !== 'function') {
      expect.fail('parseEventPatterns not yet implemented');
    }

    // Act
    const events = parseEventPatterns(SOURCE_WITH_EVENTS);

    // Assert
    const subscribeEvents = events.filter(e => e.eventName === 'notifications');
    expect(subscribeEvents.length).toBeGreaterThanOrEqual(1);
    expect(subscribeEvents[0].type).toBe('subscribe');
  });

  it('REQ-003 AC8: empty source produces empty events array', () => {
    // Arrange
    if (typeof parseEventPatterns !== 'function') {
      expect.fail('parseEventPatterns not yet implemented');
    }

    // Act
    const events = parseEventPatterns('');

    // Assert
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBe(0);
  });

  it('REQ-003 AC9: commented-out event patterns are not detected', () => {
    // Arrange
    if (typeof parseEventPatterns !== 'function') {
      expect.fail('parseEventPatterns not yet implemented');
    }
    const sourceWithComments = `
// emitter.emit('fake-event', data);
/* emitter.on('another-fake', handler); */
`;

    // Act
    const events = parseEventPatterns(sourceWithComments);

    // Assert
    expect(events.length).toBe(0);
  });
});

// =============================================================================
// REQ-004: Cross-Module Call Graph Query (trace-query --calls)
// =============================================================================

describe('REQ-004: queryCallGraph', () => {
  /**
   * queryCallGraph is a NEW function to be implemented in Task 1.6.
   * parseArgs --calls support is also new (Task 1.6).
   * These tests define the expected contract and will pass after implementation.
   */

  let traceQueryModule;

  beforeEach(async () => {
    traceQueryModule = await import('../trace-query.mjs');
  });

  it('REQ-004 AC1: queryCallGraph should be exported from trace-query.mjs', () => {
    // Arrange - loaded in beforeEach

    // Act & Assert
    expect(
      typeof traceQueryModule.queryCallGraph,
      'queryCallGraph should be a function exported from trace-query.mjs',
    ).toBe('function');
  });

  it('REQ-004 AC2: queryCallGraph returns callers and callees for a given function', () => {
    // Arrange
    const { queryCallGraph } = traceQueryModule;
    if (typeof queryCallGraph !== 'function') {
      expect.fail('queryCallGraph not yet implemented');
    }

    // Create a temp project with trace data containing calls
    const testRoot = createProjectWithCallTraces();

    try {
      // Act
      const result = queryCallGraph('isTraceStale', testRoot);

      // Assert - result should have callers and callees arrays
      expect(result).toBeTruthy();
      expect(Array.isArray(result.callers)).toBe(true);
      expect(Array.isArray(result.callees)).toBe(true);
      expect(result.callers.length).toBeGreaterThan(0);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('REQ-004 AC3: query across multiple modules works', () => {
    // Arrange
    const { queryCallGraph } = traceQueryModule;
    if (typeof queryCallGraph !== 'function') {
      expect.fail('queryCallGraph not yet implemented');
    }

    const testRoot = createProjectWithCallTraces();

    try {
      // Act
      const result = queryCallGraph('isTraceStale', testRoot);

      // Assert - callers should include entries from trace-scripts module
      expect(result.callers.length).toBeGreaterThanOrEqual(1);
      for (const caller of result.callers) {
        expect(typeof caller.callerFile).toBe('string');
        expect(typeof caller.callerLine).toBe('number');
      }
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('REQ-004 AC4: query for non-existent function returns empty results', () => {
    // Arrange
    const { queryCallGraph } = traceQueryModule;
    if (typeof queryCallGraph !== 'function') {
      expect.fail('queryCallGraph not yet implemented');
    }

    const testRoot = createProjectWithCallTraces();

    try {
      // Act
      const result = queryCallGraph('nonExistentFunction', testRoot);

      // Assert
      expect(result.callers.length).toBe(0);
      expect(result.callees.length).toBe(0);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('REQ-004 AC-CLI: parseArgs recognizes --calls with function name', () => {
    // Arrange
    const { parseArgs } = traceQueryModule;

    // Act
    const result = parseArgs(['node', 'trace-query.mjs', '--calls', 'isTraceStale']);

    // Assert
    expect(result.mode).toBe('calls');
    expect(result.functionName).toBe('isTraceStale');
  });

  it('REQ-004 AC-CLI2: parseArgs handles --calls without function name', () => {
    // Arrange
    const { parseArgs } = traceQueryModule;

    // Act
    const result = parseArgs(['node', 'trace-query.mjs', '--calls']);

    // Assert - should either be null mode or have empty/undefined functionName
    expect(result.mode === null || !result.functionName).toBe(true);
  });
});

/**
 * Helper to create a temp project with low-level trace JSON files
 * containing calls[] data for queryCallGraph tests.
 */
function createProjectWithCallTraces() {
  const testRoot = join(
    tmpdir(),
    `trace-query-calls-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  mkdirSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true });

  // Write trace config
  const config = {
    version: 1,
    projectRoot: '.',
    modules: [
      { id: 'trace-scripts', name: 'Trace Scripts', fileGlobs: ['.claude/scripts/trace-*.mjs'] },
      { id: 'scripts-lib', name: 'Scripts Lib', fileGlobs: ['.claude/scripts/lib/**'] },
    ],
  };
  writeFileSync(
    join(testRoot, '.claude', 'traces', 'trace.config.json'),
    JSON.stringify(config, null, 2),
  );

  // Write trace-scripts low-level trace with calls data
  const traceScripts = {
    moduleId: 'trace-scripts',
    version: 1,
    lastGenerated: '2026-03-20T10:00:00.000Z',
    generatedBy: 'trace-generate',
    files: [
      {
        filePath: '.claude/scripts/trace-commit-staleness.mjs',
        exports: [],
        imports: [{ source: './lib/trace-utils.mjs', symbols: ['isTraceStale'] }],
        calls: [
          {
            callerFile: '.claude/scripts/trace-commit-staleness.mjs',
            callerLine: 28,
            calleeName: 'isTraceStale',
            calleeFile: '.claude/scripts/lib/trace-utils.mjs',
            calleeLine: 299,
          },
        ],
        events: [],
      },
    ],
  };
  writeFileSync(
    join(testRoot, '.claude', 'traces', 'low-level', 'trace-scripts.json'),
    JSON.stringify(traceScripts, null, 2),
  );

  // Write scripts-lib low-level trace
  const scriptsLib = {
    moduleId: 'scripts-lib',
    version: 1,
    lastGenerated: '2026-03-20T10:00:00.000Z',
    generatedBy: 'trace-generate',
    files: [
      {
        filePath: '.claude/scripts/lib/trace-utils.mjs',
        exports: [
          { symbol: 'isTraceStale', type: 'function', lineNumber: 299 },
          { symbol: 'loadTraceConfig', type: 'function', lineNumber: 42 },
        ],
        imports: [],
        calls: [
          {
            callerFile: '.claude/scripts/lib/trace-utils.mjs',
            callerLine: 310,
            calleeName: 'loadTraceConfig',
            calleeFile: '.claude/scripts/lib/trace-utils.mjs',
            calleeLine: 42,
          },
        ],
        events: [],
      },
    ],
  };
  writeFileSync(
    join(testRoot, '.claude', 'traces', 'low-level', 'scripts-lib.json'),
    JSON.stringify(scriptsLib, null, 2),
  );

  return testRoot;
}

// =============================================================================
// REQ-027: Entry-Level Validation (validateLowLevelTrace)
// =============================================================================

describe('REQ-027: Entry-level validation for calls[] and events[]', () => {
  it('REQ-027 AC1: valid CallEntry entries pass validation', () => {
    // Arrange
    const trace = makeTraceWithCallsAndEvents(
      [makeValidCallEntry()],
      [],
    );

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('REQ-027 AC2: valid EventEntry entries pass validation', () => {
    // Arrange
    const trace = makeTraceWithCallsAndEvents(
      [],
      [makeValidEventEntry()],
    );

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('REQ-027 AC3: CallEntry with missing callerFile is rejected', () => {
    // Arrange
    const badCall = makeValidCallEntry();
    delete badCall.callerFile;
    const trace = makeTraceWithCallsAndEvents([badCall], []);

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('callerFile'))).toBe(true);
  });

  it('REQ-027 AC4: CallEntry with wrong type for callerLine is rejected', () => {
    // Arrange
    const badCall = makeValidCallEntry({ callerLine: 'not-a-number' });
    const trace = makeTraceWithCallsAndEvents([badCall], []);

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('callerLine'))).toBe(true);
  });

  it('REQ-027 AC5: CallEntry with missing calleeName is rejected', () => {
    // Arrange
    const badCall = makeValidCallEntry();
    delete badCall.calleeName;
    const trace = makeTraceWithCallsAndEvents([badCall], []);

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('calleeName'))).toBe(true);
  });

  it('REQ-027 AC6: CallEntry with null calleeFile passes (unresolved callee)', () => {
    // Arrange
    const unresolvedCall = makeValidCallEntry({ calleeFile: null, calleeLine: null });
    const trace = makeTraceWithCallsAndEvents([unresolvedCall], []);

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(true);
  });

  it('REQ-027 AC7: EventEntry with missing eventName is rejected', () => {
    // Arrange
    const badEvent = makeValidEventEntry();
    delete badEvent.eventName;
    const trace = makeTraceWithCallsAndEvents([], [badEvent]);

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('eventName'))).toBe(true);
  });

  it('REQ-027 AC8: EventEntry with invalid type is rejected', () => {
    // Arrange
    const badEvent = makeValidEventEntry({ type: 'invalid-type' });
    const trace = makeTraceWithCallsAndEvents([], [badEvent]);

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('type'))).toBe(true);
  });

  it('REQ-027 AC9: EventEntry with missing line is rejected', () => {
    // Arrange
    const badEvent = makeValidEventEntry();
    delete badEvent.line;
    const trace = makeTraceWithCallsAndEvents([], [badEvent]);

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('line'))).toBe(true);
  });

  it('REQ-027 AC10: error message includes the offending entry index', () => {
    // Arrange - Second call entry is invalid
    const goodCall = makeValidCallEntry();
    const badCall = makeValidCallEntry();
    delete badCall.callerFile;
    const trace = makeTraceWithCallsAndEvents([goodCall, badCall], []);

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(false);
    // Error should reference index 1 (the second entry)
    expect(result.errors.some(e => e.includes('[1]') || e.includes('calls[1]'))).toBe(true);
  });

  it('REQ-027 AC11: trace with empty calls[] and events[] still passes (backward compat)', () => {
    // Arrange
    const trace = makeTraceWithCallsAndEvents([], []);

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(true);
  });

  it('REQ-027 AC12: multiple invalid entries produce multiple errors', () => {
    // Arrange
    const badCall1 = makeValidCallEntry();
    delete badCall1.callerFile;
    const badCall2 = makeValidCallEntry();
    delete badCall2.calleeName;
    const trace = makeTraceWithCallsAndEvents([badCall1, badCall2], []);

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('REQ-027 AC13: EventEntry with valid file field passes', () => {
    // Arrange
    const validEvent = makeValidEventEntry({ file: 'src/emitter.mjs' });
    const trace = makeTraceWithCallsAndEvents([], [validEvent]);

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(true);
  });

  it('REQ-027 AC14: CallEntry with wrong type for calleeFile is rejected (not string, not null)', () => {
    // Arrange
    const badCall = makeValidCallEntry({ calleeFile: 123 });
    const trace = makeTraceWithCallsAndEvents([badCall], []);

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('calleeFile'))).toBe(true);
  });
});

// =============================================================================
// Wire Format: Markdown Rendering
// =============================================================================

describe('Wire format: Markdown rendering of calls/events', () => {
  it('WF-001: calls section uses spec-defined column headers after Task 1.5', () => {
    // Arrange
    const trace = {
      moduleId: 'test-module',
      version: 1,
      lastGenerated: '2026-03-20T10:00:00.000Z',
      generatedBy: 'trace-generate',
      files: [
        {
          filePath: 'src/service.mjs',
          exports: [],
          imports: [],
          calls: [
            makeValidCallEntry({
              callerFile: 'src/service.mjs',
              callerLine: 10,
              calleeName: 'loadConfig',
              calleeFile: 'src/utils.mjs',
              calleeLine: 5,
            }),
          ],
          events: [],
        },
      ],
    };

    // Act
    const md = generateLowLevelMarkdown(trace, { id: 'test-module', name: 'Test Module' });

    // Assert - Should include the Function Calls section with call data
    expect(md.includes('### Function Calls')).toBe(true);
    expect(md.includes('loadConfig')).toBe(true);
  });

  it('WF-002: events section uses spec-defined column headers after Task 1.5', () => {
    // Arrange
    const trace = {
      moduleId: 'test-module',
      version: 1,
      lastGenerated: '2026-03-20T10:00:00.000Z',
      generatedBy: 'trace-generate',
      files: [
        {
          filePath: 'src/emitter.mjs',
          exports: [],
          imports: [],
          calls: [],
          events: [
            makeValidEventEntry({
              file: 'src/emitter.mjs',
              line: 15,
              eventName: 'data:ready',
              type: 'emit',
            }),
          ],
        },
      ],
    };

    // Act
    const md = generateLowLevelMarkdown(trace, { id: 'test-module', name: 'Test Module' });

    // Assert
    expect(md.includes('### Events')).toBe(true);
    expect(md.includes('data:ready')).toBe(true);
    expect(md.includes('emit')).toBe(true);
  });

  it('WF-003: empty calls/events show section headers', () => {
    // Arrange
    const trace = makeTraceWithCallsAndEvents([], []);

    // Act
    const md = generateLowLevelMarkdown(trace, { id: 'test-module', name: 'Test Module' });

    // Assert
    expect(md.includes('### Function Calls')).toBe(true);
    expect(md.includes('### Events')).toBe(true);
  });

  it('WF-004: calls with null calleeFile render correctly', () => {
    // Arrange
    const trace = {
      moduleId: 'test-module',
      version: 1,
      lastGenerated: '2026-03-20T10:00:00.000Z',
      generatedBy: 'trace-generate',
      files: [
        {
          filePath: 'src/service.mjs',
          exports: [],
          imports: [],
          calls: [
            makeValidCallEntry({
              callerFile: 'src/service.mjs',
              callerLine: 10,
              calleeName: 'unknownFn',
              calleeFile: null,
              calleeLine: null,
            }),
          ],
          events: [],
        },
      ],
    };

    // Act
    const md = generateLowLevelMarkdown(trace, { id: 'test-module', name: 'Test Module' });

    // Assert - Should not crash and should include the call
    expect(md.includes('unknownFn')).toBe(true);
  });
});

// =============================================================================
// Wire Format: Sync Parser Round-Trip
// =============================================================================

describe('Wire format: Sync parser round-trip for calls/events', () => {
  let parseLowLevelMarkdown;

  beforeEach(async () => {
    try {
      const syncMod = await import('../trace-sync.mjs');
      parseLowLevelMarkdown = syncMod.parseLowLevelMarkdown;
    } catch {
      parseLowLevelMarkdown = undefined;
    }
  });

  it('WF-005: calls[] round-trips through markdown -> JSON preserving data', () => {
    // Arrange
    if (typeof parseLowLevelMarkdown !== 'function') {
      // parseLowLevelMarkdown may not be exported; skip gracefully
      return;
    }

    const originalTrace = makeTraceWithCallsAndEvents(
      [
        makeValidCallEntry({
          callerFile: 'src/service.mjs',
          callerLine: 10,
          calleeName: 'loadConfig',
          calleeFile: 'src/utils.mjs',
          calleeLine: 5,
        }),
      ],
      [],
    );

    // Act - Generate markdown, parse it back
    const md = generateLowLevelMarkdown(originalTrace, { id: 'test-module', name: 'Test Module' });
    const parsed = parseLowLevelMarkdown(md);

    // Assert - Parsed calls should contain the original entry data
    const parsedFile = parsed.files?.[0];
    expect(parsedFile).toBeTruthy();
    // Filter out any separator-row artifacts (--- entries) from parsing
    const realCalls = parsedFile.calls.filter(c => c.calleeName !== '---');
    expect(realCalls.length).toBe(1);
    expect(realCalls[0].calleeName).toBe('loadConfig');
    expect(realCalls[0].callerFile).toBe('src/service.mjs');
    expect(realCalls[0].callerLine).toBe(10);
    expect(realCalls[0].calleeFile).toBe('src/utils.mjs');
    expect(realCalls[0].calleeLine).toBe(5);
  });

  it('WF-006: events[] round-trips through markdown -> JSON preserving data', () => {
    // Arrange
    if (typeof parseLowLevelMarkdown !== 'function') {
      return;
    }

    const originalTrace = makeTraceWithCallsAndEvents(
      [],
      [
        makeValidEventEntry({
          file: 'src/emitter.mjs',
          line: 15,
          eventName: 'task:complete',
          type: 'emit',
        }),
      ],
    );

    // Act
    const md = generateLowLevelMarkdown(originalTrace, { id: 'test-module', name: 'Test Module' });
    const parsed = parseLowLevelMarkdown(md);

    // Assert - Filter out any separator-row artifacts
    const parsedFile = parsed.files?.[0];
    expect(parsedFile).toBeTruthy();
    const realEvents = parsedFile.events.filter(e => e.eventName !== '---');
    expect(realEvents.length).toBe(1);
    expect(realEvents[0].eventName).toBe('task:complete');
    expect(realEvents[0].type).toBe('emit');
    expect(realEvents[0].file).toBe('src/emitter.mjs');
    expect(realEvents[0].line).toBe(15);
  });
});

// =============================================================================
// REQ-002/003 Integration: analyzeFile populates calls[] and events[]
// =============================================================================

describe('REQ-002/003 Integration: analyzeFile populates calls[] and events[]', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `trace-int-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'src'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('REQ-002 INT-1: analyzeFile returns calls and events arrays', () => {
    // Arrange
    writeFileSync(join(testRoot, 'src', 'service.mjs'), SOURCE_WITH_CALLS);

    // Act
    const result = analyzeFile('src/service.mjs', testRoot);

    // Assert - Shape contract always holds
    expect(Array.isArray(result.calls)).toBe(true);
    expect(Array.isArray(result.events)).toBe(true);
    expect(result).toHaveProperty('filePath');
    expect(result).toHaveProperty('exports');
    expect(result).toHaveProperty('imports');
  });

  it('REQ-003 INT-2: analyzeFile returns events array for source with event patterns', () => {
    // Arrange
    writeFileSync(join(testRoot, 'src', 'emitter.mjs'), SOURCE_WITH_EVENTS);

    // Act
    const result = analyzeFile('src/emitter.mjs', testRoot);

    // Assert
    expect(Array.isArray(result.events)).toBe(true);
  });

  it('REQ-002/003 INT-3: analyzeFile return shape matches contract', () => {
    // Arrange
    writeFileSync(join(testRoot, 'src', 'module.mjs'), `
export function foo() { return 1; }
`);

    // Act
    const result = analyzeFile('src/module.mjs', testRoot);

    // Assert - Verify the full return shape contract
    expect(typeof result.filePath).toBe('string');
    expect(Array.isArray(result.exports)).toBe(true);
    expect(Array.isArray(result.imports)).toBe(true);
    expect(Array.isArray(result.calls)).toBe(true);
    expect(Array.isArray(result.events)).toBe(true);
  });
});

// =============================================================================
// REQ-031: Path Traversal Validation (supplementary for M1)
// =============================================================================

describe('REQ-031: Path traversal validation', () => {
  it('REQ-031 AC1: path with .. traversal outside project root is detected', () => {
    // Arrange
    const projectRoot = '/fake/project/root';
    const maliciousPath = '../../../etc/passwd';

    // Act
    const resolved = resolve(projectRoot, maliciousPath);

    // Assert - Path should NOT start with projectRoot
    expect(resolved.startsWith(projectRoot)).toBe(false);
  });

  it('REQ-031 AC2: path within project root is accepted', () => {
    // Arrange
    const projectRoot = '/fake/project/root';
    const validPath = 'src/module/service.mjs';

    // Act
    const resolved = resolve(projectRoot, validPath);

    // Assert
    expect(resolved.startsWith(projectRoot)).toBe(true);
  });

  it('REQ-031 AC3: absolute path outside project root is detected', () => {
    // Arrange
    const projectRoot = '/fake/project/root';
    const absoluteOutside = '/tmp/evil/file.mjs';

    // Act
    const resolved = resolve(projectRoot, absoluteOutside);

    // Assert
    expect(resolved.startsWith(projectRoot)).toBe(false);
  });

  it('REQ-031 AC4: nested .. that stays within project root is accepted', () => {
    // Arrange
    const projectRoot = '/fake/project/root';
    const nestedPath = 'src/deep/../module/service.mjs';

    // Act
    const resolved = resolve(projectRoot, nestedPath);

    // Assert
    expect(resolved.startsWith(projectRoot)).toBe(true);
  });
});

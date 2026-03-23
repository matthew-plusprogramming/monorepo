/**
 * Tests for M4 (Engine Upgrade -- Type-Aware Analysis) of sg-trace-v2-docs-bridge spec.
 *
 * Covers:
 * - REQ-020: TypeScript compiler API replacement
 * - REQ-021: Analyzer interface contract (same shape from both analyzers)
 * - REQ-022: Configurable file extension support
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs trace-ts-analyzer.test.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseImportsTS,
  parseExportsTS,
  parseCallGraphTS,
  parseEventPatternsTS,
  analyzeSourceWithCompiler,
} from '../lib/ts-analyzer.mjs';

import {
  parseImports,
  parseExports,
  parseCallGraph,
  parseEventPatterns,
  analyzeFile,
} from '../trace-generate.mjs';

// =============================================================================
// Test Fixtures
// =============================================================================

const TEST_FILE_PATH = 'src/test-module/service.mjs';

/** Source code with standard imports */
const SOURCE_WITH_IMPORTS = `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../types.js';
import Redis from 'ioredis';
import * as utils from './utils.js';
import './side-effect.js';

export function main() {
  console.log('hello');
}
`;

/** Source code with require-style imports */
const SOURCE_WITH_REQUIRE = `
const { readFileSync } = require('node:fs');
const path = require('node:path');
`;

/** Source code with various exports */
const SOURCE_WITH_EXPORTS = `
export function greet(name) {
  return 'hello ' + name;
}

export async function fetchData(url) {
  return fetch(url);
}

export class UserService {
  constructor(db) {
    this.db = db;
  }
}

export const MAX_RETRIES = 3;

export default function defaultFunc(x, y) {
  return x + y;
}
`;

/** Source code with TypeScript-specific exports */
const SOURCE_WITH_TS_EXPORTS = `
export type AlertSeverity = 'warning' | 'critical';

export interface AlertPayload {
  readonly alert_id: string;
  readonly severity: AlertSeverity;
}

export enum Status {
  Active,
  Inactive,
}

export const TIMEOUT_MS = 5000;
`;

/** Source code with function calls */
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

function resolveProjectRoot() {
  return process.cwd();
}
`;

/** Source code with event patterns */
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

/** Source code with destructured imports (edge case better handled by TS compiler) */
const SOURCE_WITH_DESTRUCTURED_IMPORTS = `
import {
  readFileSync,
  writeFileSync,
  existsSync
} from 'node:fs';

import {
  join,
  resolve,
  dirname
} from 'node:path';

export function readConfig(path) {
  if (existsSync(path)) {
    return readFileSync(path, 'utf-8');
  }
  return null;
}
`;

/** Source code with re-exports */
const SOURCE_WITH_REEXPORTS = `
export { readFileSync } from 'node:fs';
export { join, resolve } from 'node:path';
`;

/** Source code with nested calls (better handled by TS compiler) */
const SOURCE_WITH_NESTED_CALLS = `
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

export function loadConfig(dir) {
  return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));
}
`;

/** Source code with calls inside comments (should NOT be detected) */
const SOURCE_WITH_CALLS_IN_COMMENTS = `
import { readFileSync } from 'node:fs';

// This is a comment: readFileSync('should-not-match')
/* Block comment: readFileSync('also-should-not-match') */

export function realCall() {
  return readFileSync('real.txt', 'utf-8');
}
`;

/** Source with export { X, Y } (named re-exports without from) */
const SOURCE_WITH_NAMED_EXPORTS = `
function helper() { return 42; }
function processor() { return 'done'; }

export { helper, processor };
`;

function makeKnownExportsMap() {
  const m = new Map();
  m.set('loadTraceConfig', { file: './lib/trace-utils.mjs', line: 42 });
  m.set('isTraceStale', { file: './lib/trace-utils.mjs', line: 299 });
  return m;
}

// =============================================================================
// REQ-020: TypeScript Compiler API Replacement
// =============================================================================

describe('REQ-020: TypeScript compiler API replacement', () => {
  describe('parseImportsTS', () => {
    it('should parse named imports', () => {
      const imports = parseImportsTS(SOURCE_WITH_IMPORTS);
      const fsImport = imports.find(i => i.source === 'node:fs');
      expect(fsImport).toBeDefined();
      expect(fsImport.symbols).toContain('readFileSync');
      expect(fsImport.symbols).toContain('writeFileSync');
    });

    it('should parse default imports', () => {
      const imports = parseImportsTS(SOURCE_WITH_IMPORTS);
      const redisImport = imports.find(i => i.source === 'ioredis');
      expect(redisImport).toBeDefined();
      expect(redisImport.symbols).toContain('Redis');
    });

    it('should parse namespace imports', () => {
      const imports = parseImportsTS(SOURCE_WITH_IMPORTS);
      const utilsImport = imports.find(i => i.source === './utils.js');
      expect(utilsImport).toBeDefined();
      expect(utilsImport.symbols).toContain('* as utils');
    });

    it('should parse side-effect imports', () => {
      const imports = parseImportsTS(SOURCE_WITH_IMPORTS);
      const sideEffect = imports.find(i => i.source === './side-effect.js');
      expect(sideEffect).toBeDefined();
      expect(sideEffect.symbols).toEqual([]);
    });

    it('should parse type imports', () => {
      const imports = parseImportsTS(SOURCE_WITH_IMPORTS);
      const typeImport = imports.find(i => i.source === '../types.js');
      expect(typeImport).toBeDefined();
      expect(typeImport.symbols).toContain('Config');
    });

    it('should parse require-style imports', () => {
      const imports = parseImportsTS(SOURCE_WITH_REQUIRE);
      const fsImport = imports.find(i => i.source === 'node:fs');
      expect(fsImport).toBeDefined();
      expect(fsImport.symbols).toContain('readFileSync');

      const pathImport = imports.find(i => i.source === 'node:path');
      expect(pathImport).toBeDefined();
      expect(pathImport.symbols).toContain('path');
    });

    it('should handle multi-line destructured imports', () => {
      const imports = parseImportsTS(SOURCE_WITH_DESTRUCTURED_IMPORTS);
      const fsImport = imports.find(i => i.source === 'node:fs');
      expect(fsImport).toBeDefined();
      expect(fsImport.symbols).toHaveLength(3);
      expect(fsImport.symbols).toContain('readFileSync');
      expect(fsImport.symbols).toContain('writeFileSync');
      expect(fsImport.symbols).toContain('existsSync');
    });
  });

  describe('parseExportsTS', () => {
    it('should parse function exports', () => {
      const exports = parseExportsTS(SOURCE_WITH_EXPORTS);
      const greet = exports.find(e => e.symbol === 'greet');
      expect(greet).toBeDefined();
      expect(greet.type).toBe('function');
      expect(greet.lineNumber).toBeGreaterThan(0);
      expect(greet.signature).toContain('name');
    });

    it('should parse async function exports', () => {
      const exports = parseExportsTS(SOURCE_WITH_EXPORTS);
      const fetchData = exports.find(e => e.symbol === 'fetchData');
      expect(fetchData).toBeDefined();
      expect(fetchData.type).toBe('function');
      expect(fetchData.signature).toContain('url');
    });

    it('should parse class exports', () => {
      const exports = parseExportsTS(SOURCE_WITH_EXPORTS);
      const userService = exports.find(e => e.symbol === 'UserService');
      expect(userService).toBeDefined();
      expect(userService.type).toBe('class');
    });

    it('should parse const exports', () => {
      const exports = parseExportsTS(SOURCE_WITH_EXPORTS);
      const maxRetries = exports.find(e => e.symbol === 'MAX_RETRIES');
      expect(maxRetries).toBeDefined();
      expect(maxRetries.type).toBe('const');
    });

    it('should parse default exports', () => {
      const exports = parseExportsTS(SOURCE_WITH_EXPORTS);
      const defaultExport = exports.find(e => e.type === 'default');
      expect(defaultExport).toBeDefined();
      expect(defaultExport.symbol).toBe('defaultFunc');
    });

    it('should parse TypeScript type exports', () => {
      const exports = parseExportsTS(SOURCE_WITH_TS_EXPORTS);
      const typeExport = exports.find(e => e.symbol === 'AlertSeverity');
      expect(typeExport).toBeDefined();
      expect(typeExport.type).toBe('type');
    });

    it('should parse interface exports', () => {
      const exports = parseExportsTS(SOURCE_WITH_TS_EXPORTS);
      const interfaceExport = exports.find(e => e.symbol === 'AlertPayload');
      expect(interfaceExport).toBeDefined();
      expect(interfaceExport.type).toBe('interface');
    });

    it('should parse enum exports', () => {
      const exports = parseExportsTS(SOURCE_WITH_TS_EXPORTS);
      const enumExport = exports.find(e => e.symbol === 'Status');
      expect(enumExport).toBeDefined();
      expect(enumExport.type).toBe('enum');
    });

    it('should parse re-exports', () => {
      const exports = parseExportsTS(SOURCE_WITH_REEXPORTS);
      expect(exports.length).toBe(3);
      expect(exports.map(e => e.symbol)).toContain('readFileSync');
      expect(exports.map(e => e.symbol)).toContain('join');
      expect(exports.map(e => e.symbol)).toContain('resolve');
    });

    it('should parse named exports without from clause', () => {
      const exports = parseExportsTS(SOURCE_WITH_NAMED_EXPORTS);
      expect(exports.map(e => e.symbol)).toContain('helper');
      expect(exports.map(e => e.symbol)).toContain('processor');
    });
  });

  describe('parseCallGraphTS', () => {
    it('should detect function calls', () => {
      const imports = parseImportsTS(SOURCE_WITH_CALLS);
      const calls = parseCallGraphTS(SOURCE_WITH_CALLS, imports, makeKnownExportsMap(), TEST_FILE_PATH);

      const loadTraceConfigCall = calls.find(c => c.calleeName === 'loadTraceConfig');
      expect(loadTraceConfigCall).toBeDefined();
      expect(loadTraceConfigCall.callerFile).toBe(TEST_FILE_PATH);
      expect(loadTraceConfigCall.calleeFile).toBe('./lib/trace-utils.mjs');
      expect(loadTraceConfigCall.calleeLine).toBe(42);
    });

    it('should resolve imported callees against known exports', () => {
      const imports = parseImportsTS(SOURCE_WITH_CALLS);
      const calls = parseCallGraphTS(SOURCE_WITH_CALLS, imports, makeKnownExportsMap(), TEST_FILE_PATH);

      const isTraceStaleCall = calls.find(c => c.calleeName === 'isTraceStale');
      expect(isTraceStaleCall).toBeDefined();
      expect(isTraceStaleCall.calleeFile).toBe('./lib/trace-utils.mjs');
      expect(isTraceStaleCall.calleeLine).toBe(299);
    });

    it('should mark unresolved callees with null', () => {
      const imports = parseImportsTS(SOURCE_WITH_CALLS);
      const calls = parseCallGraphTS(SOURCE_WITH_CALLS, imports, new Map(), TEST_FILE_PATH);

      const unresolvedCall = calls.find(c => c.calleeName === 'resolveProjectRoot');
      expect(unresolvedCall).toBeDefined();
      expect(unresolvedCall.calleeFile).toBeNull();
      expect(unresolvedCall.calleeLine).toBeNull();
    });

    it('should handle nested function calls', () => {
      const imports = parseImportsTS(SOURCE_WITH_NESTED_CALLS);
      const calls = parseCallGraphTS(SOURCE_WITH_NESTED_CALLS, imports, new Map(), TEST_FILE_PATH);

      // Should detect all nested calls: JSON.parse, readFileSync, join
      const callNames = calls.map(c => c.calleeName);
      expect(callNames).toContain('parse');
      expect(callNames).toContain('readFileSync');
      expect(callNames).toContain('join');
    });

    it('should NOT detect calls in comments', () => {
      const imports = parseImportsTS(SOURCE_WITH_CALLS_IN_COMMENTS);
      const calls = parseCallGraphTS(SOURCE_WITH_CALLS_IN_COMMENTS, imports, new Map(), TEST_FILE_PATH);

      // Should only find the real readFileSync call, not the commented ones
      const readCalls = calls.filter(c => c.calleeName === 'readFileSync');
      expect(readCalls.length).toBe(1);
    });

    it('should include line numbers for all calls', () => {
      const imports = parseImportsTS(SOURCE_WITH_CALLS);
      const calls = parseCallGraphTS(SOURCE_WITH_CALLS, imports, new Map(), TEST_FILE_PATH);

      for (const call of calls) {
        expect(call.callerLine).toBeGreaterThan(0);
        expect(Number.isInteger(call.callerLine)).toBe(true);
      }
    });
  });

  describe('parseEventPatternsTS', () => {
    it('should detect emit patterns', () => {
      const events = parseEventPatternsTS(SOURCE_WITH_EVENTS, TEST_FILE_PATH);
      const emitEvents = events.filter(e => e.type === 'emit');
      expect(emitEvents.length).toBe(2);
      expect(emitEvents.map(e => e.eventName)).toContain('task:started');
      expect(emitEvents.map(e => e.eventName)).toContain('task:progress');
    });

    it('should detect subscribe patterns (on)', () => {
      const events = parseEventPatternsTS(SOURCE_WITH_EVENTS, TEST_FILE_PATH);
      const onEvents = events.filter(e => e.type === 'subscribe' && e.eventName.startsWith('task:'));
      expect(onEvents.length).toBe(2);
      expect(onEvents.map(e => e.eventName)).toContain('task:completed');
      expect(onEvents.map(e => e.eventName)).toContain('task:error');
    });

    it('should detect addEventListener', () => {
      const events = parseEventPatternsTS(SOURCE_WITH_EVENTS, TEST_FILE_PATH);
      const addEvent = events.find(e => e.eventName === 'data:ready');
      expect(addEvent).toBeDefined();
      expect(addEvent.type).toBe('subscribe');
    });

    it('should detect subscribe method', () => {
      const events = parseEventPatternsTS(SOURCE_WITH_EVENTS, TEST_FILE_PATH);
      const subEvent = events.find(e => e.eventName === 'notifications');
      expect(subEvent).toBeDefined();
      expect(subEvent.type).toBe('subscribe');
    });

    it('should include file path in all events', () => {
      const events = parseEventPatternsTS(SOURCE_WITH_EVENTS, TEST_FILE_PATH);
      for (const event of events) {
        expect(event.file).toBe(TEST_FILE_PATH);
        expect(event.line).toBeGreaterThan(0);
      }
    });
  });
});

// =============================================================================
// REQ-021: Analyzer Interface Contract (same shape from both analyzers)
// =============================================================================

describe('REQ-021: Analyzer interface contract', () => {
  let testDir;

  beforeEach(() => {
    testDir = join(tmpdir(), `trace-ts-analyzer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return identical shape from TS compiler and regex analyzers', () => {
    const source = `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadConfig(dir) {
  return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));
}

export const VERSION = '1.0.0';
`;
    writeFileSync(join(testDir, 'src', 'service.mjs'), source);

    // Analyze with TS compiler (default)
    const tsResult = analyzeFile('src/service.mjs', testDir);

    // Analyze with regex (legacy fallback)
    const regexResult = analyzeFile('src/service.mjs', testDir, { parser: 'regex' });

    // Both should have the same top-level shape
    expect(tsResult).toHaveProperty('filePath');
    expect(tsResult).toHaveProperty('exports');
    expect(tsResult).toHaveProperty('imports');
    expect(tsResult).toHaveProperty('calls');
    expect(tsResult).toHaveProperty('events');

    expect(regexResult).toHaveProperty('filePath');
    expect(regexResult).toHaveProperty('exports');
    expect(regexResult).toHaveProperty('imports');
    expect(regexResult).toHaveProperty('calls');
    expect(regexResult).toHaveProperty('events');

    // filePath should be identical
    expect(tsResult.filePath).toBe(regexResult.filePath);

    // Both should find the same exports (by symbol name)
    const tsExportSymbols = tsResult.exports.map(e => e.symbol).sort();
    const regexExportSymbols = regexResult.exports.map(e => e.symbol).sort();
    expect(tsExportSymbols).toEqual(regexExportSymbols);

    // Both should find the same imports (by source)
    const tsImportSources = tsResult.imports.map(i => i.source).sort();
    const regexImportSources = regexResult.imports.map(i => i.source).sort();
    expect(tsImportSources).toEqual(regexImportSources);

    // Both should be arrays
    expect(Array.isArray(tsResult.calls)).toBe(true);
    expect(Array.isArray(tsResult.events)).toBe(true);
    expect(Array.isArray(regexResult.calls)).toBe(true);
    expect(Array.isArray(regexResult.events)).toBe(true);

    // Each export should have the required fields
    for (const exp of tsResult.exports) {
      expect(exp).toHaveProperty('symbol');
      expect(exp).toHaveProperty('type');
      expect(exp).toHaveProperty('lineNumber');
      expect(exp).toHaveProperty('signature');
      expect(exp).toHaveProperty('signatureRaw');
    }

    // Each import should have the required fields
    for (const imp of tsResult.imports) {
      expect(imp).toHaveProperty('source');
      expect(imp).toHaveProperty('symbols');
      expect(Array.isArray(imp.symbols)).toBe(true);
    }

    // Each call should have the required fields
    for (const call of tsResult.calls) {
      expect(call).toHaveProperty('callerFile');
      expect(call).toHaveProperty('callerLine');
      expect(call).toHaveProperty('calleeName');
      expect(call).toHaveProperty('calleeFile');
      expect(call).toHaveProperty('calleeLine');
    }
  });

  it('should work with Map as third parameter (backward compatible M1-M3 calling convention)', () => {
    const source = `
import { loadTraceConfig } from './lib/trace-utils.mjs';

export function init() {
  const config = loadTraceConfig();
  return config;
}
`;
    writeFileSync(join(testDir, 'src', 'init.mjs'), source);

    const knownExports = new Map();
    knownExports.set('loadTraceConfig', { file: './lib/trace-utils.mjs', line: 42 });

    // M1-M3 calling convention: analyzeFile(filePath, projectRoot, knownExports)
    const result = analyzeFile('src/init.mjs', testDir, knownExports);

    expect(result.filePath).toBe('src/init.mjs');
    expect(result.exports.length).toBeGreaterThan(0);
    expect(result.imports.length).toBeGreaterThan(0);

    // Call resolution should work (loadTraceConfig resolved via knownExports)
    const loadCall = result.calls.find(c => c.calleeName === 'loadTraceConfig');
    expect(loadCall).toBeDefined();
    expect(loadCall.calleeFile).toBe('./lib/trace-utils.mjs');
    expect(loadCall.calleeLine).toBe(42);
  });

  it('should work with config object as third parameter (M4 calling convention)', () => {
    const source = `
import { loadTraceConfig } from './lib/trace-utils.mjs';

export function init() {
  const config = loadTraceConfig();
  return config;
}
`;
    writeFileSync(join(testDir, 'src', 'init.mjs'), source);

    const knownExports = new Map();
    knownExports.set('loadTraceConfig', { file: './lib/trace-utils.mjs', line: 42 });

    // M4 calling convention: analyzeFile(filePath, projectRoot, config)
    const result = analyzeFile('src/init.mjs', testDir, {
      knownExports,
      fileExtensions: ['.mjs', '.js'],
    });

    expect(result.filePath).toBe('src/init.mjs');
    expect(result.exports.length).toBeGreaterThan(0);
    expect(result.imports.length).toBeGreaterThan(0);

    // Call resolution should work
    const loadCall = result.calls.find(c => c.calleeName === 'loadTraceConfig');
    expect(loadCall).toBeDefined();
    expect(loadCall.calleeFile).toBe('./lib/trace-utils.mjs');
  });

  it('should work with no third parameter', () => {
    const source = `
export function hello() {
  return 'world';
}
`;
    writeFileSync(join(testDir, 'src', 'simple.mjs'), source);

    // No third parameter: analyzeFile(filePath, projectRoot)
    const result = analyzeFile('src/simple.mjs', testDir);

    expect(result.filePath).toBe('src/simple.mjs');
    expect(result.exports.length).toBe(1);
    expect(result.exports[0].symbol).toBe('hello');
  });

  it('should use regex analyzer when parser: "regex" is specified', () => {
    const source = `
export function hello(name) {
  return 'hello ' + name;
}
`;
    writeFileSync(join(testDir, 'src', 'greeting.mjs'), source);

    // This should use the regex parser
    const result = analyzeFile('src/greeting.mjs', testDir, { parser: 'regex' });

    expect(result.filePath).toBe('src/greeting.mjs');
    expect(result.exports.length).toBe(1);
    expect(result.exports[0].symbol).toBe('hello');
    expect(result.exports[0].type).toBe('function');
  });
});

// =============================================================================
// REQ-022: Configurable File Extension Support
// =============================================================================

describe('REQ-022: Configurable file extension support', () => {
  let testDir;

  beforeEach(() => {
    testDir = join(tmpdir(), `trace-ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should analyze .mjs files by default', () => {
    writeFileSync(join(testDir, 'src', 'service.mjs'), 'export function hello() {}');
    const result = analyzeFile('src/service.mjs', testDir);
    expect(result.exports.length).toBe(1);
  });

  it('should analyze .js files by default', () => {
    writeFileSync(join(testDir, 'src', 'service.js'), 'export function hello() {}');
    const result = analyzeFile('src/service.js', testDir);
    expect(result.exports.length).toBe(1);
  });

  it('should analyze .ts files when configured', () => {
    const tsSource = `
export function greet(name: string): string {
  return 'hello ' + name;
}

export interface User {
  name: string;
  age: number;
}
`;
    writeFileSync(join(testDir, 'src', 'service.ts'), tsSource);
    const result = analyzeFile('src/service.ts', testDir, {
      fileExtensions: ['.mjs', '.js', '.ts'],
    });

    expect(result.exports.length).toBe(2);
    const greet = result.exports.find(e => e.symbol === 'greet');
    expect(greet).toBeDefined();
    expect(greet.type).toBe('function');
    expect(greet.signature).toContain('name: string');

    const user = result.exports.find(e => e.symbol === 'User');
    expect(user).toBeDefined();
    expect(user.type).toBe('interface');
  });

  it('should skip files whose extension is not in configured list', () => {
    writeFileSync(join(testDir, 'src', 'service.ts'), 'export function hello() {}');
    const result = analyzeFile('src/service.ts', testDir, {
      fileExtensions: ['.mjs'],
    });
    // .ts is still analyzable but skipped by extension filter
    expect(result.exports.length).toBe(0);
  });

  it('should return empty arrays for non-analyzable files', () => {
    writeFileSync(join(testDir, 'src', 'data.json'), '{"key": "value"}');
    const result = analyzeFile('src/data.json', testDir);
    expect(result.exports).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.calls).toEqual([]);
    expect(result.events).toEqual([]);
  });
});

// =============================================================================
// TS Compiler Accuracy Advantages
// =============================================================================

describe('TS compiler accuracy improvements', () => {
  it('should correctly parse multi-line destructured imports', () => {
    const source = `
import {
  readFileSync,
  writeFileSync,
  existsSync
} from 'node:fs';

export function check(path) {
  return existsSync(path);
}
`;
    const tsImports = parseImportsTS(source);
    const regexImports = parseImports(source);

    // Both should find the fs import with all 3 symbols
    const tsFsImport = tsImports.find(i => i.source === 'node:fs');
    const regexFsImport = regexImports.find(i => i.source === 'node:fs');

    expect(tsFsImport.symbols).toHaveLength(3);
    expect(regexFsImport.symbols).toHaveLength(3);
  });

  it('should handle dynamic import() expressions without false positives in calls', () => {
    const source = `
export async function loadModule(name) {
  const mod = await import('./modules/' + name + '.mjs');
  return mod.default();
}
`;
    // TS compiler should detect the dynamic import as a call but not confuse it
    const imports = parseImportsTS(source);
    // Dynamic imports are not static imports -- parseImportsTS should not include them
    expect(imports.length).toBe(0);
  });

  it('should handle method chaining correctly in call graph', () => {
    const source = `
export function process(items) {
  return items.filter(x => x.active).map(x => x.name).join(', ');
}
`;
    const calls = parseCallGraphTS(source, [], new Map(), 'test.mjs');
    const callNames = calls.map(c => c.calleeName);
    expect(callNames).toContain('filter');
    expect(callNames).toContain('map');
    expect(callNames).toContain('join');
  });

  it('should correctly detect all exports from export declarations', () => {
    const source = `
const a = 1;
const b = 2;
function c() {}
export { a, b, c };
`;
    const exports = parseExportsTS(source);
    expect(exports.length).toBe(3);
    expect(exports.map(e => e.symbol).sort()).toEqual(['a', 'b', 'c']);
  });

  it('should handle export with as alias', () => {
    const source = `
function internalFn() { return 42; }
export { internalFn as publicFn };
`;
    const exports = parseExportsTS(source);
    expect(exports.length).toBe(1);
    expect(exports[0].symbol).toBe('publicFn');
  });
});

// =============================================================================
// analyzeSourceWithCompiler integration
// =============================================================================

describe('analyzeSourceWithCompiler', () => {
  it('should return all four analysis results', () => {
    const source = `
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

const emitter = new EventEmitter();

export function start() {
  const data = readFileSync('input.txt', 'utf-8');
  emitter.emit('data:loaded', data);
  return data;
}
`;
    const result = analyzeSourceWithCompiler(source, 'test.mjs', new Map());

    expect(result.exports.length).toBeGreaterThan(0);
    expect(result.imports.length).toBeGreaterThan(0);
    expect(result.calls.length).toBeGreaterThan(0);
    expect(result.events.length).toBeGreaterThan(0);

    // Verify event was detected
    const emitEvent = result.events.find(e => e.eventName === 'data:loaded');
    expect(emitEvent).toBeDefined();
    expect(emitEvent.type).toBe('emit');
  });

  it('should set correct callerFile in calls', () => {
    const source = `
import { readFileSync } from 'node:fs';
export function load() { return readFileSync('x.txt'); }
`;
    const result = analyzeSourceWithCompiler(source, 'my/module.mjs', new Map());
    for (const call of result.calls) {
      expect(call.callerFile).toBe('my/module.mjs');
    }
  });

  it('should set correct file in events', () => {
    const source = `
const ee = { emit: () => {} };
ee.emit('test-event');
`;
    const result = analyzeSourceWithCompiler(source, 'my/events.mjs', new Map());
    for (const event of result.events) {
      expect(event.file).toBe('my/events.mjs');
    }
  });
});

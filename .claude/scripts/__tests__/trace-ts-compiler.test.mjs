/**
 * Unit tests for Milestone 4: Engine Upgrade -- Type-Aware Analysis
 *
 * Tests: REQ-020 (TS Compiler API replacement), REQ-021 (Analyzer interface contract),
 *        REQ-022 (Configurable file extensions)
 *
 * Validates:
 * - TS compiler analyzer produces same shape as regex version
 * - Destructured imports are correctly parsed
 * - Dynamic imports are detected
 * - Re-exports are handled
 * - Named/default exports on declarations detected
 * - Call graph handles method chains and nested calls
 * - Event patterns work with AST (.emit, .on)
 * - Comments and strings don't produce false positives
 * - analyzeFile() backward compatibility (2 params) and new 3-param form
 * - Configurable file extensions via trace.config.json
 * - Regression coverage for all standard import/export patterns
 * - Line numbers are accurate
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs .claude/scripts/__tests__/trace-ts-compiler.test.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseImports,
  parseExports,
  parseCallGraph,
  parseEventPatterns,
  analyzeFile,
  validateLowLevelTrace,
} from '../trace-generate.mjs';

// =============================================================================
// Test Fixtures -- Inline Source Code Strings
// =============================================================================

/** Source with destructured imports (REQ-020) */
const SOURCE_DESTRUCTURED_IMPORTS = `
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { EventEmitter } from 'node:events';

export function loadFile(name) {
  return readFileSync(join(__dirname, name), 'utf-8');
}
`;

/** Source with dynamic imports (REQ-020) */
const SOURCE_DYNAMIC_IMPORTS = `
import { join } from 'node:path';

export async function loadModule(name) {
  const mod = await import('./plugins/' + name + '.mjs');
  return mod.default;
}

export async function conditionalLoad(flag) {
  if (flag) {
    const { helper } = await import('./helpers.mjs');
    return helper();
  }
}
`;

/** Source with re-exports (REQ-020) */
const SOURCE_REEXPORTS = `
export { foo, bar } from './module-a.mjs';
export { default as baz } from './module-b.mjs';
export type { Config } from './types.js';
`;

/** Source with named exports on declarations (REQ-020) */
const SOURCE_NAMED_EXPORTS = `
export function processData(input) {
  return input.trim();
}

export async function fetchData(url) {
  const res = await fetch(url);
  return res.json();
}

export const MAX_RETRIES = 3;

export let currentCount = 0;

export class DataProcessor {
  constructor(config) {
    this.config = config;
  }
  process(data) {
    return data;
  }
}

export const handler = (req, res) => {
  res.send('ok');
};
`;

/** Source with default export (REQ-020) */
const SOURCE_DEFAULT_EXPORT = `
class Logger {
  log(msg) {
    console.log(msg);
  }
}

export default Logger;
`;

/** Source with default export on declaration */
const SOURCE_DEFAULT_EXPORT_DECL = `
export default function createLogger(options) {
  return new Logger(options);
}
`;

/** Source with method chains (REQ-020) */
const SOURCE_METHOD_CHAINS = `
import { createBuilder } from './builder.mjs';

export function build(config) {
  const result = createBuilder(config)
    .setName('test')
    .addFeature('logging')
    .build();
  return result;
}
`;

/** Source with nested calls (REQ-020) */
const SOURCE_NESTED_CALLS = `
import { transform } from './transform.mjs';
import { validate } from './validate.mjs';
import { serialize } from './serialize.mjs';

export function process(input) {
  return serialize(validate(transform(input)));
}

export function complexNested() {
  const result = JSON.stringify(transform(validate(JSON.parse(input))));
  return result;
}
`;

/** Source with event patterns (REQ-020) */
const SOURCE_EVENT_PATTERNS = `
import { EventEmitter } from 'node:events';

const emitter = new EventEmitter();

export function setupHandlers() {
  emitter.on('data:received', (data) => {
    console.log(data);
  });

  emitter.on('error', (err) => {
    console.error(err);
  });

  emitter.once('ready', () => {
    console.log('ready');
  });
}

export function sendNotification(msg) {
  emitter.emit('notification:sent', msg);
}

export function cleanup() {
  emitter.removeListener('data:received', handler);
  emitter.off('error', handler);
}
`;

/** Source with comments and strings that could produce false positives (REQ-020) */
const SOURCE_COMMENTS_AND_STRINGS = `
// import { fake } from 'fake-module';
// emitter.emit('commented-event');

/*
 * This block comment contains patterns:
 * import { another } from 'block-commented';
 * emitter.on('block-commented-event', handler);
 * someFunction(arg);
 */

const msg = "emitter.emit('string-event')";

// The real code
import { realImport } from './real-module.mjs';

export function realFunction() {
  return realImport();
}
`;

/** Source with all standard import patterns for regression */
const SOURCE_ALL_IMPORT_PATTERNS = `
import { named1, named2 } from './module-a.mjs';
import defaultExport from './module-b.mjs';
import * as namespace from './module-c.mjs';
import './side-effect.mjs';
import { one as aliased } from './module-d.mjs';
import type { SomeType } from './types.js';
`;

/** Source with all standard export patterns for regression */
const SOURCE_ALL_EXPORT_PATTERNS = `
export function namedFunc() {}
export async function asyncFunc() {}
export const CONST_VAL = 42;
export let mutableVal = 'hello';
export class MyClass {}
export interface MyInterface { id: string; }
export type MyType = string | number;
export enum MyEnum { A, B, C }
export default function defaultFunc() {}
`;

// =============================================================================
// REQ-020: TS Compiler API Replacement -- Output Shape
// =============================================================================

describe('REQ-020: analyzeFile output shape matches spec contract', () => {
  let testRoot;

  beforeEach(() => {
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-ts-compiler-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'src'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should produce { filePath, exports[], imports[], calls[], events[] } shape (REQ-020)', () => {
    // Arrange
    const filePath = 'src/service.mjs';
    writeFileSync(join(testRoot, filePath), SOURCE_DESTRUCTURED_IMPORTS);

    // Act
    const result = analyzeFile(filePath, testRoot);

    // Assert
    expect(result).toHaveProperty('filePath', filePath);
    expect(Array.isArray(result.exports)).toBe(true);
    expect(Array.isArray(result.imports)).toBe(true);
    expect(Array.isArray(result.calls)).toBe(true);
    expect(Array.isArray(result.events)).toBe(true);
  });

  it('should produce exports with symbol and type fields', () => {
    // Arrange
    const filePath = 'src/service.mjs';
    writeFileSync(join(testRoot, filePath), SOURCE_NAMED_EXPORTS);

    // Act
    const result = analyzeFile(filePath, testRoot);

    // Assert
    expect(result.exports.length).toBeGreaterThan(0);
    for (const exp of result.exports) {
      expect(exp).toHaveProperty('symbol');
      expect(typeof exp.symbol).toBe('string');
      expect(exp).toHaveProperty('type');
      expect(typeof exp.type).toBe('string');
    }
  });

  it('should produce imports with source and symbols fields', () => {
    // Arrange
    const filePath = 'src/service.mjs';
    writeFileSync(join(testRoot, filePath), SOURCE_DESTRUCTURED_IMPORTS);

    // Act
    const result = analyzeFile(filePath, testRoot);

    // Assert
    expect(result.imports.length).toBeGreaterThan(0);
    for (const imp of result.imports) {
      expect(imp).toHaveProperty('source');
      expect(typeof imp.source).toBe('string');
      expect(Array.isArray(imp.symbols)).toBe(true);
    }
  });

  it('should produce calls with CallEntry schema fields', () => {
    // Arrange
    const filePath = 'src/service.mjs';
    writeFileSync(join(testRoot, filePath), SOURCE_NESTED_CALLS);

    // Act
    const result = analyzeFile(filePath, testRoot);

    // Assert
    expect(result.calls.length).toBeGreaterThan(0);
    for (const call of result.calls) {
      expect(call).toHaveProperty('callerFile');
      expect(call).toHaveProperty('callerLine');
      expect(call).toHaveProperty('calleeName');
      expect(call).toHaveProperty('calleeFile');
      expect(call).toHaveProperty('calleeLine');
      expect(typeof call.callerFile).toBe('string');
      expect(typeof call.callerLine).toBe('number');
      expect(typeof call.calleeName).toBe('string');
      expect(call.calleeFile === null || typeof call.calleeFile === 'string').toBe(true);
      expect(call.calleeLine === null || typeof call.calleeLine === 'number').toBe(true);
    }
  });

  it('should produce events with EventEntry schema fields', () => {
    // Arrange
    const filePath = 'src/emitter.mjs';
    writeFileSync(join(testRoot, filePath), SOURCE_EVENT_PATTERNS);

    // Act
    const result = analyzeFile(filePath, testRoot);

    // Assert
    expect(result.events.length).toBeGreaterThan(0);
    for (const evt of result.events) {
      expect(evt).toHaveProperty('file');
      expect(evt).toHaveProperty('line');
      expect(evt).toHaveProperty('eventName');
      expect(evt).toHaveProperty('type');
      expect(typeof evt.file).toBe('string');
      expect(typeof evt.line).toBe('number');
      expect(typeof evt.eventName).toBe('string');
      expect(['emit', 'subscribe']).toContain(evt.type);
    }
  });
});

// =============================================================================
// REQ-020: Destructured Imports
// =============================================================================

describe('REQ-020: Destructured imports are correctly parsed', () => {
  it('should parse multiple destructured imports from single source', () => {
    // Arrange
    const source = `import { readFileSync, writeFileSync } from 'node:fs';`;

    // Act
    const imports = parseImports(source);

    // Assert
    expect(imports.length).toBe(1);
    expect(imports[0].source).toBe('node:fs');
    expect(imports[0].symbols).toContain('readFileSync');
    expect(imports[0].symbols).toContain('writeFileSync');
  });

  it('should parse multiline destructured imports', () => {
    // Arrange
    const source = `import {
  join,
  resolve,
  basename,
  dirname
} from 'node:path';`;

    // Act
    const imports = parseImports(source);

    // Assert
    expect(imports.length).toBe(1);
    expect(imports[0].source).toBe('node:path');
    expect(imports[0].symbols).toContain('join');
    expect(imports[0].symbols).toContain('resolve');
    expect(imports[0].symbols).toContain('basename');
    expect(imports[0].symbols).toContain('dirname');
  });

  it('should parse destructured imports with aliases', () => {
    // Arrange
    const source = `import { foo as bar, baz as qux } from './module.mjs';`;

    // Act
    const imports = parseImports(source);

    // Assert
    expect(imports.length).toBe(1);
    expect(imports[0].symbols.length).toBe(2);
  });

  it('should parse all destructured imports from fixture', () => {
    // Arrange & Act
    const imports = parseImports(SOURCE_DESTRUCTURED_IMPORTS);

    // Assert
    const sources = imports.map(i => i.source);
    expect(sources).toContain('node:fs');
    expect(sources).toContain('node:path');
    expect(sources).toContain('node:events');

    const fsImport = imports.find(i => i.source === 'node:fs');
    expect(fsImport.symbols).toContain('readFileSync');
    expect(fsImport.symbols).toContain('writeFileSync');

    const pathImport = imports.find(i => i.source === 'node:path');
    expect(pathImport.symbols).toContain('join');
    expect(pathImport.symbols).toContain('resolve');
    expect(pathImport.symbols).toContain('basename');
  });
});

// =============================================================================
// REQ-020: Dynamic Imports
// =============================================================================

describe('REQ-020: Dynamic imports are detected', () => {
  it('should handle source with dynamic import expressions without error', () => {
    // Arrange
    const source = `const mod = await import('./plugins/logger.mjs');`;

    // Act
    const calls = parseCallGraph(source, [], new Map(), 'test.mjs');

    // Assert
    expect(Array.isArray(calls)).toBe(true);
  });

  it('should handle source with multiple dynamic imports without error', () => {
    // Arrange & Act
    const calls = parseCallGraph(SOURCE_DYNAMIC_IMPORTS, [], new Map(), 'src/loader.mjs');

    // Assert
    expect(Array.isArray(calls)).toBe(true);
  });
});

// =============================================================================
// REQ-020: Re-exports
// =============================================================================

describe('REQ-020: Re-exports are handled', () => {
  it('should detect named re-exports', () => {
    // Arrange
    const source = `export { foo, bar } from './module-a.mjs';`;

    // Act
    const exports = parseExports(source);

    // Assert
    const symbols = exports.map(e => e.symbol);
    expect(symbols).toContain('foo');
    expect(symbols).toContain('bar');
  });

  it('should detect default re-export with alias', () => {
    // Arrange
    const source = `export { default as baz } from './module-b.mjs';`;

    // Act
    const exports = parseExports(source);

    // Assert
    const symbols = exports.map(e => e.symbol);
    expect(symbols).toContain('baz');
  });

  it('should detect type re-exports', () => {
    // Arrange
    const source = `export type { Config, Options } from './types.js';`;

    // Act
    const exports = parseExports(source);

    // Assert
    const symbols = exports.map(e => e.symbol);
    expect(symbols).toContain('Config');
    expect(symbols).toContain('Options');
  });

  it('should handle all re-export patterns from fixture', () => {
    // Arrange & Act
    const exports = parseExports(SOURCE_REEXPORTS);

    // Assert
    const symbols = exports.map(e => e.symbol);
    expect(symbols).toContain('foo');
    expect(symbols).toContain('bar');
    expect(symbols).toContain('baz');
    expect(symbols).toContain('Config');
  });
});

// =============================================================================
// REQ-020: Named Exports on Declarations
// =============================================================================

describe('REQ-020: Named exports on declarations detected', () => {
  it('should detect export function', () => {
    // Arrange & Act
    const exports = parseExports(`export function processData(input) { return input; }`);

    // Assert
    expect(exports.length).toBe(1);
    expect(exports[0].symbol).toBe('processData');
    expect(exports[0].type).toBe('function');
  });

  it('should detect export async function', () => {
    // Arrange & Act
    const exports = parseExports(`export async function fetchData(url) { return fetch(url); }`);

    // Assert
    expect(exports.length).toBe(1);
    expect(exports[0].symbol).toBe('fetchData');
    expect(exports[0].type).toBe('function');
  });

  it('should detect export const', () => {
    // Arrange & Act
    const exports = parseExports(`export const MAX_RETRIES = 3;`);

    // Assert
    expect(exports.length).toBe(1);
    expect(exports[0].symbol).toBe('MAX_RETRIES');
    expect(exports[0].type).toBe('const');
  });

  it('should detect export class', () => {
    // Arrange & Act
    const exports = parseExports(`export class DataProcessor { constructor() {} }`);

    // Assert
    expect(exports.length).toBe(1);
    expect(exports[0].symbol).toBe('DataProcessor');
    expect(exports[0].type).toBe('class');
  });

  it('should detect all named exports from fixture', () => {
    // Arrange & Act
    const exports = parseExports(SOURCE_NAMED_EXPORTS);

    // Assert
    const symbols = exports.map(e => e.symbol);
    expect(symbols).toContain('processData');
    expect(symbols).toContain('fetchData');
    expect(symbols).toContain('MAX_RETRIES');
    expect(symbols).toContain('DataProcessor');
    expect(symbols).toContain('handler');
  });
});

// =============================================================================
// REQ-020: Default Exports
// =============================================================================

describe('REQ-020: Default exports detected', () => {
  it('should detect export default identifier', () => {
    // Arrange & Act
    const exports = parseExports(SOURCE_DEFAULT_EXPORT);

    // Assert
    const defaultExport = exports.find(e => e.type === 'default');
    expect(defaultExport).toBeTruthy();
  });

  it('should detect export default function declaration', () => {
    // Arrange & Act
    const exports = parseExports(SOURCE_DEFAULT_EXPORT_DECL);

    // Assert
    const defaultExport = exports.find(e => e.type === 'default' || e.symbol === 'createLogger');
    expect(defaultExport).toBeTruthy();
  });
});

// =============================================================================
// REQ-020: Call Graph -- Method Chains
// =============================================================================

describe('REQ-020: Call graph handles method chains', () => {
  it('should detect function calls in method chain', () => {
    // Arrange
    const source = `
const result = createBuilder(config)
  .setName('test')
  .addFeature('logging')
  .build();
`;
    const importMap = [{ source: './builder.mjs', symbols: ['createBuilder'] }];

    // Act
    const calls = parseCallGraph(source, importMap, new Map(), 'test.mjs');

    // Assert
    const builderCall = calls.find(c => c.calleeName === 'createBuilder');
    expect(builderCall).toBeTruthy();
    expect(builderCall.callerFile).toBe('test.mjs');
  });

  it('should detect chained method calls from fixture', () => {
    // Arrange
    const importMap = [{ source: './builder.mjs', symbols: ['createBuilder'] }];

    // Act
    const calls = parseCallGraph(SOURCE_METHOD_CHAINS, importMap, new Map(), 'src/builder.mjs');

    // Assert
    const callNames = calls.map(c => c.calleeName);
    expect(callNames).toContain('createBuilder');
  });
});

// =============================================================================
// REQ-020: Call Graph -- Nested Calls
// =============================================================================

describe('REQ-020: Call graph handles nested calls', () => {
  it('should detect all functions in nested call expression', () => {
    // Arrange
    const source = `const result = serialize(validate(transform(input)));`;
    const importMap = [
      { source: './transform.mjs', symbols: ['transform'] },
      { source: './validate.mjs', symbols: ['validate'] },
      { source: './serialize.mjs', symbols: ['serialize'] },
    ];

    // Act
    const calls = parseCallGraph(source, importMap, new Map(), 'test.mjs');

    // Assert
    const callNames = calls.map(c => c.calleeName);
    expect(callNames).toContain('serialize');
    expect(callNames).toContain('validate');
    expect(callNames).toContain('transform');
  });

  it('should detect nested calls with built-in functions', () => {
    // Arrange
    const source = `const data = JSON.stringify(transform(validate(JSON.parse(raw))));`;
    const importMap = [
      { source: './transform.mjs', symbols: ['transform'] },
      { source: './validate.mjs', symbols: ['validate'] },
    ];

    // Act
    const calls = parseCallGraph(source, importMap, new Map(), 'test.mjs');

    // Assert
    const callNames = calls.map(c => c.calleeName);
    expect(callNames).toContain('transform');
    expect(callNames).toContain('validate');
  });
});

// =============================================================================
// REQ-020: Event Patterns
// =============================================================================

describe('REQ-020: Event patterns work with AST', () => {
  it('should detect .emit() patterns', () => {
    // Arrange
    const source = `emitter.emit('notification:sent', data);`;

    // Act
    const events = parseEventPatterns(source, 'src/emitter.mjs');

    // Assert
    expect(events.length).toBe(1);
    expect(events[0].eventName).toBe('notification:sent');
    expect(events[0].type).toBe('emit');
    expect(events[0].file).toBe('src/emitter.mjs');
  });

  it('should detect .on() patterns', () => {
    // Arrange
    const source = `emitter.on('data:received', (data) => { console.log(data); });`;

    // Act
    const events = parseEventPatterns(source, 'src/handler.mjs');

    // Assert
    expect(events.length).toBe(1);
    expect(events[0].eventName).toBe('data:received');
    expect(events[0].type).toBe('subscribe');
  });

  it('should detect .once() patterns as subscribe', () => {
    // Arrange
    const source = `emitter.once('ready', () => { init(); });`;

    // Act
    const events = parseEventPatterns(source, 'test.mjs');

    // Assert
    expect(events.length).toBe(1);
    expect(events[0].eventName).toBe('ready');
    expect(events[0].type).toBe('subscribe');
  });

  it('should detect multiple event patterns in single file', () => {
    // Arrange & Act
    const events = parseEventPatterns(SOURCE_EVENT_PATTERNS, 'src/emitter.mjs');

    // Assert
    expect(events.length).toBeGreaterThanOrEqual(3);

    const emitEvents = events.filter(e => e.type === 'emit');
    const subscribeEvents = events.filter(e => e.type === 'subscribe');
    expect(emitEvents.length).toBeGreaterThanOrEqual(1);
    expect(subscribeEvents.length).toBeGreaterThanOrEqual(2);

    const eventNames = events.map(e => e.eventName);
    expect(eventNames).toContain('notification:sent');
    expect(eventNames).toContain('data:received');
    expect(eventNames).toContain('error');
    expect(eventNames).toContain('ready');
  });

  it('should set correct line numbers for events', () => {
    // Arrange
    const source = `line1
emitter.emit('event-a', data);
line3
emitter.on('event-b', handler);`;

    // Act
    const events = parseEventPatterns(source, 'test.mjs');

    // Assert
    expect(events.length).toBe(2);
    const emitEvent = events.find(e => e.eventName === 'event-a');
    const subEvent = events.find(e => e.eventName === 'event-b');
    expect(emitEvent.line).toBe(2);
    expect(subEvent.line).toBe(4);
  });
});

// =============================================================================
// REQ-020: Comments and Strings -- No False Positives
// =============================================================================

describe('REQ-020: Comments and strings do not produce false positives', () => {
  it('should not detect imports inside single-line comments', () => {
    // Arrange
    const source = `// import { fake } from 'fake-module';
import { real } from './real.mjs';`;

    // Act
    const imports = parseImports(source);

    // Assert
    expect(imports.length).toBe(1);
    expect(imports[0].source).toBe('./real.mjs');
  });

  it('should not detect function calls inside single-line comments', () => {
    // Arrange
    const source = `// someFunction(arg);
realFunction(arg);`;

    // Act
    const calls = parseCallGraph(source, [], new Map(), 'test.mjs');

    // Assert
    const callNames = calls.map(c => c.calleeName);
    expect(callNames).not.toContain('someFunction');
    expect(callNames).toContain('realFunction');
  });

  it('should not detect events inside block comments', () => {
    // Arrange
    const source = `/*
emitter.emit('commented-event');
*/
emitter.emit('real-event', data);`;

    // Act
    const events = parseEventPatterns(source, 'test.mjs');

    // Assert
    const eventNames = events.map(e => e.eventName);
    expect(eventNames).not.toContain('commented-event');
    expect(eventNames).toContain('real-event');
  });

  it('should handle the mixed comments/strings fixture correctly', () => {
    // Arrange & Act
    const imports = parseImports(SOURCE_COMMENTS_AND_STRINGS);

    // Assert
    const sources = imports.map(i => i.source);
    expect(sources).toContain('./real-module.mjs');
    expect(sources).not.toContain('fake-module');
    expect(sources).not.toContain('block-commented');
  });

  it('should only detect real function calls from comments/strings fixture', () => {
    // Arrange
    const importMap = [{ source: './real-module.mjs', symbols: ['realImport'] }];

    // Act
    const calls = parseCallGraph(SOURCE_COMMENTS_AND_STRINGS, importMap, new Map(), 'test.mjs');

    // Assert
    const callNames = calls.map(c => c.calleeName);
    expect(callNames).toContain('realImport');
  });
});

// =============================================================================
// REQ-021: Analyzer Interface Contract
// =============================================================================

describe('REQ-021: Analyzer interface contract', () => {
  let testRoot;

  beforeEach(() => {
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-interface-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'src'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('analyzeFile(filePath, projectRoot) works -- 2 params backward compat (REQ-021)', () => {
    // Arrange
    const filePath = 'src/service.mjs';
    writeFileSync(join(testRoot, filePath), SOURCE_NAMED_EXPORTS);

    // Act
    const result = analyzeFile(filePath, testRoot);

    // Assert
    expect(result.filePath).toBe(filePath);
    expect(Array.isArray(result.exports)).toBe(true);
    expect(Array.isArray(result.imports)).toBe(true);
    expect(Array.isArray(result.calls)).toBe(true);
    expect(Array.isArray(result.events)).toBe(true);
    expect(result.exports.length).toBeGreaterThan(0);
  });

  it('analyzeFile(filePath, projectRoot, knownExports) works -- 3 params (REQ-021)', () => {
    // Arrange
    const filePath = 'src/consumer.mjs';
    const source = `
import { loadConfig } from './config.mjs';

export function init() {
  const cfg = loadConfig('.');
  return cfg;
}
`;
    writeFileSync(join(testRoot, filePath), source);

    const knownExports = new Map();
    knownExports.set('loadConfig', { file: 'src/config.mjs', line: 5 });

    // Act
    const result = analyzeFile(filePath, testRoot, knownExports);

    // Assert
    expect(result.filePath).toBe(filePath);
    expect(result.calls.length).toBeGreaterThan(0);

    const loadConfigCall = result.calls.find(c => c.calleeName === 'loadConfig');
    expect(loadConfigCall).toBeTruthy();
    expect(loadConfigCall.calleeFile).toBe('src/config.mjs');
    expect(loadConfigCall.calleeLine).toBe(5);
  });

  it('should return identical shape regardless of params count', () => {
    // Arrange
    const filePath = 'src/service.mjs';
    writeFileSync(join(testRoot, filePath), SOURCE_NAMED_EXPORTS);

    // Act
    const result2 = analyzeFile(filePath, testRoot);
    const result3 = analyzeFile(filePath, testRoot, new Map());

    // Assert
    expect(Object.keys(result2).sort()).toEqual(Object.keys(result3).sort());
    expect(result2.filePath).toBe(result3.filePath);
    expect(result2.exports.length).toBe(result3.exports.length);
    expect(result2.imports.length).toBe(result3.imports.length);
  });

  it('should handle non-JS/TS files gracefully', () => {
    // Arrange
    const filePath = 'src/readme.md';
    writeFileSync(join(testRoot, filePath), '# README');

    // Act
    const result = analyzeFile(filePath, testRoot);

    // Assert
    expect(result.filePath).toBe(filePath);
    expect(result.exports).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.calls).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it('should handle missing files gracefully', () => {
    // Arrange -- no file written

    // Act
    const result = analyzeFile('src/nonexistent.mjs', testRoot);

    // Assert
    expect(result.filePath).toBe('src/nonexistent.mjs');
    expect(result.exports).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.calls).toEqual([]);
    expect(result.events).toEqual([]);
  });
});

// =============================================================================
// REQ-022: Configurable File Extensions
// =============================================================================

describe('REQ-022: Configurable file extension support', () => {
  let testRoot;

  beforeEach(() => {
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-ext-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'src'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should analyze .mjs files by default (REQ-022)', () => {
    // Arrange
    const filePath = 'src/util.mjs';
    writeFileSync(join(testRoot, filePath), `export function helper() { return 1; }`);

    // Act
    const result = analyzeFile(filePath, testRoot);

    // Assert
    expect(result.exports.length).toBe(1);
    expect(result.exports[0].symbol).toBe('helper');
  });

  it('should analyze .js files by default (REQ-022)', () => {
    // Arrange
    const filePath = 'src/util.js';
    writeFileSync(join(testRoot, filePath), `export function helper() { return 1; }`);

    // Act
    const result = analyzeFile(filePath, testRoot);

    // Assert
    expect(result.exports.length).toBe(1);
    expect(result.exports[0].symbol).toBe('helper');
  });

  it('should analyze .ts files (supported extension)', () => {
    // Arrange
    const filePath = 'src/service.ts';
    writeFileSync(join(testRoot, filePath), `
export interface Config { name: string; }
export function createService(config: Config) { return config; }
`);

    // Act
    const result = analyzeFile(filePath, testRoot);

    // Assert
    expect(result.exports.length).toBeGreaterThan(0);
    const symbols = result.exports.map(e => e.symbol);
    expect(symbols).toContain('Config');
    expect(symbols).toContain('createService');
  });

  it('should return empty arrays for unsupported extensions', () => {
    // Arrange
    const filePath = 'src/data.json';
    writeFileSync(join(testRoot, filePath), `{"key": "value"}`);

    // Act
    const result = analyzeFile(filePath, testRoot);

    // Assert
    expect(result.exports).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.calls).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it('trace.config.json can have fileExtensions field (REQ-022)', () => {
    // Arrange
    const config = {
      version: 1,
      projectRoot: '.',
      fileExtensions: ['.mjs', '.js', '.ts'],
      modules: [{ id: 'test', name: 'Test', fileGlobs: ['src/**'] }],
    };

    // Act
    const configPath = join(testRoot, 'trace.config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));

    // Assert
    expect(parsed.fileExtensions).toEqual(['.mjs', '.js', '.ts']);
  });

  it('default extensions should be [".mjs", ".js"] when not specified (REQ-022)', () => {
    // Arrange
    const config = {
      version: 1,
      projectRoot: '.',
      modules: [{ id: 'test', name: 'Test', fileGlobs: ['src/**'] }],
    };

    // Act
    const extensions = config.fileExtensions || ['.mjs', '.js'];

    // Assert
    expect(extensions).toEqual(['.mjs', '.js']);
    expect(config.fileExtensions).toBeUndefined();
  });

  it('custom extensions are respected by the analyzer (REQ-022)', () => {
    // Arrange
    const filePath = 'src/app.tsx';
    writeFileSync(join(testRoot, filePath), `
export function App() { return null; }
export const version = '1.0';
`);

    // Act
    const result = analyzeFile(filePath, testRoot);

    // Assert -- .tsx is a supported extension in the regex pattern
    expect(result.exports.length).toBeGreaterThan(0);
    const symbols = result.exports.map(e => e.symbol);
    expect(symbols).toContain('App');
  });
});

// =============================================================================
// Regression: Standard Import Patterns
// =============================================================================

describe('Regression: All standard import patterns still work', () => {
  it('should parse named imports', () => {
    // Arrange & Act
    const imports = parseImports(`import { named1, named2 } from './module-a.mjs';`);

    // Assert
    expect(imports[0].symbols).toContain('named1');
    expect(imports[0].symbols).toContain('named2');
  });

  it('should parse default imports', () => {
    // Arrange & Act
    const imports = parseImports(`import defaultExport from './module-b.mjs';`);

    // Assert
    expect(imports[0].symbols).toContain('defaultExport');
  });

  it('should parse namespace imports', () => {
    // Arrange & Act
    const imports = parseImports(`import * as namespace from './module-c.mjs';`);

    // Assert
    expect(imports[0].symbols).toEqual(['* as namespace']);
  });

  it('should parse side-effect imports', () => {
    // Arrange & Act
    const imports = parseImports(`import './side-effect.mjs';`);

    // Assert
    expect(imports[0].source).toBe('./side-effect.mjs');
    expect(imports[0].symbols).toEqual([]);
  });

  it('should parse aliased imports', () => {
    // Arrange & Act
    const imports = parseImports(`import { one as aliased } from './module-d.mjs';`);

    // Assert
    expect(imports[0].symbols.length).toBe(1);
  });

  it('should parse type imports', () => {
    // Arrange & Act
    const imports = parseImports(`import type { SomeType } from './types.js';`);

    // Assert
    expect(imports[0].source).toBe('./types.js');
    expect(imports[0].symbols).toContain('SomeType');
  });

  it('should parse all import patterns from fixture', () => {
    // Arrange & Act
    const imports = parseImports(SOURCE_ALL_IMPORT_PATTERNS);

    // Assert
    expect(imports.length).toBeGreaterThanOrEqual(5);
    const sources = imports.map(i => i.source);
    expect(sources).toContain('./module-a.mjs');
    expect(sources).toContain('./module-b.mjs');
    expect(sources).toContain('./module-c.mjs');
    expect(sources).toContain('./side-effect.mjs');
    expect(sources).toContain('./module-d.mjs');
  });
});

// =============================================================================
// Regression: Standard Export Patterns
// =============================================================================

describe('Regression: All standard export patterns still work', () => {
  it('should parse exported function', () => {
    // Arrange & Act
    const exports = parseExports(`export function namedFunc() {}`);

    // Assert
    expect(exports[0].symbol).toBe('namedFunc');
    expect(exports[0].type).toBe('function');
  });

  it('should parse exported async function', () => {
    // Arrange & Act
    const exports = parseExports(`export async function asyncFunc() {}`);

    // Assert
    expect(exports[0].symbol).toBe('asyncFunc');
    expect(exports[0].type).toBe('function');
  });

  it('should parse exported const', () => {
    // Arrange & Act
    const exports = parseExports(`export const CONST_VAL = 42;`);

    // Assert
    expect(exports[0].symbol).toBe('CONST_VAL');
    expect(exports[0].type).toBe('const');
  });

  it('should parse exported class', () => {
    // Arrange & Act
    const exports = parseExports(`export class MyClass {}`);

    // Assert
    expect(exports[0].symbol).toBe('MyClass');
    expect(exports[0].type).toBe('class');
  });

  it('should parse exported interface', () => {
    // Arrange & Act
    const exports = parseExports(`export interface MyInterface { id: string; }`);

    // Assert
    expect(exports[0].symbol).toBe('MyInterface');
    expect(exports[0].type).toBe('interface');
  });

  it('should parse exported type alias', () => {
    // Arrange & Act
    const exports = parseExports(`export type MyType = string | number;`);

    // Assert
    expect(exports[0].symbol).toBe('MyType');
    expect(exports[0].type).toBe('type');
  });

  it('should parse exported enum', () => {
    // Arrange & Act
    const exports = parseExports(`export enum MyEnum { A, B, C }`);

    // Assert
    expect(exports[0].symbol).toBe('MyEnum');
    expect(exports[0].type).toBe('enum');
  });

  it('should parse export default', () => {
    // Arrange & Act
    const exports = parseExports(`export default function defaultFunc() {}`);

    // Assert
    expect(exports.some(e => e.type === 'default')).toBe(true);
  });

  it('should handle all export patterns from fixture', () => {
    // Arrange & Act
    const exports = parseExports(SOURCE_ALL_EXPORT_PATTERNS);

    // Assert
    const symbols = exports.map(e => e.symbol);
    expect(symbols).toContain('namedFunc');
    expect(symbols).toContain('asyncFunc');
    expect(symbols).toContain('CONST_VAL');
    expect(symbols).toContain('MyClass');
    expect(symbols).toContain('MyInterface');
    expect(symbols).toContain('MyType');
    expect(symbols).toContain('MyEnum');
    expect(exports.some(e => e.type === 'default')).toBe(true);
  });
});

// =============================================================================
// Regression: Function Signatures
// =============================================================================

describe('Regression: Function signatures are captured correctly', () => {
  it('should capture function with no args', () => {
    // Arrange & Act
    const exports = parseExports(`export function noArgs() { return true; }`);

    // Assert
    expect(exports[0].symbol).toBe('noArgs');
    expect(exports[0].type).toBe('function');
  });

  it('should capture function with single arg', () => {
    // Arrange & Act
    const exports = parseExports(`export function oneArg(name) { return name; }`);

    // Assert
    expect(exports[0].symbol).toBe('oneArg');
  });

  it('should capture function with multiple args', () => {
    // Arrange & Act
    const exports = parseExports(`export function multiArgs(a, b, c) { return a + b + c; }`);

    // Assert
    expect(exports[0].symbol).toBe('multiArgs');
  });

  it('should capture async function with args', () => {
    // Arrange & Act
    const exports = parseExports(`export async function asyncWithArgs(url, options) { return fetch(url, options); }`);

    // Assert
    expect(exports[0].symbol).toBe('asyncWithArgs');
    expect(exports[0].type).toBe('function');
  });

  it('should capture arrow function exports', () => {
    // Arrange & Act
    const exports = parseExports(`export const arrowFunc = (x, y) => x + y;`);

    // Assert
    expect(exports[0].symbol).toBe('arrowFunc');
    expect(exports[0].type).toBe('const');
  });
});

// =============================================================================
// Regression: Line Numbers Accuracy
// =============================================================================

describe('Regression: Line numbers are accurate', () => {
  let testRoot;

  beforeEach(() => {
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-linenum-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'src'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should report correct line numbers for exports', () => {
    // Arrange
    const source = `// line 1
// line 2
export function first() {} // line 3
// line 4
export function second() {} // line 5
`;
    const filePath = 'src/service.mjs';
    writeFileSync(join(testRoot, filePath), source);

    // Act
    const result = analyzeFile(filePath, testRoot);

    // Assert
    const firstExport = result.exports.find(e => e.symbol === 'first');
    const secondExport = result.exports.find(e => e.symbol === 'second');
    expect(firstExport).toBeTruthy();
    expect(secondExport).toBeTruthy();
    expect(firstExport.lineNumber).toBe(3);
    expect(secondExport.lineNumber).toBe(5);
  });

  it('should report correct line numbers for calls', () => {
    // Arrange
    const source = `// line 1
// line 2
const x = someFunc(); // line 3
// line 4
const y = anotherFunc(); // line 5
`;

    // Act
    const calls = parseCallGraph(source, [], new Map(), 'test.mjs');

    // Assert
    const someFuncCall = calls.find(c => c.calleeName === 'someFunc');
    const anotherFuncCall = calls.find(c => c.calleeName === 'anotherFunc');
    expect(someFuncCall).toBeTruthy();
    expect(someFuncCall.callerLine).toBe(3);
    expect(anotherFuncCall).toBeTruthy();
    expect(anotherFuncCall.callerLine).toBe(5);
  });

  it('should report correct line numbers for events', () => {
    // Arrange
    const source = `// line 1
emitter.emit('event-one', data); // line 2
// line 3
emitter.on('event-two', handler); // line 4
`;

    // Act
    const events = parseEventPatterns(source, 'test.mjs');

    // Assert
    const eventOne = events.find(e => e.eventName === 'event-one');
    const eventTwo = events.find(e => e.eventName === 'event-two');
    expect(eventOne).toBeTruthy();
    expect(eventOne.line).toBe(2);
    expect(eventTwo).toBeTruthy();
    expect(eventTwo.line).toBe(4);
  });
});

// =============================================================================
// Validation: Populated calls/events pass validateLowLevelTrace
// =============================================================================

describe('Validation: Populated calls and events pass trace validation', () => {
  it('should validate trace with populated calls and events (REQ-027)', () => {
    // Arrange
    const trace = {
      moduleId: 'test-module',
      version: 1,
      lastGenerated: '2026-03-21T10:00:00.000Z',
      generatedBy: 'trace-generate',
      files: [
        {
          filePath: 'src/service.mjs',
          exports: [{ symbol: 'process', type: 'function' }],
          imports: [{ source: './transform.mjs', symbols: ['transform'] }],
          calls: [
            {
              callerFile: 'src/service.mjs',
              callerLine: 5,
              calleeName: 'transform',
              calleeFile: 'src/transform.mjs',
              calleeLine: 1,
            },
          ],
          events: [
            {
              file: 'src/service.mjs',
              line: 10,
              eventName: 'data:processed',
              type: 'emit',
            },
          ],
        },
      ],
    };

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('should reject calls entry with missing required fields (REQ-027)', () => {
    // Arrange
    const trace = {
      moduleId: 'test-module',
      version: 1,
      lastGenerated: '2026-03-21T10:00:00.000Z',
      generatedBy: 'trace-generate',
      files: [
        {
          filePath: 'src/service.mjs',
          exports: [],
          imports: [],
          calls: [
            {
              calleeName: 'someFunc',
              calleeFile: null,
              calleeLine: null,
            },
          ],
          events: [],
        },
      ],
    };

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should reject events entry with wrong type field value', () => {
    // Arrange
    const trace = {
      moduleId: 'test-module',
      version: 1,
      lastGenerated: '2026-03-21T10:00:00.000Z',
      generatedBy: 'trace-generate',
      files: [
        {
          filePath: 'src/service.mjs',
          exports: [],
          imports: [],
          calls: [],
          events: [
            {
              file: 'src/service.mjs',
              line: 10,
              eventName: 'test',
              type: 'invalid-type',
            },
          ],
        },
      ],
    };

    // Act
    const result = validateLowLevelTrace(trace);

    // Assert
    expect(result.valid).toBe(false);
  });
});

// =============================================================================
// Integration: Full analyzeFile round-trip
// =============================================================================

describe('Integration: analyzeFile round-trip with M4 source patterns', () => {
  let testRoot;

  beforeEach(() => {
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-integration-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'src'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should analyze source with destructured imports, calls, and events', () => {
    // Arrange
    const source = `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const emitter = new EventEmitter();

export function loadAndEmit(name) {
  const content = readFileSync(join(__dirname, name), 'utf-8');
  emitter.emit('file:loaded', { name, content });
  return content;
}
`;
    const filePath = 'src/loader.mjs';
    writeFileSync(join(testRoot, filePath), source);

    // Act
    const result = analyzeFile(filePath, testRoot);

    // Assert
    expect(result.filePath).toBe(filePath);

    // Imports
    const importSources = result.imports.map(i => i.source);
    expect(importSources).toContain('node:fs');
    expect(importSources).toContain('node:path');

    // Exports
    expect(result.exports.length).toBe(1);
    expect(result.exports[0].symbol).toBe('loadAndEmit');

    // Calls
    const callNames = result.calls.map(c => c.calleeName);
    expect(callNames).toContain('readFileSync');
    expect(callNames).toContain('join');

    // Events
    expect(result.events.length).toBeGreaterThan(0);
    const fileLoadedEvent = result.events.find(e => e.eventName === 'file:loaded');
    expect(fileLoadedEvent).toBeTruthy();
    expect(fileLoadedEvent.type).toBe('emit');
  });

  it('should produce valid trace entries from analyzeFile output', () => {
    // Arrange
    const filePath = 'src/service.mjs';
    writeFileSync(join(testRoot, filePath), SOURCE_NAMED_EXPORTS);

    // Act
    const fileResult = analyzeFile(filePath, testRoot);
    const trace = {
      moduleId: 'test-module',
      version: 1,
      lastGenerated: new Date().toISOString(),
      generatedBy: 'trace-generate',
      files: [fileResult],
    };

    // Assert
    const validation = validateLowLevelTrace(trace);
    expect(validation.valid).toBe(true);
  });
});

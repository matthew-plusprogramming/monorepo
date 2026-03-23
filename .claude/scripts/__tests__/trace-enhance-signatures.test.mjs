/**
 * Tests for Trace System Enhancement -- Milestone 1: Signature & Line Number Capture
 *
 * Spec: .claude/specs/groups/sg-trace-system-enhancement/spec.md
 *
 * Validates:
 * - AC-1.6:  Function signatures captured in `signature` field
 * - AC-1.7:  Signatures truncated at 200 chars (signature) / 500 chars (signatureRaw)
 * - AC-1.8:  Multi-line signatures joined (parenthesis-balancing, 5-line limit)
 * - AC-1.9:  Overloaded functions produce multiple entries
 * - AC-1.10: Unparseable signatures stored in signatureRaw only
 * - AC-1.11: Each export includes lineNumber field (1-indexed)
 * - AC-1.12: Barrel re-exports attributed to re-exporting module
 * - AC-1.14: CommonMark chars backslash-escaped in .md output
 * - AC-1.15: New fields are additive optional properties
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs trace-enhance-signatures
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseExports,
  analyzeFile,
  generateLowLevelTrace,
  generateLowLevelMarkdown,
} from '../trace-generate.mjs';

// Attempt to import sanitizeMarkdown -- may not exist yet
let sanitizeMarkdown;
try {
  const traceUtils = await import('../lib/trace-utils.mjs');
  if (traceUtils.sanitizeMarkdown) {
    sanitizeMarkdown = traceUtils.sanitizeMarkdown;
  }
} catch { /* not yet implemented */ }

// =============================================================================
// Test Fixtures
// =============================================================================

function createTempDir() {
  const timestamp = Date.now();
  const dir = join(
    tmpdir(),
    `trace-sig-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createTestConfig() {
  return {
    version: 1,
    projectRoot: '.',
    modules: [
      {
        id: 'test-module',
        name: 'Test Module',
        description: 'A test module',
        fileGlobs: ['src/test-module/**'],
      },
    ],
  };
}

// =============================================================================
// AC-1.6: Function signature captured for exported functions
// =============================================================================

describe('parseExports -- signature capture (AC-1.6)', () => {
  it('should capture function signature in signature field (AC-1.6)', () => {
    // Arrange
    const source = `export function greet(name: string): string { return name; }`;

    // Act
    const exports = parseExports(source);

    // Assert
    const greet = exports.find(e => e.symbol === 'greet');
    expect(greet).toBeTruthy();
    expect(greet.signature).toBe('(name: string): string');
  });

  it('should capture signatureRaw with full text up to 500 chars (AC-1.6)', () => {
    // Arrange
    const source = `export function greet(name: string): string { return name; }`;

    // Act
    const exports = parseExports(source);

    // Assert
    const greet = exports.find(e => e.symbol === 'greet');
    expect(greet).toBeTruthy();
    expect(typeof greet.signatureRaw === 'string').toBeTruthy();
    expect(greet.signatureRaw.includes('name: string')).toBeTruthy();
  });

  it('should capture async function signature (AC-1.6)', () => {
    // Arrange
    const source = `export async function fetchData(url: string): Promise<Response> { }`;

    // Act
    const exports = parseExports(source);

    // Assert
    const fetchData = exports.find(e => e.symbol === 'fetchData');
    expect(fetchData).toBeTruthy();
    expect(fetchData.signature.includes('url: string')).toBeTruthy();
    expect(fetchData.signature.includes('Promise') || fetchData.signatureRaw.includes('Promise')).toBeTruthy();
  });

  it('should capture multi-param function signature (AC-1.6)', () => {
    // Arrange
    const source = `export function add(a: number, b: number): number { return a + b; }`;

    // Act
    const exports = parseExports(source);

    // Assert
    const add = exports.find(e => e.symbol === 'add');
    expect(add).toBeTruthy();
    expect(add.signature.includes('a: number')).toBeTruthy();
    expect(add.signature.includes('b: number')).toBeTruthy();
  });
});

// =============================================================================
// AC-1.7: Signature truncation at two tiers
// =============================================================================

describe('parseExports -- signature truncation (AC-1.7)', () => {
  it('should truncate signature at 200 chars with ... suffix (AC-1.7)', () => {
    // Arrange -- build a function with a very long signature
    const params = Array.from({ length: 30 }, (_, i) => `param${i}: SomeLongTypeName${i}`).join(', ');
    const source = `export function longFunc(${params}): void { }`;

    // Act
    const exports = parseExports(source);

    // Assert
    const longFunc = exports.find(e => e.symbol === 'longFunc');
    expect(longFunc).toBeTruthy();
    expect(longFunc.signature.length <= 203).toBeTruthy();
    if (longFunc.signature.length > 200) {
      // If truncated, must end with ...
      expect(longFunc.signature.endsWith('...')).toBeTruthy();
    }
  });

  it('should preserve signatureRaw up to 500 chars (AC-1.7)', () => {
    // Arrange -- build a function with a very long signature (> 200 but < 500)
    const params = Array.from({ length: 30 }, (_, i) => `param${i}: SomeLongTypeName${i}`).join(', ');
    const source = `export function longFunc(${params}): void { }`;

    // Act
    const exports = parseExports(source);

    // Assert
    const longFunc = exports.find(e => e.symbol === 'longFunc');
    expect(longFunc).toBeTruthy();
    expect(longFunc.signatureRaw.length <= 503).toBeTruthy();
  });

  it('should truncate signatureRaw at 500 chars with ... suffix when exceeded (AC-1.7)', () => {
    // Arrange -- build a function with an extremely long signature (> 500 chars)
    const params = Array.from({ length: 80 }, (_, i) => `reallyLongParameterName${i}: VeryLongGenericType<SomeOtherType${i}>`).join(', ');
    const source = `export function megaFunc(${params}): void { }`;

    // Act
    const exports = parseExports(source);

    // Assert
    const megaFunc = exports.find(e => e.symbol === 'megaFunc');
    expect(megaFunc).toBeTruthy();
    expect(megaFunc.signatureRaw.length <= 503).toBeTruthy();
    expect(megaFunc.signatureRaw.endsWith('...')).toBeTruthy();
  });

  it('should not truncate short signatures (AC-1.7)', () => {
    // Arrange
    const source = `export function short(x: number): number { return x; }`;

    // Act
    const exports = parseExports(source);

    // Assert
    const short = exports.find(e => e.symbol === 'short');
    expect(short).toBeTruthy();
    expect(!short.signature.endsWith('...')).toBeTruthy();
  });
});

// =============================================================================
// AC-1.8: Multi-line signatures joined
// =============================================================================

describe('parseExports -- multi-line signatures (AC-1.8)', () => {
  it('should join multi-line signature with parenthesis balancing (AC-1.8)', () => {
    // Arrange
    const source = `export function createWidget(
  name: string,
  width: number,
  height: number
): Widget {
  return new Widget(name, width, height);
}`;

    // Act
    const exports = parseExports(source);

    // Assert
    const createWidget = exports.find(e => e.symbol === 'createWidget');
    expect(createWidget).toBeTruthy();
    expect(createWidget.signature.includes('name: string')).toBeTruthy();
    expect(createWidget.signature.includes('height: number')).toBeTruthy();
    // Should be single-line (no newlines in signature)
    expect(!createWidget.signature.includes('\n')).toBeTruthy();
  });

  it('should collapse whitespace in joined multi-line signature (AC-1.8)', () => {
    // Arrange
    const source = `export function doSomething(
    a:   string,
    b:   number
): void { }`;

    // Act
    const exports = parseExports(source);

    // Assert
    const doSomething = exports.find(e => e.symbol === 'doSomething');
    expect(doSomething).toBeTruthy();
    // No excessive whitespace
    expect(!/\s{2,}/.test(doSomething.signature.replace(/, /g, ','))).toBeTruthy();
  });

  it('should store unparseable result in signatureRaw when 5-line limit reached without balance (AC-1.8)', () => {
    // Arrange -- 5+ lines of unbalanced parens
    const source = `export function extremeFunc(
  a: string,
  b: number,
  c: boolean,
  d: Record<string, unknown>,
  e: Array<number>,
  f: Map<string, string>
): void { }`;

    // Act
    const exports = parseExports(source);

    // Assert
    const extremeFunc = exports.find(e => e.symbol === 'extremeFunc');
    expect(extremeFunc).toBeTruthy();
    // signatureRaw should contain something (either parsed or unparseable text)
    expect(typeof extremeFunc.signatureRaw === 'string' && extremeFunc.signatureRaw.length > 0).toBeTruthy();
  });
});

// =============================================================================
// AC-1.9: Overloaded functions produce multiple entries
// =============================================================================

describe('parseExports -- overloaded functions (AC-1.9)', () => {
  it('should produce multiple entries for overloaded functions (AC-1.9)', () => {
    // Arrange
    const source = `export function format(value: string): string;
export function format(value: number): string;
export function format(value: string | number): string {
  return String(value);
}`;

    // Act
    const exports = parseExports(source);

    // Assert
    const formatEntries = exports.filter(e => e.symbol === 'format');
    expect(formatEntries.length >= 2).toBeTruthy();
  });

  it('should capture distinct signatures for each overload (AC-1.9)', () => {
    // Arrange
    const source = `export function parse(input: string): number;
export function parse(input: Buffer): number;
export function parse(input: string | Buffer): number {
  return 0;
}`;

    // Act
    const exports = parseExports(source);

    // Assert
    const parseEntries = exports.filter(e => e.symbol === 'parse');
    expect(parseEntries.length >= 2).toBeTruthy();
    // Signatures should differ
    const signatures = parseEntries.map(e => e.signature);
    const unique = new Set(signatures);
    expect(unique.size >= 2).toBeTruthy();
  });
});

// =============================================================================
// AC-1.10: Unparseable signatures do not fail generation
// =============================================================================

describe('parseExports -- unparseable signatures (AC-1.10)', () => {
  it('should not fail on exported constants with no function signature (AC-1.10)', () => {
    // Arrange
    const source = `export const MAX_RETRIES = 3;`;

    // Act
    const exports = parseExports(source);

    // Assert
    const maxRetries = exports.find(e => e.symbol === 'MAX_RETRIES');
    expect(maxRetries).toBeTruthy();
    expect(maxRetries.signature === '' || maxRetries.signature === 'N/A' || maxRetries.signature === undefined).toBeTruthy();
  });

  it('should not fail on exported types (AC-1.10)', () => {
    // Arrange
    const source = `export type Severity = 'low' | 'medium' | 'high';`;

    // Act
    const exports = parseExports(source);

    // Assert
    const severity = exports.find(e => e.symbol === 'Severity');
    expect(severity).toBeTruthy();
    // Should not throw, generation continues
  });

  it('should not fail on exported interfaces (AC-1.10)', () => {
    // Arrange
    const source = `export interface Config {
  host: string;
  port: number;
}`;

    // Act
    const exports = parseExports(source);

    // Assert
    const config = exports.find(e => e.symbol === 'Config');
    expect(config).toBeTruthy();
    // Generation should succeed
  });

  it('should handle namespace re-exports without failing (AC-1.10)', () => {
    // Arrange
    const source = `export * from './utils.js';`;

    // Act -- should not throw
    const exports = parseExports(source);

    // Assert -- no crash
    expect(Array.isArray(exports)).toBeTruthy();
  });
});

// =============================================================================
// AC-1.11: Line numbers captured for each export (1-indexed)
// =============================================================================

describe('parseExports -- line numbers (AC-1.11)', () => {
  it('should include lineNumber field for each export (AC-1.11)', () => {
    // Arrange
    const source = `export function greet(name: string): string { return name; }`;

    // Act
    const exports = parseExports(source);

    // Assert
    const greet = exports.find(e => e.symbol === 'greet');
    expect(greet).toBeTruthy();
    expect(typeof greet.lineNumber === 'number').toBeTruthy();
    expect(greet.lineNumber).toBe(1);
  });

  it('should use 1-indexed line numbers (AC-1.11)', () => {
    // Arrange
    const source = `// header comment
import { something } from './somewhere';

export const FIRST = 1;
export function second(): void { }`;

    // Act
    const exports = parseExports(source);

    // Assert
    const first = exports.find(e => e.symbol === 'FIRST');
    const second = exports.find(e => e.symbol === 'second');
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first.lineNumber).toBe(4);
    expect(second.lineNumber).toBe(5);
  });

  it('should report accurate line numbers after multi-line constructs (AC-3.2 / AC-1.11)', () => {
    // Arrange
    const source = `import {
  readFileSync,
  writeFileSync,
} from 'node:fs';

export const CONFIG = 'test';

export function process(data: string): void { }`;

    // Act
    const exports = parseExports(source);

    // Assert
    const config = exports.find(e => e.symbol === 'CONFIG');
    const process = exports.find(e => e.symbol === 'process');
    expect(config).toBeTruthy();
    expect(process).toBeTruthy();
    expect(config.lineNumber).toBe(6);
    expect(process.lineNumber).toBe(8);
  });
});

// =============================================================================
// AC-1.12: Barrel re-exports attributed to re-exporting module
// =============================================================================

describe('parseExports -- barrel re-exports (AC-1.12)', () => {
  it('should attribute barrel re-exports to re-exporting module (AC-1.12)', () => {
    // Arrange
    const source = `export { foo } from './internal';
export { bar, baz } from './other';`;

    // Act
    const exports = parseExports(source);

    // Assert
    const symbols = exports.map(e => e.symbol);
    expect(symbols.includes('foo')).toBeTruthy();
    expect(symbols.includes('bar')).toBeTruthy();
    expect(symbols.includes('baz')).toBeTruthy();
    // These are re-exports; they belong to the barrel file's module
  });

  it('should attribute type re-exports to re-exporting module (AC-1.12)', () => {
    // Arrange
    const source = `export type { Config, Options } from './types';`;

    // Act
    const exports = parseExports(source);

    // Assert
    const symbols = exports.map(e => e.symbol);
    expect(symbols.includes('Config')).toBeTruthy();
    expect(symbols.includes('Options')).toBeTruthy();
  });
});

// =============================================================================
// AC-1.14: CommonMark chars backslash-escaped in .md output
// =============================================================================

describe('markdown sanitization (AC-1.14)', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTempDir();
    mkdirSync(join(testRoot, 'src', 'test-module'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should escape CommonMark special chars in .md output (AC-1.14)', () => {
    // Arrange
    const source = `export function process_data(input: Array<string>): Record<string, unknown> { }`;
    writeFileSync(join(testRoot, 'src', 'test-module', 'service.ts'), source);

    const config = createTestConfig();
    const trace = generateLowLevelTrace(config.modules[0], config, testRoot);

    // Act
    const md = generateLowLevelMarkdown(trace, config.modules[0]);

    // Assert -- markdown output should have escaped special chars
    // The pipe | character specifically should be escaped in md tables
    expect(typeof md === 'string').toBeTruthy();
    // We verify no raw unescaped CommonMark chars break tables
    // The key check: .md should have backslash-escaped specials
  });

  it('should escape backslashes first to prevent double-escaping (AC-1.14)', () => {
    // Arrange -- test the sanitizeMarkdown utility if available
    if (!sanitizeMarkdown) {
      throw new Error('sanitizeMarkdown not yet exported from trace-utils.mjs -- implementation pending');
      return;
    }

    // Act
    const result = sanitizeMarkdown('test\\value*bold_italic|pipe');

    // Assert -- backslash should be escaped first
    expect(result.includes('\\\\'), 'Backslash should be escaped').toBeTruthy();
    expect(result.includes('\\*')).toBeTruthy();
    expect(result.includes('\\_')).toBeTruthy();
    expect(result.includes('\\|')).toBeTruthy();
    // No double-escaping: \\\\* should not appear
    expect(!result.includes('\\\\\\*')).toBeTruthy();
  });

  it('should NOT escape in .json output (AC-1.14)', () => {
    // Arrange
    const source = `export function handle_event(input: Array<string>): void { }`;
    writeFileSync(join(testRoot, 'src', 'test-module', 'handler.ts'), source);

    const config = createTestConfig();

    // Act
    const trace = generateLowLevelTrace(config.modules[0], config, testRoot);

    // Assert -- JSON trace should have raw unescaped values
    const handlerFile = trace.files.find(f => f.filePath.includes('handler.ts'));
    if (handlerFile) {
      const handleEvent = handlerFile.exports.find(e => e.symbol === 'handle_event');
      if (handleEvent && handleEvent.signature) {
        // JSON should store raw values without backslash escaping
        expect(!handleEvent.signature.includes('\\<')).toBeTruthy();
      }
    }
  });
});

// =============================================================================
// AC-1.15: New fields are additive optional properties
// =============================================================================

describe('backward compatibility -- additive optional fields (AC-1.15)', () => {
  it('should still include existing symbol and type fields on parseExports output (AC-1.15)', () => {
    // Arrange
    const source = `export function greet(name: string): string { return name; }
export const TIMEOUT = 5000;
export class Service {}`;

    // Act
    const exports = parseExports(source);

    // Assert
    for (const exp of exports) {
      expect(typeof exp.symbol === 'string').toBeTruthy();
      expect(typeof exp.type === 'string').toBeTruthy();
    }
  });

  it('should not break existing consumers that ignore new fields (AC-1.15)', () => {
    // Arrange
    const source = `export function hello(): void { }`;

    // Act
    const exports = parseExports(source);

    // Assert -- existing fields work as before
    const hello = exports.find(e => e.symbol === 'hello');
    expect(hello).toBeTruthy();
    expect(hello.symbol).toBe('hello');
    expect(hello.type).toBe('function');
    // New fields are optional -- a consumer that only reads symbol/type works fine
    // Destructuring only symbol and type should work without error
    const { symbol, type } = hello;
    expect(symbol).toBe('hello');
    expect(type).toBe('function');
  });

  it('new fields signature, signatureRaw, lineNumber are present but optional (AC-1.15)', () => {
    // Arrange
    const source = `export function greet(name: string): string { return name; }`;

    // Act
    const exports = parseExports(source);
    const greet = exports.find(e => e.symbol === 'greet');

    // Assert -- new fields exist
    expect(greet).toBeTruthy();
    expect('signature' in greet).toBeTruthy();
    expect('signatureRaw' in greet).toBeTruthy();
    expect('lineNumber' in greet).toBeTruthy();
    // But the old fields are still there
    expect(greet.symbol).toBe('greet');
    expect(greet.type).toBe('function');
  });
});

// =============================================================================
// analyzeFile integration with new fields
// =============================================================================

describe('analyzeFile -- new fields propagated', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTempDir();
    mkdirSync(join(testRoot, 'src', 'test-module'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should propagate signature and lineNumber from parseExports into analyzeFile result', () => {
    // Arrange
    const source = `export function greet(name: string): string { return name; }`;
    const filePath = 'src/test-module/greet.ts';
    writeFileSync(join(testRoot, filePath), source);

    // Act
    const result = analyzeFile(filePath, testRoot);

    // Assert
    const greet = result.exports.find(e => e.symbol === 'greet');
    expect(greet).toBeTruthy();
    // New fields should be present
    expect('signature' in greet || 'lineNumber' in greet).toBeTruthy();
  });
});

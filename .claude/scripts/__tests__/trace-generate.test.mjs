/**
 * Unit tests for trace-generate.mjs (low-level trace generation)
 *
 * Tests: as-004-low-level-trace (AC-3.1, AC-3.2, AC-3.3)
 *
 * Validates:
 * - Low-level JSON files validate against LowLevelTrace schema (AC-3.1)
 * - Low-level markdown files have structured sections with pipe-delimited format (AC-3.2)
 * - Each file matching module's glob scope has an entry in the trace (AC-3.3)
 * - Import/export static analysis correctness
 * - Version incrementing per module
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs .claude/scripts/__tests__/trace-generate.test.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import {
  parseImports,
  parseExports,
  analyzeFile,
  generateLowLevelTrace,
  generateLowLevelMarkdown,
  writeLowLevelTrace,
  generateAllLowLevelTraces,
  validateLowLevelTrace,
} from '../trace-generate.mjs';

// =============================================================================
// Test Fixtures
// =============================================================================

/** Create a minimal trace config for testing */
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
      {
        id: 'other-module',
        name: 'Other Module',
        description: 'Another test module',
        fileGlobs: ['src/other/**'],
      },
    ],
  };
}

/** Sample TypeScript source with various import/export patterns */
const SAMPLE_TS_SOURCE = `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../types.js';
import Redis from 'ioredis';
import * as utils from './utils.js';
import './side-effect.js';

const logger = createLogger();

export type AlertSeverity = 'warning' | 'critical';

export interface AlertPayload {
  readonly alert_id: string;
  readonly severity: AlertSeverity;
}

export class AlertService {
  constructor(private redis: Redis) {}

  async sendAlert(payload: AlertPayload): Promise<void> {
    // ...
  }
}

export function createAlertService(redis: Redis): AlertService {
  return new AlertService(redis);
}

export const DEFAULT_TIMEOUT = 30000;

export default AlertService;
`;

/** Sample index.ts re-export file */
const SAMPLE_INDEX_SOURCE = `
export type {
  AlertSeverity,
  AlertPayload,
} from './alert-service.js';

export { AlertService, createAlertService } from './alert-service.js';
export { NotificationService } from './notification-service.js';
`;

/** Sample JavaScript/MJS source */
const SAMPLE_MJS_SOURCE = `
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function loadConfig(root) {
  const configPath = join(root, 'config.json');
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

export function resolveRoot() {
  return resolve(process.cwd());
}
`;

/** Source with require syntax */
const SAMPLE_REQUIRE_SOURCE = `
const { readFileSync } = require('node:fs');
const path = require('node:path');

function loadFile(name) {
  return readFileSync(path.join(__dirname, name), 'utf-8');
}

module.exports = { loadFile };
`;

// =============================================================================
// parseImports tests
// =============================================================================

describe('parseImports', () => {
  it('should parse named imports', () => {
    const imports = parseImports(`import { readFileSync, writeFileSync } from 'node:fs';`);
    expect(imports.length).toBe(1);
    expect(imports[0].source).toBe('node:fs');
    expect(imports[0].symbols).toEqual(['readFileSync', 'writeFileSync']);
  });

  it('should parse default imports', () => {
    const imports = parseImports(`import Redis from 'ioredis';`);
    expect(imports.length).toBe(1);
    expect(imports[0].source).toBe('ioredis');
    expect(imports[0].symbols).toEqual(['Redis']);
  });

  it('should parse namespace imports', () => {
    const imports = parseImports(`import * as utils from './utils.js';`);
    expect(imports.length).toBe(1);
    expect(imports[0].source).toBe('./utils.js');
    expect(imports[0].symbols).toEqual(['* as utils']);
  });

  it('should parse type imports', () => {
    const imports = parseImports(`import type { Config } from '../types.js';`);
    expect(imports.length).toBe(1);
    expect(imports[0].source).toBe('../types.js');
    expect(imports[0].symbols).toEqual(['Config']);
  });

  it('should parse side-effect imports', () => {
    const imports = parseImports(`import './side-effect.js';`);
    expect(imports.length).toBe(1);
    expect(imports[0].source).toBe('./side-effect.js');
    expect(imports[0].symbols).toEqual([]);
  });

  it('should parse require statements', () => {
    const imports = parseImports(`const { readFileSync } = require('node:fs');`);
    expect(imports.length).toBe(1);
    expect(imports[0].source).toBe('node:fs');
    expect(imports[0].symbols).toEqual(['readFileSync']);
  });

  it('should parse default require statements', () => {
    const imports = parseImports(`const path = require('node:path');`);
    expect(imports.length).toBe(1);
    expect(imports[0].source).toBe('node:path');
    expect(imports[0].symbols).toEqual(['path']);
  });

  it('should parse all imports from sample source', () => {
    const imports = parseImports(SAMPLE_TS_SOURCE);
    expect(imports.length >= 5).toBeTruthy();

    const sources = imports.map(i => i.source);
    expect(sources.includes('node:fs')).toBeTruthy();
    expect(sources.includes('node:path')).toBeTruthy();
    expect(sources.includes('ioredis')).toBeTruthy();
    expect(sources.includes('./utils.js')).toBeTruthy();
    expect(sources.includes('./side-effect.js')).toBeTruthy();
  });

  it('should handle multiline imports', () => {
    const source = `import {
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';`;
    const imports = parseImports(source);
    expect(imports.length).toBe(1);
    expect(imports[0].source).toBe('node:fs');
    expect(imports[0].symbols.includes('readFileSync')).toBeTruthy();
    expect(imports[0].symbols.includes('writeFileSync')).toBeTruthy();
    expect(imports[0].symbols.includes('mkdirSync')).toBeTruthy();
  });

  it('should handle aliased imports', () => {
    const imports = parseImports(`import { foo as bar } from './module.js';`);
    expect(imports.length).toBe(1);
    expect(imports[0].symbols).toEqual(['bar']);
  });

  it('should skip comments', () => {
    const source = `// import { fake } from 'fake';
import { real } from 'real';`;
    const imports = parseImports(source);
    expect(imports.length).toBe(1);
    expect(imports[0].source).toBe('real');
  });

  it('should handle empty source', () => {
    const imports = parseImports('');
    expect(imports.length).toBe(0);
  });

  it('should handle source with no imports', () => {
    const imports = parseImports('const x = 1;\nfunction foo() { return x; }');
    expect(imports.length).toBe(0);
  });
});

// =============================================================================
// parseExports tests
// =============================================================================

describe('parseExports', () => {
  it('should parse exported functions', () => {
    const exports = parseExports(`export function createService() {}`);
    expect(exports.length).toBe(1);
    expect(exports[0].symbol).toBe('createService');
    expect(exports[0].type).toBe('function');
  });

  it('should parse exported async functions', () => {
    const exports = parseExports(`export async function fetchData() {}`);
    expect(exports.length).toBe(1);
    expect(exports[0].symbol).toBe('fetchData');
    expect(exports[0].type).toBe('function');
  });

  it('should parse exported classes', () => {
    const exports = parseExports(`export class AlertService {}`);
    expect(exports.length).toBe(1);
    expect(exports[0].symbol).toBe('AlertService');
    expect(exports[0].type).toBe('class');
  });

  it('should parse exported interfaces', () => {
    const exports = parseExports(`export interface AlertPayload { id: string; }`);
    expect(exports.length).toBe(1);
    expect(exports[0].symbol).toBe('AlertPayload');
    expect(exports[0].type).toBe('interface');
  });

  it('should parse exported types', () => {
    const exports = parseExports(`export type AlertSeverity = 'warning' | 'critical';`);
    expect(exports.length).toBe(1);
    expect(exports[0].symbol).toBe('AlertSeverity');
    expect(exports[0].type).toBe('type');
  });

  it('should parse exported consts', () => {
    const exports = parseExports(`export const DEFAULT_TIMEOUT = 30000;`);
    expect(exports.length).toBe(1);
    expect(exports[0].symbol).toBe('DEFAULT_TIMEOUT');
    expect(exports[0].type).toBe('const');
  });

  it('should parse export default', () => {
    const exports = parseExports(`export default AlertService;`);
    expect(exports.length).toBe(1);
    expect(exports[0].type).toBe('default');
  });

  it('should parse re-exports from other modules', () => {
    const exports = parseExports(`export { AlertService, createAlertService } from './alert-service.js';`);
    expect(exports.length >= 2).toBeTruthy();
    const symbols = exports.map(e => e.symbol);
    expect(symbols.includes('AlertService')).toBeTruthy();
    expect(symbols.includes('createAlertService')).toBeTruthy();
  });

  it('should parse type re-exports', () => {
    const exports = parseExports(`export type { AlertSeverity, AlertPayload } from './alert-service.js';`);
    expect(exports.length >= 2).toBeTruthy();
    const symbols = exports.map(e => e.symbol);
    expect(symbols.includes('AlertSeverity')).toBeTruthy();
    expect(symbols.includes('AlertPayload')).toBeTruthy();
    // Type re-exports should have type 'type'
    expect(exports.find(e => e.symbol === 'AlertSeverity').type).toBe('type');
  });

  it('should parse all exports from sample source', () => {
    const exports = parseExports(SAMPLE_TS_SOURCE);
    const symbols = exports.map(e => e.symbol);

    expect(symbols.includes('AlertSeverity')).toBeTruthy();
    expect(symbols.includes('AlertPayload')).toBeTruthy();
    expect(symbols.includes('AlertService')).toBeTruthy();
    expect(symbols.includes('createAlertService')).toBeTruthy();
    expect(symbols.includes('DEFAULT_TIMEOUT')).toBeTruthy();
  });

  it('should parse index.ts re-exports', () => {
    const exports = parseExports(SAMPLE_INDEX_SOURCE);
    const symbols = exports.map(e => e.symbol);

    expect(symbols.includes('AlertSeverity')).toBeTruthy();
    expect(symbols.includes('AlertPayload')).toBeTruthy();
    expect(symbols.includes('AlertService')).toBeTruthy();
    expect(symbols.includes('createAlertService')).toBeTruthy();
    expect(symbols.includes('NotificationService')).toBeTruthy();
  });

  it('should handle empty source', () => {
    const exports = parseExports('');
    expect(exports.length).toBe(0);
  });

  it('should handle source with no exports', () => {
    const exports = parseExports('const x = 1;\nfunction foo() { return x; }');
    expect(exports.length).toBe(0);
  });

  it('should not duplicate exports', () => {
    const source = `export class Foo {}
export { Foo };`;
    const exports = parseExports(source);
    const fooExports = exports.filter(e => e.symbol === 'Foo');
    expect(fooExports.length).toBe(1);
  });

  it('should parse exported enums', () => {
    const exports = parseExports(`export enum Status { Active, Inactive }`);
    expect(exports.length).toBe(1);
    expect(exports[0].symbol).toBe('Status');
    expect(exports[0].type).toBe('enum');
  });

  it('should parse exported const with z.enum pattern', () => {
    const source = `export const GateExecutionType = z.enum(['deterministic', 'agentic']);`;
    const exports = parseExports(source);
    expect(exports.length).toBe(1);
    expect(exports[0].symbol).toBe('GateExecutionType');
    expect(exports[0].type).toBe('const');
  });
});

// =============================================================================
// analyzeFile tests
// =============================================================================

describe('analyzeFile', () => {
  let testRoot;

  beforeEach(() => {
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-analyze-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'src', 'test-module'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should analyze a TypeScript file', () => {
    const filePath = 'src/test-module/service.ts';
    writeFileSync(join(testRoot, filePath), SAMPLE_TS_SOURCE);

    const result = analyzeFile(filePath, testRoot);
    expect(result.filePath).toBe(filePath);
    expect(result.exports.length > 0).toBeTruthy();
    expect(result.imports.length > 0).toBeTruthy();
    expect(Array.isArray(result.calls)).toBeTruthy();
    expect(Array.isArray(result.events)).toBeTruthy();
    // M1: calls[] and events[] are now populated by regex analysis
    expect(result.calls.length).toBeGreaterThanOrEqual(0);
    expect(result.events.length).toBeGreaterThanOrEqual(0);
  });

  it('should return empty arrays for non-TS/JS files', () => {
    const filePath = 'src/test-module/README.md';
    writeFileSync(join(testRoot, filePath), '# Hello');

    const result = analyzeFile(filePath, testRoot);
    expect(result.filePath).toBe(filePath);
    expect(result.exports.length).toBe(0);
    expect(result.imports.length).toBe(0);
    expect(result.calls.length).toBe(0);
    expect(result.events.length).toBe(0);
  });

  it('should return empty arrays for missing files', () => {
    const result = analyzeFile('src/test-module/nonexistent.ts', testRoot);
    expect(result.filePath).toBe('src/test-module/nonexistent.ts');
    expect(result.exports.length).toBe(0);
    expect(result.imports.length).toBe(0);
  });

  it('should handle .mjs files', () => {
    const filePath = 'src/test-module/util.mjs';
    writeFileSync(join(testRoot, filePath), SAMPLE_MJS_SOURCE);

    const result = analyzeFile(filePath, testRoot);
    expect(result.exports.length > 0).toBeTruthy();
    expect(result.imports.length > 0).toBeTruthy();
  });
});

// =============================================================================
// validateLowLevelTrace tests (AC-3.1)
// =============================================================================

describe('validateLowLevelTrace (AC-3.1)', () => {
  it('should validate a correct low-level trace', () => {
    const trace = {
      moduleId: 'test-module',
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
      files: [
        {
          filePath: 'src/test-module/index.ts',
          exports: [{ symbol: 'foo', type: 'function' }],
          imports: [{ source: 'node:fs', symbols: ['readFileSync'] }],
          calls: [],
          events: [],
        },
      ],
    };

    const result = validateLowLevelTrace(trace);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('should reject trace with missing moduleId', () => {
    const trace = {
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
      files: [],
    };

    const result = validateLowLevelTrace(trace);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('moduleId'))).toBeTruthy();
  });

  it('should reject trace with missing version', () => {
    const trace = {
      moduleId: 'test',
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
      files: [],
    };

    const result = validateLowLevelTrace(trace);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('version'))).toBeTruthy();
  });

  it('should reject trace with invalid lastGenerated', () => {
    const trace = {
      moduleId: 'test',
      version: 1,
      lastGenerated: 'not-a-date',
      generatedBy: 'trace-generate',
      files: [],
    };

    const result = validateLowLevelTrace(trace);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('lastGenerated'))).toBeTruthy();
  });

  it('should reject trace with missing files array', () => {
    const trace = {
      moduleId: 'test',
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
    };

    const result = validateLowLevelTrace(trace);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('files'))).toBeTruthy();
  });

  it('should reject file entry with missing filePath', () => {
    const trace = {
      moduleId: 'test',
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
      files: [
        {
          exports: [],
          imports: [],
          calls: [],
          events: [],
        },
      ],
    };

    const result = validateLowLevelTrace(trace);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('filePath'))).toBeTruthy();
  });

  it('should reject invalid export type', () => {
    const trace = {
      moduleId: 'test',
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
      files: [
        {
          filePath: 'src/index.ts',
          exports: [{ symbol: 'foo', type: 'invalid-type' }],
          imports: [],
          calls: [],
          events: [],
        },
      ],
    };

    const result = validateLowLevelTrace(trace);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('type must be one of'))).toBeTruthy();
  });

  it('should validate trace with empty files array', () => {
    const trace = {
      moduleId: 'test-module',
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
      files: [],
    };

    const result = validateLowLevelTrace(trace);
    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// generateLowLevelTrace tests (AC-3.1, AC-3.3)
// =============================================================================

describe('generateLowLevelTrace', () => {
  let testRoot;

  beforeEach(() => {
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-gen-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true });
    mkdirSync(join(testRoot, 'src', 'test-module'), { recursive: true });
    mkdirSync(join(testRoot, 'src', 'other'), { recursive: true });

    // Initialize git repo for file discovery
    execSync('git init', { cwd: testRoot });
    execSync('git config user.email "test@test.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('AC-3.1: generated trace validates against LowLevelTrace schema', () => {
    const config = createTestConfig();
    writeFileSync(join(testRoot, 'src', 'test-module', 'service.ts'), SAMPLE_TS_SOURCE);
    writeFileSync(join(testRoot, 'src', 'test-module', 'index.ts'), SAMPLE_INDEX_SOURCE);
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const trace = generateLowLevelTrace(config.modules[0], config, testRoot);
    const validation = validateLowLevelTrace(trace);
    expect(validation.valid).toBe(true);
  });

  it('AC-3.1: trace has all required top-level fields', () => {
    const config = createTestConfig();
    writeFileSync(join(testRoot, 'src', 'test-module', 'index.ts'), 'export const x = 1;');
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const trace = generateLowLevelTrace(config.modules[0], config, testRoot);

    expect(trace.moduleId).toBe('test-module');
    expect(typeof trace.version).toBe('number');
    expect(Number.isInteger(trace.version)).toBeTruthy();
    expect(typeof trace.lastGenerated).toBe('string');
    expect(!Number.isNaN(new Date(trace.lastGenerated).getTime())).toBeTruthy();
    expect(trace.generatedBy).toBe('trace-generate');
    expect(Array.isArray(trace.files)).toBeTruthy();
  });

  it('AC-3.3: each file matching module glob has an entry', () => {
    const config = createTestConfig();
    writeFileSync(join(testRoot, 'src', 'test-module', 'service.ts'), SAMPLE_TS_SOURCE);
    writeFileSync(join(testRoot, 'src', 'test-module', 'index.ts'), SAMPLE_INDEX_SOURCE);
    writeFileSync(join(testRoot, 'src', 'test-module', 'utils.mjs'), SAMPLE_MJS_SOURCE);
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const trace = generateLowLevelTrace(config.modules[0], config, testRoot);
    const filePaths = trace.files.map(f => f.filePath);

    expect(filePaths.includes('src/test-module/service.ts')).toBeTruthy();
    expect(filePaths.includes('src/test-module/index.ts')).toBeTruthy();
    expect(filePaths.includes('src/test-module/utils.mjs')).toBeTruthy();
    expect(trace.files.length).toBe(3);
  });

  it('AC-3.3: files in other modules are not included', () => {
    const config = createTestConfig();
    writeFileSync(join(testRoot, 'src', 'test-module', 'service.ts'), 'export const x = 1;');
    writeFileSync(join(testRoot, 'src', 'other', 'other.ts'), 'export const y = 2;');
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const trace = generateLowLevelTrace(config.modules[0], config, testRoot);
    const filePaths = trace.files.map(f => f.filePath);

    expect(filePaths.includes('src/test-module/service.ts')).toBeTruthy();
    expect(!filePaths.includes('src/other/other.ts')).toBeTruthy();
  });

  it('should increment version on subsequent generations', () => {
    const config = createTestConfig();
    writeFileSync(join(testRoot, 'src', 'test-module', 'index.ts'), 'export const x = 1;');
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    // First generation
    const trace1 = generateLowLevelTrace(config.modules[0], config, testRoot);
    expect(trace1.version).toBe(1);

    // Write first trace so version can be read
    const tracePath = join(testRoot, '.claude', 'traces', 'low-level', 'test-module.json');
    writeFileSync(tracePath, JSON.stringify(trace1, null, 2));

    // Second generation
    const trace2 = generateLowLevelTrace(config.modules[0], config, testRoot);
    expect(trace2.version).toBe(2);
  });

  it('should handle module with no matching files', () => {
    const config = createTestConfig();
    // No files created in src/test-module/
    execSync('git init', { cwd: testRoot });

    const trace = generateLowLevelTrace(config.modules[0], config, testRoot);
    expect(trace.files.length).toBe(0);
    expect(trace.moduleId).toBe('test-module');
    expect(trace.version).toBe(1);
  });

  it('file entries include correct import analysis', () => {
    const config = createTestConfig();
    writeFileSync(join(testRoot, 'src', 'test-module', 'service.ts'), SAMPLE_TS_SOURCE);
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const trace = generateLowLevelTrace(config.modules[0], config, testRoot);
    const serviceEntry = trace.files.find(f => f.filePath === 'src/test-module/service.ts');
    expect(serviceEntry).toBeTruthy();

    // Verify imports
    const importSources = serviceEntry.imports.map(i => i.source);
    expect(importSources.includes('node:fs')).toBeTruthy();
    expect(importSources.includes('ioredis')).toBeTruthy();
  });

  it('file entries include correct export analysis', () => {
    const config = createTestConfig();
    writeFileSync(join(testRoot, 'src', 'test-module', 'service.ts'), SAMPLE_TS_SOURCE);
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const trace = generateLowLevelTrace(config.modules[0], config, testRoot);
    const serviceEntry = trace.files.find(f => f.filePath === 'src/test-module/service.ts');
    expect(serviceEntry).toBeTruthy();

    const exportSymbols = serviceEntry.exports.map(e => e.symbol);
    expect(exportSymbols.includes('AlertService')).toBeTruthy();
    expect(exportSymbols.includes('createAlertService')).toBeTruthy();
  });
});

// =============================================================================
// generateLowLevelMarkdown tests (AC-3.2)
// =============================================================================

describe('generateLowLevelMarkdown (AC-3.2)', () => {
  it('should include HTML comment metadata', () => {
    const trace = {
      moduleId: 'test-module',
      version: 3,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
      files: [],
    };

    const md = generateLowLevelMarkdown(trace, { id: 'test-module', name: 'Test Module' });

    expect(md.includes('<!-- trace-id: test-module -->')).toBeTruthy();
    expect(md.includes('<!-- trace-version: 3 -->')).toBeTruthy();
    expect(md.includes('<!-- last-generated: 2026-02-22T10:30:00.000Z -->')).toBeTruthy();
    expect(md.includes('<!-- generated-by: trace-generate -->')).toBeTruthy();
  });

  it('should include module heading', () => {
    const trace = {
      moduleId: 'test-module',
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
      files: [],
    };

    const md = generateLowLevelMarkdown(trace, { id: 'test-module', name: 'Test Module' });
    expect(md.includes('# Low-Level Trace: Test Module')).toBeTruthy();
  });

  it('should include file sections with pipe-delimited exports', () => {
    const trace = {
      moduleId: 'test-module',
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
      files: [
        {
          filePath: 'src/test-module/service.ts',
          exports: [
            { symbol: 'AlertService', type: 'class' },
            { symbol: 'createAlertService', type: 'function' },
          ],
          imports: [
            { source: 'node:fs', symbols: ['readFileSync'] },
          ],
          calls: [],
          events: [],
        },
      ],
    };

    const md = generateLowLevelMarkdown(trace, { id: 'test-module', name: 'Test Module' });

    // File heading
    expect(md.includes('## File: src/test-module/service.ts')).toBeTruthy();

    // Exports section with pipe-delimited format
    expect(md.includes('### Exports')).toBeTruthy();
    expect(md.includes('symbol | type')).toBeTruthy();
    expect(md.includes('AlertService | class')).toBeTruthy();
    expect(md.includes('createAlertService | function')).toBeTruthy();

    // Imports section with pipe-delimited format
    expect(md.includes('### Imports')).toBeTruthy();
    expect(md.includes('source | symbols')).toBeTruthy();
    expect(md.includes('node:fs | readFileSync')).toBeTruthy();

    // Function Calls section
    expect(md.includes('### Function Calls')).toBeTruthy();

    // Events section
    expect(md.includes('### Events')).toBeTruthy();
  });

  it('should show empty section markers for files with no exports', () => {
    const trace = {
      moduleId: 'test-module',
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
      files: [
        {
          filePath: 'src/test-module/config.json',
          exports: [],
          imports: [],
          calls: [],
          events: [],
        },
      ],
    };

    const md = generateLowLevelMarkdown(trace, { id: 'test-module', name: 'Test Module' });
    expect(md.includes('_No exports_')).toBeTruthy();
    expect(md.includes('_No imports_')).toBeTruthy();
  });

  it('should include Notes (not synced) section', () => {
    const trace = {
      moduleId: 'test-module',
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
      files: [],
    };

    const md = generateLowLevelMarkdown(trace, { id: 'test-module', name: 'Test Module' });
    expect(md.includes('## Notes (not synced)')).toBeTruthy();
  });

  it('should show side-effect imports correctly', () => {
    const trace = {
      moduleId: 'test-module',
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
      files: [
        {
          filePath: 'src/test-module/side.ts',
          exports: [],
          imports: [{ source: './polyfill.js', symbols: [] }],
          calls: [],
          events: [],
        },
      ],
    };

    const md = generateLowLevelMarkdown(trace, { id: 'test-module', name: 'Test Module' });
    expect(md.includes('./polyfill.js | (side-effect)')).toBeTruthy();
  });

  it('should include events when present', () => {
    const trace = {
      moduleId: 'test-module',
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
      files: [
        {
          filePath: 'src/test-module/emitter.ts',
          exports: [],
          imports: [],
          calls: [],
          events: [
            { file: 'src/test-module/emitter.ts', line: 10, eventName: 'work.completed', type: 'emit' },
            { file: 'src/test-module/emitter.ts', line: 20, eventName: 'work.assigned', type: 'subscribe' },
          ],
        },
      ],
    };

    const md = generateLowLevelMarkdown(trace, { id: 'test-module', name: 'Test Module' });
    expect(md.includes('file | line | eventName | type')).toBeTruthy();
    expect(md.includes('src/test-module/emitter.ts | 10 | work.completed | emit')).toBeTruthy();
    expect(md.includes('src/test-module/emitter.ts | 20 | work.assigned | subscribe')).toBeTruthy();
  });

  it('should include function calls when present', () => {
    const trace = {
      moduleId: 'test-module',
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
      files: [
        {
          filePath: 'src/test-module/service.ts',
          exports: [],
          imports: [],
          calls: [
            { callerFile: 'src/test-module/service.ts', callerLine: 42, calleeName: 'query_knowledge', calleeFile: 'src/knowledge/service.mjs', calleeLine: 10 },
          ],
          events: [],
        },
      ],
    };

    const md = generateLowLevelMarkdown(trace, { id: 'test-module', name: 'Test Module' });
    expect(md.includes('callerFile | callerLine | calleeName | calleeFile | calleeLine')).toBeTruthy();
    expect(md.includes('src/test-module/service.ts | 42 | query_knowledge | src/knowledge/service.mjs | 10')).toBeTruthy();
  });
});

// =============================================================================
// writeLowLevelTrace tests (file I/O)
// =============================================================================

describe('writeLowLevelTrace', () => {
  let testRoot;

  beforeEach(() => {
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-write-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true });
    mkdirSync(join(testRoot, 'src', 'test-module'), { recursive: true });

    execSync('git init', { cwd: testRoot });
    execSync('git config user.email "test@test.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should write JSON and markdown files', () => {
    const config = createTestConfig();
    writeFileSync(join(testRoot, 'src', 'test-module', 'index.ts'), 'export const x = 1;');
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const result = writeLowLevelTrace(config.modules[0], config, testRoot);

    // Check JSON file exists and is valid
    const jsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'test-module.json');
    expect(existsSync(jsonPath)).toBeTruthy();
    const jsonContent = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    expect(jsonContent.moduleId).toBe('test-module');

    // Check markdown file exists
    const mdPath = join(testRoot, '.claude', 'traces', 'low-level', 'test-module.md');
    expect(existsSync(mdPath)).toBeTruthy();
    const mdContent = readFileSync(mdPath, 'utf-8');
    expect(mdContent.includes('# Low-Level Trace: Test Module')).toBeTruthy();

    // Check result
    expect(result.moduleId).toBe('test-module');
    expect(result.fileCount).toBe(1);
    expect(result.version).toBe(1);
  });

  it('should create low-level directory if it does not exist', () => {
    // Remove the low-level directory
    rmSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true, force: true });

    const config = createTestConfig();
    writeFileSync(join(testRoot, 'src', 'test-module', 'index.ts'), 'export const x = 1;');
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    writeLowLevelTrace(config.modules[0], config, testRoot);

    const jsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'test-module.json');
    expect(existsSync(jsonPath)).toBeTruthy();
  });

  it('written JSON should validate against schema', () => {
    const config = createTestConfig();
    writeFileSync(join(testRoot, 'src', 'test-module', 'service.ts'), SAMPLE_TS_SOURCE);
    writeFileSync(join(testRoot, 'src', 'test-module', 'index.ts'), SAMPLE_INDEX_SOURCE);
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    writeLowLevelTrace(config.modules[0], config, testRoot);

    const jsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'test-module.json');
    const trace = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    const validation = validateLowLevelTrace(trace);
    expect(validation.valid).toBe(true);
  });
});

// =============================================================================
// generateAllLowLevelTraces tests
// =============================================================================

describe('generateAllLowLevelTraces', () => {
  let testRoot;

  beforeEach(() => {
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-all-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true });
    mkdirSync(join(testRoot, 'src', 'test-module'), { recursive: true });
    mkdirSync(join(testRoot, 'src', 'other'), { recursive: true });

    // Write trace config
    const config = createTestConfig();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      JSON.stringify(config, null, 2),
    );

    execSync('git init', { cwd: testRoot });
    execSync('git config user.email "test@test.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should generate traces for all modules', () => {
    writeFileSync(join(testRoot, 'src', 'test-module', 'index.ts'), 'export const x = 1;');
    writeFileSync(join(testRoot, 'src', 'other', 'index.ts'), 'export const y = 2;');
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const result = generateAllLowLevelTraces(undefined, testRoot);

    expect(result.modulesProcessed).toBe(2);
    expect(result.results.length).toBe(2);
    expect(result.results.some(r => r.moduleId === 'test-module')).toBeTruthy();
    expect(result.results.some(r => r.moduleId === 'other-module')).toBeTruthy();

    // Verify files were written
    expect(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'test-module.json'))).toBeTruthy();
    expect(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'test-module.md'))).toBeTruthy();
    expect(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'other-module.json'))).toBeTruthy();
    expect(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'other-module.md'))).toBeTruthy();
  });

  it('should generate trace for a single targeted module', () => {
    writeFileSync(join(testRoot, 'src', 'test-module', 'index.ts'), 'export const x = 1;');
    writeFileSync(join(testRoot, 'src', 'other', 'index.ts'), 'export const y = 2;');
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const result = generateAllLowLevelTraces('test-module', testRoot);

    expect(result.modulesProcessed).toBe(1);
    expect(result.results.length).toBe(1);
    expect(result.results[0].moduleId).toBe('test-module');

    // Only targeted module should have files written
    expect(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'test-module.json'))).toBeTruthy();
    expect(!existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'other-module.json'))).toBeTruthy();
  });

  it('should throw for unknown target module', () => {
    expect(() => generateAllLowLevelTraces('nonexistent-module', testRoot)).toThrow(/Module "nonexistent-module" not found/);
  });
});

// =============================================================================
// Integration: full round-trip test
// =============================================================================

describe('full round-trip: generate, validate, verify markdown', () => {
  let testRoot;

  beforeEach(() => {
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-roundtrip-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true });
    mkdirSync(join(testRoot, 'src', 'test-module', 'nested'), { recursive: true });

    const config = createTestConfig();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      JSON.stringify(config, null, 2),
    );

    execSync('git init', { cwd: testRoot });
    execSync('git config user.email "test@test.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should produce valid JSON and well-formatted markdown for a real-ish module', () => {
    // Create a mini module with various file types
    writeFileSync(join(testRoot, 'src', 'test-module', 'service.ts'), SAMPLE_TS_SOURCE);
    writeFileSync(join(testRoot, 'src', 'test-module', 'index.ts'), SAMPLE_INDEX_SOURCE);
    writeFileSync(join(testRoot, 'src', 'test-module', 'nested', 'helper.mjs'), SAMPLE_MJS_SOURCE);
    writeFileSync(join(testRoot, 'src', 'test-module', 'README.md'), '# Test Module');

    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    // Generate
    const genResult = generateAllLowLevelTraces('test-module', testRoot);
    expect(genResult.modulesProcessed).toBe(1);

    // Read and validate JSON
    const jsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'test-module.json');
    const trace = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    const validation = validateLowLevelTrace(trace);
    expect(validation.valid).toBe(true);

    // Verify all 4 files are present (AC-3.3)
    expect(trace.files.length).toBe(4);
    const filePaths = trace.files.map(f => f.filePath).sort();
    expect(filePaths.includes('src/test-module/README.md')).toBeTruthy();
    expect(filePaths.includes('src/test-module/index.ts')).toBeTruthy();
    expect(filePaths.includes('src/test-module/nested/helper.mjs')).toBeTruthy();
    expect(filePaths.includes('src/test-module/service.ts')).toBeTruthy();

    // Read and validate markdown structure
    const mdPath = join(testRoot, '.claude', 'traces', 'low-level', 'test-module.md');
    const md = readFileSync(mdPath, 'utf-8');

    // AC-3.2: HTML comment metadata
    expect(md.includes('<!-- trace-id: test-module -->')).toBeTruthy();
    expect(md.includes('<!-- trace-version: 1 -->')).toBeTruthy();
    expect(md.includes('<!-- generated-by: trace-generate -->')).toBeTruthy();

    // AC-3.2: File sections exist
    expect(md.includes('## File: src/test-module/service.ts')).toBeTruthy();
    expect(md.includes('## File: src/test-module/index.ts')).toBeTruthy();
    expect(md.includes('## File: src/test-module/nested/helper.mjs')).toBeTruthy();
    expect(md.includes('## File: src/test-module/README.md')).toBeTruthy();

    // AC-3.2: Structured sections with pipe-delimited format
    expect(md.includes('### Exports')).toBeTruthy();
    expect(md.includes('### Imports')).toBeTruthy();
    expect(md.includes('### Function Calls')).toBeTruthy();
    expect(md.includes('### Events')).toBeTruthy();
    expect(md.includes('symbol | type')).toBeTruthy();
    expect(md.includes('source | symbols')).toBeTruthy();

    // Verify service.ts has real content
    expect(md.includes('AlertService | class')).toBeTruthy();
    expect(md.includes('createAlertService | function')).toBeTruthy();
    expect(md.includes('node:fs | readFileSync, writeFileSync')).toBeTruthy();

    // Verify README.md has empty sections
    // (it will have _No exports_ etc since it's not TS/JS)
    expect(md.includes('_No exports_')).toBeTruthy();
  });
});

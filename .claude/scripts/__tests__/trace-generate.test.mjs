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
 * Run with: node --test .claude/scripts/__tests__/trace-generate.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source, 'node:fs');
    assert.deepEqual(imports[0].symbols, ['readFileSync', 'writeFileSync']);
  });

  it('should parse default imports', () => {
    const imports = parseImports(`import Redis from 'ioredis';`);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source, 'ioredis');
    assert.deepEqual(imports[0].symbols, ['Redis']);
  });

  it('should parse namespace imports', () => {
    const imports = parseImports(`import * as utils from './utils.js';`);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source, './utils.js');
    assert.deepEqual(imports[0].symbols, ['* as utils']);
  });

  it('should parse type imports', () => {
    const imports = parseImports(`import type { Config } from '../types.js';`);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source, '../types.js');
    assert.deepEqual(imports[0].symbols, ['Config']);
  });

  it('should parse side-effect imports', () => {
    const imports = parseImports(`import './side-effect.js';`);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source, './side-effect.js');
    assert.deepEqual(imports[0].symbols, []);
  });

  it('should parse require statements', () => {
    const imports = parseImports(`const { readFileSync } = require('node:fs');`);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source, 'node:fs');
    assert.deepEqual(imports[0].symbols, ['readFileSync']);
  });

  it('should parse default require statements', () => {
    const imports = parseImports(`const path = require('node:path');`);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source, 'node:path');
    assert.deepEqual(imports[0].symbols, ['path']);
  });

  it('should parse all imports from sample source', () => {
    const imports = parseImports(SAMPLE_TS_SOURCE);
    assert.ok(imports.length >= 5, `Expected at least 5 imports, got ${imports.length}`);

    const sources = imports.map(i => i.source);
    assert.ok(sources.includes('node:fs'), 'Should include node:fs');
    assert.ok(sources.includes('node:path'), 'Should include node:path');
    assert.ok(sources.includes('ioredis'), 'Should include ioredis');
    assert.ok(sources.includes('./utils.js'), 'Should include ./utils.js');
    assert.ok(sources.includes('./side-effect.js'), 'Should include ./side-effect.js');
  });

  it('should handle multiline imports', () => {
    const source = `import {
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';`;
    const imports = parseImports(source);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source, 'node:fs');
    assert.ok(imports[0].symbols.includes('readFileSync'));
    assert.ok(imports[0].symbols.includes('writeFileSync'));
    assert.ok(imports[0].symbols.includes('mkdirSync'));
  });

  it('should handle aliased imports', () => {
    const imports = parseImports(`import { foo as bar } from './module.js';`);
    assert.equal(imports.length, 1);
    assert.deepEqual(imports[0].symbols, ['bar']);
  });

  it('should skip comments', () => {
    const source = `// import { fake } from 'fake';
import { real } from 'real';`;
    const imports = parseImports(source);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source, 'real');
  });

  it('should handle empty source', () => {
    const imports = parseImports('');
    assert.equal(imports.length, 0);
  });

  it('should handle source with no imports', () => {
    const imports = parseImports('const x = 1;\nfunction foo() { return x; }');
    assert.equal(imports.length, 0);
  });
});

// =============================================================================
// parseExports tests
// =============================================================================

describe('parseExports', () => {
  it('should parse exported functions', () => {
    const exports = parseExports(`export function createService() {}`);
    assert.equal(exports.length, 1);
    assert.equal(exports[0].symbol, 'createService');
    assert.equal(exports[0].type, 'function');
  });

  it('should parse exported async functions', () => {
    const exports = parseExports(`export async function fetchData() {}`);
    assert.equal(exports.length, 1);
    assert.equal(exports[0].symbol, 'fetchData');
    assert.equal(exports[0].type, 'function');
  });

  it('should parse exported classes', () => {
    const exports = parseExports(`export class AlertService {}`);
    assert.equal(exports.length, 1);
    assert.equal(exports[0].symbol, 'AlertService');
    assert.equal(exports[0].type, 'class');
  });

  it('should parse exported interfaces', () => {
    const exports = parseExports(`export interface AlertPayload { id: string; }`);
    assert.equal(exports.length, 1);
    assert.equal(exports[0].symbol, 'AlertPayload');
    assert.equal(exports[0].type, 'interface');
  });

  it('should parse exported types', () => {
    const exports = parseExports(`export type AlertSeverity = 'warning' | 'critical';`);
    assert.equal(exports.length, 1);
    assert.equal(exports[0].symbol, 'AlertSeverity');
    assert.equal(exports[0].type, 'type');
  });

  it('should parse exported consts', () => {
    const exports = parseExports(`export const DEFAULT_TIMEOUT = 30000;`);
    assert.equal(exports.length, 1);
    assert.equal(exports[0].symbol, 'DEFAULT_TIMEOUT');
    assert.equal(exports[0].type, 'const');
  });

  it('should parse export default', () => {
    const exports = parseExports(`export default AlertService;`);
    assert.equal(exports.length, 1);
    assert.equal(exports[0].type, 'default');
  });

  it('should parse re-exports from other modules', () => {
    const exports = parseExports(`export { AlertService, createAlertService } from './alert-service.js';`);
    assert.ok(exports.length >= 2);
    const symbols = exports.map(e => e.symbol);
    assert.ok(symbols.includes('AlertService'));
    assert.ok(symbols.includes('createAlertService'));
  });

  it('should parse type re-exports', () => {
    const exports = parseExports(`export type { AlertSeverity, AlertPayload } from './alert-service.js';`);
    assert.ok(exports.length >= 2);
    const symbols = exports.map(e => e.symbol);
    assert.ok(symbols.includes('AlertSeverity'));
    assert.ok(symbols.includes('AlertPayload'));
    // Type re-exports should have type 'type'
    assert.equal(exports.find(e => e.symbol === 'AlertSeverity').type, 'type');
  });

  it('should parse all exports from sample source', () => {
    const exports = parseExports(SAMPLE_TS_SOURCE);
    const symbols = exports.map(e => e.symbol);

    assert.ok(symbols.includes('AlertSeverity'), 'Should export AlertSeverity type');
    assert.ok(symbols.includes('AlertPayload'), 'Should export AlertPayload interface');
    assert.ok(symbols.includes('AlertService'), 'Should export AlertService class');
    assert.ok(symbols.includes('createAlertService'), 'Should export createAlertService function');
    assert.ok(symbols.includes('DEFAULT_TIMEOUT'), 'Should export DEFAULT_TIMEOUT const');
  });

  it('should parse index.ts re-exports', () => {
    const exports = parseExports(SAMPLE_INDEX_SOURCE);
    const symbols = exports.map(e => e.symbol);

    assert.ok(symbols.includes('AlertSeverity'), 'Should re-export AlertSeverity');
    assert.ok(symbols.includes('AlertPayload'), 'Should re-export AlertPayload');
    assert.ok(symbols.includes('AlertService'), 'Should re-export AlertService');
    assert.ok(symbols.includes('createAlertService'), 'Should re-export createAlertService');
    assert.ok(symbols.includes('NotificationService'), 'Should re-export NotificationService');
  });

  it('should handle empty source', () => {
    const exports = parseExports('');
    assert.equal(exports.length, 0);
  });

  it('should handle source with no exports', () => {
    const exports = parseExports('const x = 1;\nfunction foo() { return x; }');
    assert.equal(exports.length, 0);
  });

  it('should not duplicate exports', () => {
    const source = `export class Foo {}
export { Foo };`;
    const exports = parseExports(source);
    const fooExports = exports.filter(e => e.symbol === 'Foo');
    assert.equal(fooExports.length, 1, 'Should not duplicate Foo');
  });

  it('should parse exported enums', () => {
    const exports = parseExports(`export enum Status { Active, Inactive }`);
    assert.equal(exports.length, 1);
    assert.equal(exports[0].symbol, 'Status');
    assert.equal(exports[0].type, 'enum');
  });

  it('should parse exported const with z.enum pattern', () => {
    const source = `export const GateExecutionType = z.enum(['deterministic', 'agentic']);`;
    const exports = parseExports(source);
    assert.equal(exports.length, 1);
    assert.equal(exports[0].symbol, 'GateExecutionType');
    assert.equal(exports[0].type, 'const');
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
    assert.equal(result.filePath, filePath);
    assert.ok(result.exports.length > 0, 'Should have exports');
    assert.ok(result.imports.length > 0, 'Should have imports');
    assert.ok(Array.isArray(result.calls), 'calls should be an array');
    assert.ok(Array.isArray(result.events), 'events should be an array');
    assert.equal(result.calls.length, 0, 'v1: calls should be empty');
    assert.equal(result.events.length, 0, 'v1: events should be empty');
  });

  it('should return empty arrays for non-TS/JS files', () => {
    const filePath = 'src/test-module/README.md';
    writeFileSync(join(testRoot, filePath), '# Hello');

    const result = analyzeFile(filePath, testRoot);
    assert.equal(result.filePath, filePath);
    assert.equal(result.exports.length, 0);
    assert.equal(result.imports.length, 0);
    assert.equal(result.calls.length, 0);
    assert.equal(result.events.length, 0);
  });

  it('should return empty arrays for missing files', () => {
    const result = analyzeFile('src/test-module/nonexistent.ts', testRoot);
    assert.equal(result.filePath, 'src/test-module/nonexistent.ts');
    assert.equal(result.exports.length, 0);
    assert.equal(result.imports.length, 0);
  });

  it('should handle .mjs files', () => {
    const filePath = 'src/test-module/util.mjs';
    writeFileSync(join(testRoot, filePath), SAMPLE_MJS_SOURCE);

    const result = analyzeFile(filePath, testRoot);
    assert.ok(result.exports.length > 0, 'Should have exports');
    assert.ok(result.imports.length > 0, 'Should have imports');
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
    assert.equal(result.valid, true, `Expected valid, got errors: ${result.errors.join(', ')}`);
    assert.equal(result.errors.length, 0);
  });

  it('should reject trace with missing moduleId', () => {
    const trace = {
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
      files: [],
    };

    const result = validateLowLevelTrace(trace);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('moduleId')));
  });

  it('should reject trace with missing version', () => {
    const trace = {
      moduleId: 'test',
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
      files: [],
    };

    const result = validateLowLevelTrace(trace);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('version')));
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
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('lastGenerated')));
  });

  it('should reject trace with missing files array', () => {
    const trace = {
      moduleId: 'test',
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace-generate',
    };

    const result = validateLowLevelTrace(trace);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('files')));
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
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('filePath')));
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
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('type must be one of')));
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
    assert.equal(result.valid, true);
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
    assert.equal(
      validation.valid,
      true,
      `Schema validation failed: ${validation.errors.join(', ')}`,
    );
  });

  it('AC-3.1: trace has all required top-level fields', () => {
    const config = createTestConfig();
    writeFileSync(join(testRoot, 'src', 'test-module', 'index.ts'), 'export const x = 1;');
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const trace = generateLowLevelTrace(config.modules[0], config, testRoot);

    assert.equal(trace.moduleId, 'test-module');
    assert.equal(typeof trace.version, 'number');
    assert.ok(Number.isInteger(trace.version));
    assert.equal(typeof trace.lastGenerated, 'string');
    assert.ok(!Number.isNaN(new Date(trace.lastGenerated).getTime()), 'lastGenerated should be valid date');
    assert.equal(trace.generatedBy, 'trace-generate');
    assert.ok(Array.isArray(trace.files));
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

    assert.ok(filePaths.includes('src/test-module/service.ts'), 'Should include service.ts');
    assert.ok(filePaths.includes('src/test-module/index.ts'), 'Should include index.ts');
    assert.ok(filePaths.includes('src/test-module/utils.mjs'), 'Should include utils.mjs');
    assert.equal(trace.files.length, 3, 'Should have exactly 3 file entries');
  });

  it('AC-3.3: files in other modules are not included', () => {
    const config = createTestConfig();
    writeFileSync(join(testRoot, 'src', 'test-module', 'service.ts'), 'export const x = 1;');
    writeFileSync(join(testRoot, 'src', 'other', 'other.ts'), 'export const y = 2;');
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const trace = generateLowLevelTrace(config.modules[0], config, testRoot);
    const filePaths = trace.files.map(f => f.filePath);

    assert.ok(filePaths.includes('src/test-module/service.ts'));
    assert.ok(!filePaths.includes('src/other/other.ts'), 'Should NOT include files from other module');
  });

  it('should increment version on subsequent generations', () => {
    const config = createTestConfig();
    writeFileSync(join(testRoot, 'src', 'test-module', 'index.ts'), 'export const x = 1;');
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    // First generation
    const trace1 = generateLowLevelTrace(config.modules[0], config, testRoot);
    assert.equal(trace1.version, 1);

    // Write first trace so version can be read
    const tracePath = join(testRoot, '.claude', 'traces', 'low-level', 'test-module.json');
    writeFileSync(tracePath, JSON.stringify(trace1, null, 2));

    // Second generation
    const trace2 = generateLowLevelTrace(config.modules[0], config, testRoot);
    assert.equal(trace2.version, 2, 'Version should increment');
  });

  it('should handle module with no matching files', () => {
    const config = createTestConfig();
    // No files created in src/test-module/
    execSync('git init', { cwd: testRoot });

    const trace = generateLowLevelTrace(config.modules[0], config, testRoot);
    assert.equal(trace.files.length, 0, 'Should have no file entries');
    assert.equal(trace.moduleId, 'test-module');
    assert.equal(trace.version, 1);
  });

  it('file entries include correct import analysis', () => {
    const config = createTestConfig();
    writeFileSync(join(testRoot, 'src', 'test-module', 'service.ts'), SAMPLE_TS_SOURCE);
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const trace = generateLowLevelTrace(config.modules[0], config, testRoot);
    const serviceEntry = trace.files.find(f => f.filePath === 'src/test-module/service.ts');
    assert.ok(serviceEntry, 'Should have entry for service.ts');

    // Verify imports
    const importSources = serviceEntry.imports.map(i => i.source);
    assert.ok(importSources.includes('node:fs'), 'Should import from node:fs');
    assert.ok(importSources.includes('ioredis'), 'Should import from ioredis');
  });

  it('file entries include correct export analysis', () => {
    const config = createTestConfig();
    writeFileSync(join(testRoot, 'src', 'test-module', 'service.ts'), SAMPLE_TS_SOURCE);
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const trace = generateLowLevelTrace(config.modules[0], config, testRoot);
    const serviceEntry = trace.files.find(f => f.filePath === 'src/test-module/service.ts');
    assert.ok(serviceEntry, 'Should have entry for service.ts');

    const exportSymbols = serviceEntry.exports.map(e => e.symbol);
    assert.ok(exportSymbols.includes('AlertService'), 'Should export AlertService');
    assert.ok(exportSymbols.includes('createAlertService'), 'Should export createAlertService');
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

    assert.ok(md.includes('<!-- trace-id: test-module -->'), 'Should have trace-id metadata');
    assert.ok(md.includes('<!-- trace-version: 3 -->'), 'Should have trace-version metadata');
    assert.ok(md.includes('<!-- last-generated: 2026-02-22T10:30:00.000Z -->'), 'Should have last-generated metadata');
    assert.ok(md.includes('<!-- generated-by: trace-generate -->'), 'Should have generated-by metadata');
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
    assert.ok(md.includes('# Low-Level Trace: Test Module'), 'Should have module heading');
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
    assert.ok(md.includes('## File: src/test-module/service.ts'), 'Should have file heading');

    // Exports section with pipe-delimited format
    assert.ok(md.includes('### Exports'), 'Should have Exports section');
    assert.ok(md.includes('symbol | type'), 'Should have exports header');
    assert.ok(md.includes('AlertService | class'), 'Should have AlertService export');
    assert.ok(md.includes('createAlertService | function'), 'Should have createAlertService export');

    // Imports section with pipe-delimited format
    assert.ok(md.includes('### Imports'), 'Should have Imports section');
    assert.ok(md.includes('source | symbols'), 'Should have imports header');
    assert.ok(md.includes('node:fs | readFileSync'), 'Should have node:fs import');

    // Function Calls section
    assert.ok(md.includes('### Function Calls'), 'Should have Function Calls section');

    // Events section
    assert.ok(md.includes('### Events'), 'Should have Events section');
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
    assert.ok(md.includes('_No exports_'), 'Should show no-exports marker');
    assert.ok(md.includes('_No imports_'), 'Should show no-imports marker');
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
    assert.ok(md.includes('## Notes (not synced)'), 'Should have Notes section');
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
    assert.ok(md.includes('./polyfill.js | (side-effect)'), 'Should show side-effect import');
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
            { type: 'publish', eventName: 'work.completed', channel: 'dev-team-output' },
            { type: 'subscribe', eventName: 'work.assigned', channel: 'triage-output' },
          ],
        },
      ],
    };

    const md = generateLowLevelMarkdown(trace, { id: 'test-module', name: 'Test Module' });
    assert.ok(md.includes('type | event-name | channel'), 'Should have events header');
    assert.ok(md.includes('publish | work.completed | dev-team-output'), 'Should have publish event');
    assert.ok(md.includes('subscribe | work.assigned | triage-output'), 'Should have subscribe event');
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
            { target: 'knowledge-team/service.py', function: 'query_knowledge', context: 'processItem' },
          ],
          events: [],
        },
      ],
    };

    const md = generateLowLevelMarkdown(trace, { id: 'test-module', name: 'Test Module' });
    assert.ok(md.includes('target | function | context'), 'Should have calls header');
    assert.ok(md.includes('knowledge-team/service.py | query_knowledge | processItem'), 'Should have call entry');
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
    assert.ok(existsSync(jsonPath), 'JSON file should exist');
    const jsonContent = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    assert.equal(jsonContent.moduleId, 'test-module');

    // Check markdown file exists
    const mdPath = join(testRoot, '.claude', 'traces', 'low-level', 'test-module.md');
    assert.ok(existsSync(mdPath), 'Markdown file should exist');
    const mdContent = readFileSync(mdPath, 'utf-8');
    assert.ok(mdContent.includes('# Low-Level Trace: Test Module'));

    // Check result
    assert.equal(result.moduleId, 'test-module');
    assert.equal(result.fileCount, 1);
    assert.equal(result.version, 1);
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
    assert.ok(existsSync(jsonPath), 'Should create directory and write file');
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
    assert.equal(
      validation.valid,
      true,
      `Written JSON failed schema validation: ${validation.errors.join(', ')}`,
    );
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

    assert.equal(result.modulesProcessed, 2, 'Should process both modules');
    assert.equal(result.results.length, 2);
    assert.ok(result.results.some(r => r.moduleId === 'test-module'));
    assert.ok(result.results.some(r => r.moduleId === 'other-module'));

    // Verify files were written
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'test-module.json')));
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'test-module.md')));
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'other-module.json')));
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'other-module.md')));
  });

  it('should generate trace for a single targeted module', () => {
    writeFileSync(join(testRoot, 'src', 'test-module', 'index.ts'), 'export const x = 1;');
    writeFileSync(join(testRoot, 'src', 'other', 'index.ts'), 'export const y = 2;');
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const result = generateAllLowLevelTraces('test-module', testRoot);

    assert.equal(result.modulesProcessed, 1, 'Should process only targeted module');
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].moduleId, 'test-module');

    // Only targeted module should have files written
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'test-module.json')));
    assert.ok(!existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'other-module.json')));
  });

  it('should throw for unknown target module', () => {
    assert.throws(
      () => generateAllLowLevelTraces('nonexistent-module', testRoot),
      /Module "nonexistent-module" not found/,
    );
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
    assert.equal(genResult.modulesProcessed, 1);

    // Read and validate JSON
    const jsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'test-module.json');
    const trace = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    const validation = validateLowLevelTrace(trace);
    assert.equal(
      validation.valid,
      true,
      `JSON validation failed: ${validation.errors.join(', ')}`,
    );

    // Verify all 4 files are present (AC-3.3)
    assert.equal(trace.files.length, 4, 'All 4 files should be in trace');
    const filePaths = trace.files.map(f => f.filePath).sort();
    assert.ok(filePaths.includes('src/test-module/README.md'));
    assert.ok(filePaths.includes('src/test-module/index.ts'));
    assert.ok(filePaths.includes('src/test-module/nested/helper.mjs'));
    assert.ok(filePaths.includes('src/test-module/service.ts'));

    // Read and validate markdown structure
    const mdPath = join(testRoot, '.claude', 'traces', 'low-level', 'test-module.md');
    const md = readFileSync(mdPath, 'utf-8');

    // AC-3.2: HTML comment metadata
    assert.ok(md.includes('<!-- trace-id: test-module -->'));
    assert.ok(md.includes('<!-- trace-version: 1 -->'));
    assert.ok(md.includes('<!-- generated-by: trace-generate -->'));

    // AC-3.2: File sections exist
    assert.ok(md.includes('## File: src/test-module/service.ts'));
    assert.ok(md.includes('## File: src/test-module/index.ts'));
    assert.ok(md.includes('## File: src/test-module/nested/helper.mjs'));
    assert.ok(md.includes('## File: src/test-module/README.md'));

    // AC-3.2: Structured sections with pipe-delimited format
    assert.ok(md.includes('### Exports'));
    assert.ok(md.includes('### Imports'));
    assert.ok(md.includes('### Function Calls'));
    assert.ok(md.includes('### Events'));
    assert.ok(md.includes('symbol | type'));
    assert.ok(md.includes('source | symbols'));

    // Verify service.ts has real content
    assert.ok(md.includes('AlertService | class'));
    assert.ok(md.includes('createAlertService | function'));
    assert.ok(md.includes('node:fs | readFileSync, writeFileSync'));

    // Verify README.md has empty sections
    // (it will have _No exports_ etc since it's not TS/JS)
    assert.ok(md.includes('_No exports_'));
  });
});

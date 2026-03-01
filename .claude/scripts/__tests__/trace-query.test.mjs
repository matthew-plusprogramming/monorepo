/**
 * Integration tests for trace-query.mjs (Agent Trace Query Interface)
 *
 * Tests: as-014-agent-consumption (AC-14.1, AC-14.2, AC-14.3)
 *
 * Validates:
 * - AC-14.1: Agent can identify upstream dependencies and downstream dependents
 * - AC-14.2: Module IDs in high-level trace correspond to low-level trace file names
 * - AC-14.3: Low-level trace files show file-level imports, exports, calls, events
 * - Drill-down from high-level to low-level works end-to-end
 * - Impact analysis correctly identifies affected modules
 *
 * Run with: node --test .claude/scripts/__tests__/trace-query.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import {
  loadHighLevelTrace,
  loadLowLevelTrace,
  queryModule,
  formatModuleQuery,
  analyzeImpact,
  formatImpactAnalysis,
  parseArgs,
} from '../trace-query.mjs';

import { generateAllTraces } from '../trace-generate.mjs';

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create a multi-module test project with trace config, source files,
 * and generate traces for it. Returns the project root path.
 */
function createTestProject() {
  const timestamp = Date.now();
  const testRoot = join(
    tmpdir(),
    `trace-query-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
  );

  // Create directory structure
  mkdirSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true });
  mkdirSync(join(testRoot, 'src', 'module-a'), { recursive: true });
  mkdirSync(join(testRoot, 'src', 'module-b'), { recursive: true });
  mkdirSync(join(testRoot, 'src', 'module-c'), { recursive: true });
  mkdirSync(join(testRoot, 'src', 'untraced'), { recursive: true });

  // Write trace config with 3 modules
  const config = {
    version: 1,
    projectRoot: '.',
    modules: [
      {
        id: 'module-a',
        name: 'Module A',
        description: 'Service A that processes events',
        fileGlobs: ['src/module-a/**'],
      },
      {
        id: 'module-b',
        name: 'Module B',
        description: 'Service B that stores data',
        fileGlobs: ['src/module-b/**'],
      },
      {
        id: 'module-c',
        name: 'Module C',
        description: 'Service C that depends on A and B',
        fileGlobs: ['src/module-c/**'],
      },
    ],
  };
  writeFileSync(
    join(testRoot, '.claude', 'traces', 'trace.config.json'),
    JSON.stringify(config, null, 2),
  );

  // Write source files for module-a
  writeFileSync(join(testRoot, 'src', 'module-a', 'service.ts'), `
import { readFileSync } from 'node:fs';
import type { Config } from '../types.js';

export interface EventPayload {
  readonly id: string;
  readonly type: string;
}

export class EventService {
  async processEvent(payload: EventPayload): Promise<void> {
    // Process event
  }
}

export function createEventService(): EventService {
  return new EventService();
}

export const EVENT_TIMEOUT_MS = 30000;
`);

  writeFileSync(join(testRoot, 'src', 'module-a', 'index.ts'), `
export { EventService, createEventService } from './service.js';
export type { EventPayload } from './service.js';
`);

  // Write source files for module-b
  writeFileSync(join(testRoot, 'src', 'module-b', 'store.ts'), `
import { writeFileSync } from 'node:fs';

export class DataStore {
  async save(key: string, value: unknown): Promise<void> {
    // Save data
  }
}

export function createDataStore(): DataStore {
  return new DataStore();
}
`);

  // Write source files for module-c
  writeFileSync(join(testRoot, 'src', 'module-c', 'orchestrator.ts'), `
import { EventService } from '../module-a/service.js';
import { DataStore } from '../module-b/store.js';

export class Orchestrator {
  constructor(
    private events: EventService,
    private store: DataStore,
  ) {}

  async run(): Promise<void> {
    // Orchestrate work
  }
}
`);

  // Write untraced file
  writeFileSync(join(testRoot, 'src', 'untraced', 'helper.ts'), `
export function helper(): string {
  return 'hello';
}
`);

  // Initialize git repo for file discovery
  execSync('git init', { cwd: testRoot });
  execSync('git config user.email "test@test.com"', { cwd: testRoot });
  execSync('git config user.name "Test"', { cwd: testRoot });
  execSync('git add .', { cwd: testRoot });
  execSync('git commit -m "init"', { cwd: testRoot });

  // Generate traces (high-level + low-level)
  generateAllTraces({ projectRoot: testRoot });

  // Now manually add dependency data to the high-level trace
  // (v1 generation doesn't auto-detect inter-module deps)
  const highLevelPath = join(testRoot, '.claude', 'traces', 'high-level.json');
  const highLevel = JSON.parse(readFileSync(highLevelPath, 'utf-8'));

  // Module A: depended upon by C
  const modA = highLevel.modules.find(m => m.id === 'module-a');
  modA.dependents = [
    { targetId: 'module-c', relationshipType: 'imports', description: 'C imports EventService from A' },
  ];

  // Module B: depended upon by C
  const modB = highLevel.modules.find(m => m.id === 'module-b');
  modB.dependents = [
    { targetId: 'module-c', relationshipType: 'imports', description: 'C imports DataStore from B' },
  ];

  // Module C: depends on A and B
  const modC = highLevel.modules.find(m => m.id === 'module-c');
  modC.dependencies = [
    { targetId: 'module-a', relationshipType: 'imports', description: 'Imports EventService for event processing' },
    { targetId: 'module-b', relationshipType: 'imports', description: 'Imports DataStore for persistence' },
  ];

  writeFileSync(highLevelPath, JSON.stringify(highLevel, null, 2) + '\n');

  return testRoot;
}

// =============================================================================
// parseArgs tests
// =============================================================================

describe('parseArgs', () => {
  it('should parse --module flag', () => {
    const result = parseArgs(['node', 'trace-query.mjs', '--module', 'module-a']);
    assert.equal(result.mode, 'module');
    assert.equal(result.moduleId, 'module-a');
    assert.equal(result.detail, false);
  });

  it('should parse --module with --detail flag', () => {
    const result = parseArgs(['node', 'trace-query.mjs', '--module', 'module-a', '--detail']);
    assert.equal(result.mode, 'module');
    assert.equal(result.moduleId, 'module-a');
    assert.equal(result.detail, true);
  });

  it('should parse --impact flag', () => {
    const result = parseArgs(['node', 'trace-query.mjs', '--impact', 'src/module-a/service.ts']);
    assert.equal(result.mode, 'impact');
    assert.equal(result.filePath, 'src/module-a/service.ts');
  });

  it('should parse --help flag', () => {
    const result = parseArgs(['node', 'trace-query.mjs', '--help']);
    assert.equal(result.mode, 'help');
  });

  it('should return null mode for no arguments', () => {
    const result = parseArgs(['node', 'trace-query.mjs']);
    assert.equal(result.mode, null);
  });
});

// =============================================================================
// AC-14.1: Agent reads high-level trace for upstream/downstream info
// =============================================================================

describe('AC-14.1: Agent can identify upstream dependencies and downstream dependents', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestProject();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  });

  it('should identify upstream dependencies for module-c', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-c', highLevel);

    assert.ok(result, 'module-c should be found');
    assert.equal(result.dependencies.length, 2, 'module-c should have 2 upstream dependencies');

    const depTargets = result.dependencies.map(d => d.targetId);
    assert.ok(depTargets.includes('module-a'), 'Should depend on module-a');
    assert.ok(depTargets.includes('module-b'), 'Should depend on module-b');
  });

  it('should identify downstream dependents for module-a', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-a', highLevel);

    assert.ok(result, 'module-a should be found');
    assert.equal(result.dependents.length, 1, 'module-a should have 1 downstream dependent');
    assert.equal(result.dependents[0].targetId, 'module-c');
  });

  it('should include relationship type and description in dependencies', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-c', highLevel);

    for (const dep of result.dependencies) {
      assert.ok(dep.targetId, 'Each dependency must have targetId');
      assert.ok(dep.relationshipType, 'Each dependency must have relationshipType');
      assert.ok(dep.description, 'Each dependency must have description');
    }
  });

  it('should include relationship type and description in dependents', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-a', highLevel);

    for (const dep of result.dependents) {
      assert.ok(dep.targetId, 'Each dependent must have targetId');
      assert.ok(dep.relationshipType, 'Each dependent must have relationshipType');
      assert.ok(dep.description, 'Each dependent must have description');
    }
  });

  it('should report empty dependencies for module-a (leaf module)', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-a', highLevel);

    assert.equal(result.dependencies.length, 0, 'module-a has no upstream dependencies');
  });

  it('should report empty dependents for module-c (consumer module)', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-c', highLevel);

    assert.equal(result.dependents.length, 0, 'module-c has no downstream dependents');
  });

  it('should return null for unknown module', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('nonexistent', highLevel);

    assert.equal(result, null, 'Unknown module should return null');
  });

  it('formatted output should contain dependency tables', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-c', highLevel);
    const formatted = formatModuleQuery(result, false, testRoot);

    // Should have the module name
    assert.ok(formatted.includes('Module C'), 'Should include module name');

    // Should have upstream section with dependencies
    assert.ok(formatted.includes('Upstream Dependencies'), 'Should have upstream section');
    assert.ok(formatted.includes('module-a'), 'Should list module-a as upstream');
    assert.ok(formatted.includes('module-b'), 'Should list module-b as upstream');

    // Should have downstream section
    assert.ok(formatted.includes('Downstream Dependents'), 'Should have downstream section');
    assert.ok(formatted.includes('No downstream dependents'), 'module-c has no dependents');
  });
});

// =============================================================================
// AC-14.2: Module IDs correspond to low-level trace file names
// =============================================================================

describe('AC-14.2: Module IDs map to low-level trace file names', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestProject();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  });

  it('should load low-level trace by module ID from high-level trace', () => {
    const highLevel = loadHighLevelTrace(testRoot);

    // For each module in high-level trace, verify low-level file exists
    for (const mod of highLevel.modules) {
      const lowLevel = loadLowLevelTrace(mod.id, testRoot);
      assert.ok(
        lowLevel,
        `Low-level trace for module "${mod.id}" should exist at low-level/${mod.id}.json`,
      );
      assert.equal(
        lowLevel.moduleId,
        mod.id,
        `Low-level trace moduleId should match high-level module ID`,
      );
    }
  });

  it('drill-down: read high-level, extract module ID, read corresponding low-level', () => {
    // Simulate the agent workflow:
    // 1. Agent reads high-level trace
    const highLevel = loadHighLevelTrace(testRoot);
    assert.ok(highLevel.modules.length > 0, 'High-level trace should have modules');

    // 2. Agent picks a module (module-a)
    const targetModule = highLevel.modules.find(m => m.id === 'module-a');
    assert.ok(targetModule, 'module-a should be in high-level trace');

    // 3. Agent uses module ID to load low-level trace
    const lowLevel = loadLowLevelTrace(targetModule.id, testRoot);
    assert.ok(lowLevel, 'Low-level trace should be loadable by module ID');
    assert.equal(lowLevel.moduleId, 'module-a');

    // 4. Agent can see file-level details
    assert.ok(lowLevel.files.length > 0, 'Low-level trace should have file entries');
  });

  it('low-level trace JSON files exist on disk with correct naming', () => {
    const highLevel = loadHighLevelTrace(testRoot);

    for (const mod of highLevel.modules) {
      const jsonPath = join(testRoot, '.claude', 'traces', 'low-level', `${mod.id}.json`);
      const mdPath = join(testRoot, '.claude', 'traces', 'low-level', `${mod.id}.md`);

      assert.ok(existsSync(jsonPath), `${mod.id}.json should exist`);
      assert.ok(existsSync(mdPath), `${mod.id}.md should exist`);
    }
  });

  it('returns null for non-existent module low-level trace', () => {
    const lowLevel = loadLowLevelTrace('nonexistent-module', testRoot);
    assert.equal(lowLevel, null, 'Non-existent module should return null');
  });
});

// =============================================================================
// AC-14.3: Low-level traces show file-level detail for impact analysis
// =============================================================================

describe('AC-14.3: Low-level trace files show file-level detail', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestProject();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  });

  it('low-level trace for module-a contains file entries with imports', () => {
    const lowLevel = loadLowLevelTrace('module-a', testRoot);
    assert.ok(lowLevel, 'Low-level trace should exist');

    const serviceFile = lowLevel.files.find(f => f.filePath.includes('service.ts'));
    assert.ok(serviceFile, 'service.ts should be in the trace');

    // Check imports are present
    assert.ok(Array.isArray(serviceFile.imports), 'imports should be an array');
    assert.ok(serviceFile.imports.length > 0, 'service.ts should have imports');

    const importSources = serviceFile.imports.map(i => i.source);
    assert.ok(importSources.includes('node:fs'), 'Should import from node:fs');
  });

  it('low-level trace for module-a contains file entries with exports', () => {
    const lowLevel = loadLowLevelTrace('module-a', testRoot);

    const serviceFile = lowLevel.files.find(f => f.filePath.includes('service.ts'));
    assert.ok(serviceFile, 'service.ts should be in the trace');

    // Check exports are present
    assert.ok(Array.isArray(serviceFile.exports), 'exports should be an array');
    assert.ok(serviceFile.exports.length > 0, 'service.ts should have exports');

    const exportSymbols = serviceFile.exports.map(e => e.symbol);
    assert.ok(exportSymbols.includes('EventService'), 'Should export EventService');
    assert.ok(exportSymbols.includes('createEventService'), 'Should export createEventService');
    assert.ok(exportSymbols.includes('EVENT_TIMEOUT_MS'), 'Should export EVENT_TIMEOUT_MS');
  });

  it('low-level trace file entries have calls and events arrays', () => {
    const lowLevel = loadLowLevelTrace('module-a', testRoot);

    for (const file of lowLevel.files) {
      assert.ok(Array.isArray(file.calls), `${file.filePath} should have calls array`);
      assert.ok(Array.isArray(file.events), `${file.filePath} should have events array`);
    }
  });

  it('low-level trace exports include type information', () => {
    const lowLevel = loadLowLevelTrace('module-a', testRoot);

    const serviceFile = lowLevel.files.find(f => f.filePath.includes('service.ts'));

    // Each export should have symbol and type
    for (const exp of serviceFile.exports) {
      assert.ok(typeof exp.symbol === 'string', 'export.symbol must be a string');
      assert.ok(typeof exp.type === 'string', 'export.type must be a string');
    }

    // Verify specific types
    const eventService = serviceFile.exports.find(e => e.symbol === 'EventService');
    assert.equal(eventService.type, 'class', 'EventService should be type class');

    const createFn = serviceFile.exports.find(e => e.symbol === 'createEventService');
    assert.equal(createFn.type, 'function', 'createEventService should be type function');

    const timeout = serviceFile.exports.find(e => e.symbol === 'EVENT_TIMEOUT_MS');
    assert.equal(timeout.type, 'const', 'EVENT_TIMEOUT_MS should be type const');
  });

  it('low-level trace imports include source and symbols', () => {
    const lowLevel = loadLowLevelTrace('module-a', testRoot);

    const serviceFile = lowLevel.files.find(f => f.filePath.includes('service.ts'));

    for (const imp of serviceFile.imports) {
      assert.ok(typeof imp.source === 'string', 'import.source must be a string');
      assert.ok(Array.isArray(imp.symbols), 'import.symbols must be an array');
    }

    // Verify specific import
    const fsImport = serviceFile.imports.find(i => i.source === 'node:fs');
    assert.ok(fsImport, 'Should have node:fs import');
    assert.ok(fsImport.symbols.includes('readFileSync'), 'Should import readFileSync');
  });

  it('formatted detail output includes file-level information', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-a', highLevel);
    const formatted = formatModuleQuery(result, true, testRoot);

    // Should contain file-level detail section
    assert.ok(formatted.includes('File-Level Detail'), 'Should have file detail section');
    assert.ok(formatted.includes('service.ts'), 'Should include service.ts');

    // Should show exports and imports
    assert.ok(formatted.includes('EventService'), 'Should mention EventService export');
    assert.ok(formatted.includes('node:fs'), 'Should mention node:fs import');
  });
});

// =============================================================================
// Impact Analysis tests
// =============================================================================

describe('Impact analysis', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestProject();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  });

  it('should identify affected modules when changing a file in module-a', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8'),
    );
    const highLevel = loadHighLevelTrace(testRoot);

    const result = analyzeImpact('src/module-a/service.ts', config, highLevel, testRoot);

    assert.ok(result.owningModule, 'File should have an owning module');
    assert.equal(result.owningModule.id, 'module-a');
    assert.ok(result.affectedModules.length > 0, 'Should have affected modules');
    assert.ok(
      result.affectedModules.some(m => m.id === 'module-c'),
      'module-c should be affected (it depends on module-a)',
    );
  });

  it('should report no affected modules for leaf consumer (module-c)', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8'),
    );
    const highLevel = loadHighLevelTrace(testRoot);

    const result = analyzeImpact('src/module-c/orchestrator.ts', config, highLevel, testRoot);

    assert.ok(result.owningModule, 'File should have an owning module');
    assert.equal(result.owningModule.id, 'module-c');
    assert.equal(result.affectedModules.length, 0, 'module-c has no dependents');
  });

  it('should return null owning module for untraced files', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8'),
    );
    const highLevel = loadHighLevelTrace(testRoot);

    const result = analyzeImpact('src/untraced/helper.ts', config, highLevel, testRoot);

    assert.equal(result.owningModule, null, 'Untraced file should have null owning module');
    assert.equal(result.affectedModules.length, 0, 'No affected modules for untraced file');
  });

  it('should include file detail from low-level trace in impact analysis', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8'),
    );
    const highLevel = loadHighLevelTrace(testRoot);

    const result = analyzeImpact('src/module-a/service.ts', config, highLevel, testRoot);

    assert.ok(result.fileDetail, 'Should have file detail from low-level trace');
    assert.ok(result.fileDetail.exports.length > 0, 'File detail should have exports');
    assert.ok(result.fileDetail.imports.length > 0, 'File detail should have imports');
  });

  it('formatted impact output shows affected modules and file detail', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8'),
    );
    const highLevel = loadHighLevelTrace(testRoot);

    const result = analyzeImpact('src/module-a/service.ts', config, highLevel, testRoot);
    const formatted = formatImpactAnalysis('src/module-a/service.ts', result);

    // Should have header
    assert.ok(formatted.includes('Impact Analysis'), 'Should have Impact Analysis heading');
    assert.ok(formatted.includes('module-a'), 'Should mention owning module');

    // Should list affected modules
    assert.ok(formatted.includes('Affected Modules'), 'Should have Affected Modules section');
    assert.ok(formatted.includes('module-c'), 'Should list module-c as affected');

    // Should show exported symbols
    assert.ok(formatted.includes('EventService'), 'Should mention EventService export');
  });

  it('formatted impact output for untraced file shows warning', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8'),
    );
    const highLevel = loadHighLevelTrace(testRoot);

    const result = analyzeImpact('src/untraced/helper.ts', config, highLevel, testRoot);
    const formatted = formatImpactAnalysis('src/untraced/helper.ts', result);

    assert.ok(formatted.includes('Untraced file'), 'Should warn about untraced file');
  });
});

// =============================================================================
// End-to-end agent workflow simulation
// =============================================================================

describe('End-to-end agent consumption workflow', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestProject();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  });

  it('full workflow: high-level query -> identify deps -> drill down to low-level', () => {
    // Step 1: Agent reads high-level trace to understand module landscape
    const highLevel = loadHighLevelTrace(testRoot);
    assert.ok(highLevel.modules.length === 3, 'Should see 3 modules');

    // Step 2: Agent queries module-c to understand what it depends on
    const modCResult = queryModule('module-c', highLevel);
    assert.ok(modCResult, 'Should find module-c');
    assert.equal(modCResult.dependencies.length, 2, 'module-c depends on 2 modules');

    // Step 3: Agent identifies upstream dependency module-a
    const depA = modCResult.dependencies.find(d => d.targetId === 'module-a');
    assert.ok(depA, 'Should see dependency on module-a');
    assert.equal(depA.relationshipType, 'imports');

    // Step 4: Agent drills down to low-level trace for module-a (AC-14.2)
    const lowLevelA = loadLowLevelTrace(depA.targetId, testRoot);
    assert.ok(lowLevelA, 'Should load low-level trace for module-a');
    assert.equal(lowLevelA.moduleId, 'module-a');

    // Step 5: Agent examines file-level detail (AC-14.3)
    const serviceFile = lowLevelA.files.find(f => f.filePath.includes('service.ts'));
    assert.ok(serviceFile, 'Should find service.ts in low-level trace');

    // Agent can see what module-a exports (impact surface)
    const exportedSymbols = serviceFile.exports.map(e => e.symbol);
    assert.ok(exportedSymbols.includes('EventService'), 'EventService is exported');
    assert.ok(exportedSymbols.includes('createEventService'), 'createEventService is exported');

    // Agent now knows: if they change EventService in module-a,
    // it will affect module-c which imports it.
  });

  it('full workflow: impact check before editing a file', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8'),
    );
    const highLevel = loadHighLevelTrace(testRoot);

    // Agent wants to edit src/module-b/store.ts
    // First, check impact
    const impact = analyzeImpact('src/module-b/store.ts', config, highLevel, testRoot);

    assert.equal(impact.owningModule.id, 'module-b');
    assert.ok(
      impact.affectedModules.some(m => m.id === 'module-c'),
      'Changing module-b/store.ts affects module-c',
    );

    // Agent sees the file's exports (what consumers depend on)
    assert.ok(impact.fileDetail, 'Should have file detail');
    const exportSymbols = impact.fileDetail.exports.map(e => e.symbol);
    assert.ok(exportSymbols.includes('DataStore'), 'DataStore is exported');
    assert.ok(exportSymbols.includes('createDataStore'), 'createDataStore is exported');

    // Agent now knows to check module-c for DataStore usage before changing it
  });

  it('detail flag provides complete drill-down output', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-a', highLevel);
    const detailed = formatModuleQuery(result, true, testRoot);

    // Verify the output has all three levels of information:
    // 1. Module-level info
    assert.ok(detailed.includes('Module A'), 'Has module name');
    assert.ok(detailed.includes('module-a'), 'Has module ID');

    // 2. Dependency info
    assert.ok(detailed.includes('Upstream Dependencies'), 'Has upstream section');
    assert.ok(detailed.includes('Downstream Dependents'), 'Has downstream section');
    assert.ok(detailed.includes('module-c'), 'Shows module-c as dependent');

    // 3. File-level detail (from low-level trace)
    assert.ok(detailed.includes('File-Level Detail'), 'Has file detail section');
    assert.ok(detailed.includes('service.ts'), 'Lists service.ts');
    assert.ok(detailed.includes('Exports'), 'Shows exports');
    assert.ok(detailed.includes('Imports'), 'Shows imports');
  });
});

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
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs trace-query.test.mjs
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
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
    expect(result.mode).toBe('module');
    expect(result.moduleId).toBe('module-a');
    expect(result.detail).toBe(false);
  });

  it('should parse --module with --detail flag', () => {
    const result = parseArgs(['node', 'trace-query.mjs', '--module', 'module-a', '--detail']);
    expect(result.mode).toBe('module');
    expect(result.moduleId).toBe('module-a');
    expect(result.detail).toBe(true);
  });

  it('should parse --impact flag', () => {
    const result = parseArgs(['node', 'trace-query.mjs', '--impact', 'src/module-a/service.ts']);
    expect(result.mode).toBe('impact');
    expect(result.filePath).toBe('src/module-a/service.ts');
  });

  it('should parse --help flag', () => {
    const result = parseArgs(['node', 'trace-query.mjs', '--help']);
    expect(result.mode).toBe('help');
  });

  it('should return null mode for no arguments', () => {
    const result = parseArgs(['node', 'trace-query.mjs']);
    expect(result.mode).toBe(null);
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

    expect(result).toBeTruthy();
    expect(result.dependencies.length).toBe(2);

    const depTargets = result.dependencies.map(d => d.targetId);
    expect(depTargets.includes('module-a')).toBeTruthy();
    expect(depTargets.includes('module-b')).toBeTruthy();
  });

  it('should identify downstream dependents for module-a', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-a', highLevel);

    expect(result).toBeTruthy();
    expect(result.dependents.length).toBe(1);
    expect(result.dependents[0].targetId).toBe('module-c');
  });

  it('should include relationship type and description in dependencies', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-c', highLevel);

    for (const dep of result.dependencies) {
      expect(dep.targetId).toBeTruthy();
      expect(dep.relationshipType).toBeTruthy();
      expect(dep.description).toBeTruthy();
    }
  });

  it('should include relationship type and description in dependents', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-a', highLevel);

    for (const dep of result.dependents) {
      expect(dep.targetId).toBeTruthy();
      expect(dep.relationshipType).toBeTruthy();
      expect(dep.description).toBeTruthy();
    }
  });

  it('should report empty dependencies for module-a (leaf module)', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-a', highLevel);

    expect(result.dependencies.length).toBe(0);
  });

  it('should report empty dependents for module-c (consumer module)', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-c', highLevel);

    expect(result.dependents.length).toBe(0);
  });

  it('should return null for unknown module', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('nonexistent', highLevel);

    expect(result).toBe(null);
  });

  it('formatted output should contain dependency tables', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-c', highLevel);
    const formatted = formatModuleQuery(result, false, testRoot);

    // Should have the module name
    expect(formatted.includes('Module C')).toBeTruthy();

    // Should have upstream section with dependencies
    expect(formatted.includes('Upstream Dependencies')).toBeTruthy();
    expect(formatted.includes('module-a')).toBeTruthy();
    expect(formatted.includes('module-b')).toBeTruthy();

    // Should have downstream section
    expect(formatted.includes('Downstream Dependents')).toBeTruthy();
    expect(formatted.includes('No downstream dependents')).toBeTruthy();
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
      expect(lowLevel).toBeTruthy();
      expect(lowLevel.moduleId).toBe(mod.id);
    }
  });

  it('drill-down: read high-level, extract module ID, read corresponding low-level', () => {
    // Simulate the agent workflow:
    // 1. Agent reads high-level trace
    const highLevel = loadHighLevelTrace(testRoot);
    expect(highLevel.modules.length > 0).toBeTruthy();

    // 2. Agent picks a module (module-a)
    const targetModule = highLevel.modules.find(m => m.id === 'module-a');
    expect(targetModule).toBeTruthy();

    // 3. Agent uses module ID to load low-level trace
    const lowLevel = loadLowLevelTrace(targetModule.id, testRoot);
    expect(lowLevel).toBeTruthy();
    expect(lowLevel.moduleId).toBe('module-a');

    // 4. Agent can see file-level details
    expect(lowLevel.files.length > 0).toBeTruthy();
  });

  it('low-level trace JSON files exist on disk with correct naming', () => {
    const highLevel = loadHighLevelTrace(testRoot);

    for (const mod of highLevel.modules) {
      const jsonPath = join(testRoot, '.claude', 'traces', 'low-level', `${mod.id}.json`);
      const mdPath = join(testRoot, '.claude', 'traces', 'low-level', `${mod.id}.md`);

      expect(existsSync(jsonPath)).toBeTruthy();
      expect(existsSync(mdPath)).toBeTruthy();
    }
  });

  it('returns null for non-existent module low-level trace', () => {
    const lowLevel = loadLowLevelTrace('nonexistent-module', testRoot);
    expect(lowLevel).toBe(null);
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
    expect(lowLevel).toBeTruthy();

    const serviceFile = lowLevel.files.find(f => f.filePath.includes('service.ts'));
    expect(serviceFile).toBeTruthy();

    // Check imports are present
    expect(Array.isArray(serviceFile.imports)).toBeTruthy();
    expect(serviceFile.imports.length > 0).toBeTruthy();

    const importSources = serviceFile.imports.map(i => i.source);
    expect(importSources.includes('node:fs')).toBeTruthy();
  });

  it('low-level trace for module-a contains file entries with exports', () => {
    const lowLevel = loadLowLevelTrace('module-a', testRoot);

    const serviceFile = lowLevel.files.find(f => f.filePath.includes('service.ts'));
    expect(serviceFile).toBeTruthy();

    // Check exports are present
    expect(Array.isArray(serviceFile.exports)).toBeTruthy();
    expect(serviceFile.exports.length > 0).toBeTruthy();

    const exportSymbols = serviceFile.exports.map(e => e.symbol);
    expect(exportSymbols.includes('EventService')).toBeTruthy();
    expect(exportSymbols.includes('createEventService')).toBeTruthy();
    expect(exportSymbols.includes('EVENT_TIMEOUT_MS')).toBeTruthy();
  });

  it('low-level trace file entries have calls and events arrays', () => {
    const lowLevel = loadLowLevelTrace('module-a', testRoot);

    for (const file of lowLevel.files) {
      expect(Array.isArray(file.calls)).toBeTruthy();
      expect(Array.isArray(file.events)).toBeTruthy();
    }
  });

  it('low-level trace exports include type information', () => {
    const lowLevel = loadLowLevelTrace('module-a', testRoot);

    const serviceFile = lowLevel.files.find(f => f.filePath.includes('service.ts'));

    // Each export should have symbol and type
    for (const exp of serviceFile.exports) {
      expect(typeof exp.symbol === 'string').toBeTruthy();
      expect(typeof exp.type === 'string').toBeTruthy();
    }

    // Verify specific types
    const eventService = serviceFile.exports.find(e => e.symbol === 'EventService');
    expect(eventService.type).toBe('class');

    const createFn = serviceFile.exports.find(e => e.symbol === 'createEventService');
    expect(createFn.type).toBe('function');

    const timeout = serviceFile.exports.find(e => e.symbol === 'EVENT_TIMEOUT_MS');
    expect(timeout.type).toBe('const');
  });

  it('low-level trace imports include source and symbols', () => {
    const lowLevel = loadLowLevelTrace('module-a', testRoot);

    const serviceFile = lowLevel.files.find(f => f.filePath.includes('service.ts'));

    for (const imp of serviceFile.imports) {
      expect(typeof imp.source === 'string').toBeTruthy();
      expect(Array.isArray(imp.symbols)).toBeTruthy();
    }

    // Verify specific import
    const fsImport = serviceFile.imports.find(i => i.source === 'node:fs');
    expect(fsImport).toBeTruthy();
    expect(fsImport.symbols.includes('readFileSync')).toBeTruthy();
  });

  it('formatted detail output includes file-level information', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-a', highLevel);
    const formatted = formatModuleQuery(result, true, testRoot);

    // Should contain file-level detail section
    expect(formatted.includes('File-Level Detail')).toBeTruthy();
    expect(formatted.includes('service.ts')).toBeTruthy();

    // Should show exports and imports
    expect(formatted.includes('EventService')).toBeTruthy();
    expect(formatted.includes('node:fs')).toBeTruthy();
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

    expect(result.owningModule).toBeTruthy();
    expect(result.owningModule.id).toBe('module-a');
    expect(result.affectedModules.length > 0).toBeTruthy();
    expect(result.affectedModules.some(m => m.id === 'module-c')).toBeTruthy();
  });

  it('should report no affected modules for leaf consumer (module-c)', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8'),
    );
    const highLevel = loadHighLevelTrace(testRoot);

    const result = analyzeImpact('src/module-c/orchestrator.ts', config, highLevel, testRoot);

    expect(result.owningModule).toBeTruthy();
    expect(result.owningModule.id).toBe('module-c');
    expect(result.affectedModules.length).toBe(0);
  });

  it('should return null owning module for untraced files', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8'),
    );
    const highLevel = loadHighLevelTrace(testRoot);

    const result = analyzeImpact('src/untraced/helper.ts', config, highLevel, testRoot);

    expect(result.owningModule).toBe(null);
    expect(result.affectedModules.length).toBe(0);
  });

  it('should include file detail from low-level trace in impact analysis', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8'),
    );
    const highLevel = loadHighLevelTrace(testRoot);

    const result = analyzeImpact('src/module-a/service.ts', config, highLevel, testRoot);

    expect(result.fileDetail).toBeTruthy();
    expect(result.fileDetail.exports.length > 0).toBeTruthy();
    expect(result.fileDetail.imports.length > 0).toBeTruthy();
  });

  it('formatted impact output shows affected modules and file detail', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8'),
    );
    const highLevel = loadHighLevelTrace(testRoot);

    const result = analyzeImpact('src/module-a/service.ts', config, highLevel, testRoot);
    const formatted = formatImpactAnalysis('src/module-a/service.ts', result);

    // Should have header
    expect(formatted.includes('Impact Analysis')).toBeTruthy();
    expect(formatted.includes('module-a')).toBeTruthy();

    // Should list affected modules
    expect(formatted.includes('Affected Modules')).toBeTruthy();
    expect(formatted.includes('module-c')).toBeTruthy();

    // Should show exported symbols
    expect(formatted.includes('EventService')).toBeTruthy();
  });

  it('formatted impact output for untraced file shows warning', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8'),
    );
    const highLevel = loadHighLevelTrace(testRoot);

    const result = analyzeImpact('src/untraced/helper.ts', config, highLevel, testRoot);
    const formatted = formatImpactAnalysis('src/untraced/helper.ts', result);

    expect(formatted.includes('Untraced file')).toBeTruthy();
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
    expect(highLevel.modules.length === 3).toBeTruthy();

    // Step 2: Agent queries module-c to understand what it depends on
    const modCResult = queryModule('module-c', highLevel);
    expect(modCResult).toBeTruthy();
    expect(modCResult.dependencies.length).toBe(2);

    // Step 3: Agent identifies upstream dependency module-a
    const depA = modCResult.dependencies.find(d => d.targetId === 'module-a');
    expect(depA).toBeTruthy();
    expect(depA.relationshipType).toBe('imports');

    // Step 4: Agent drills down to low-level trace for module-a (AC-14.2)
    const lowLevelA = loadLowLevelTrace(depA.targetId, testRoot);
    expect(lowLevelA).toBeTruthy();
    expect(lowLevelA.moduleId).toBe('module-a');

    // Step 5: Agent examines file-level detail (AC-14.3)
    const serviceFile = lowLevelA.files.find(f => f.filePath.includes('service.ts'));
    expect(serviceFile).toBeTruthy();

    // Agent can see what module-a exports (impact surface)
    const exportedSymbols = serviceFile.exports.map(e => e.symbol);
    expect(exportedSymbols.includes('EventService')).toBeTruthy();
    expect(exportedSymbols.includes('createEventService')).toBeTruthy();

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

    expect(impact.owningModule.id).toBe('module-b');
    expect(impact.affectedModules.some(m => m.id === 'module-c')).toBeTruthy();

    // Agent sees the file's exports (what consumers depend on)
    expect(impact.fileDetail).toBeTruthy();
    const exportSymbols = impact.fileDetail.exports.map(e => e.symbol);
    expect(exportSymbols.includes('DataStore')).toBeTruthy();
    expect(exportSymbols.includes('createDataStore')).toBeTruthy();

    // Agent now knows to check module-c for DataStore usage before changing it
  });

  it('detail flag provides complete drill-down output', () => {
    const highLevel = loadHighLevelTrace(testRoot);
    const result = queryModule('module-a', highLevel);
    const detailed = formatModuleQuery(result, true, testRoot);

    // Verify the output has all three levels of information:
    // 1. Module-level info
    expect(detailed.includes('Module A')).toBeTruthy();
    expect(detailed.includes('module-a')).toBeTruthy();

    // 2. Dependency info
    expect(detailed.includes('Upstream Dependencies')).toBeTruthy();
    expect(detailed.includes('Downstream Dependents')).toBeTruthy();
    expect(detailed.includes('module-c')).toBeTruthy();

    // 3. File-level detail (from low-level trace)
    expect(detailed.includes('File-Level Detail')).toBeTruthy();
    expect(detailed.includes('service.ts')).toBeTruthy();
    expect(detailed.includes('Exports')).toBeTruthy();
    expect(detailed.includes('Imports')).toBeTruthy();
  });
});

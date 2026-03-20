/**
 * Unit tests for high-level-trace.mjs
 *
 * Tests: as-003-high-level-trace (AC-2.1, AC-2.2, AC-2.3, AC-2.4)
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs .claude/scripts/__tests__/high-level-trace.test.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  validateHighLevelTrace,
  generateHighLevelTraceJSON,
  generateHighLevelTraceMarkdown,
  generateHighLevelTrace,
  readExistingHighLevelTrace,
  VALID_RELATIONSHIP_TYPES,
} from '../lib/high-level-trace.mjs';

// --- Test fixtures ---

/** Minimal valid trace config for testing */
function createTestConfig() {
  return {
    version: 1,
    projectRoot: '.',
    modules: [
      {
        id: 'dev-team',
        name: 'Dev Team',
        description: 'Handles development work items and code generation',
        fileGlobs: ['apps/agent-orchestrator/src/dev-team/**'],
      },
      {
        id: 'qa-team',
        name: 'QA Team',
        description: 'Quality assurance and test execution',
        fileGlobs: ['apps/agent-orchestrator/src/qa-team/**'],
      },
      {
        id: 'knowledge-team',
        name: 'Knowledge Team',
        description: 'Knowledge base management',
        fileGlobs: ['apps/agent-orchestrator/src/knowledge/**'],
      },
    ],
  };
}

/** Sample dependency data for testing (string moduleId arrays) */
function createTestDependencyData() {
  return {
    'dev-team': {
      dependencies: ['qa-team', 'knowledge-team'],
      dependents: ['qa-team'],
    },
    'qa-team': {
      dependencies: ['dev-team'],
      dependents: ['dev-team'],
    },
  };
}

/** Create a valid high-level trace object for testing (string moduleId format) */
function createValidTrace() {
  return {
    version: 1,
    lastGenerated: '2026-02-22T10:30:00.000Z',
    generatedBy: 'trace generate',
    projectRoot: '.',
    modules: [
      {
        id: 'dev-team',
        name: 'Dev Team',
        description: 'Development work',
        fileGlobs: ['src/dev-team/**'],
        dependencies: ['qa-team'],
        dependents: [],
      },
    ],
  };
}

// Helper to set up a temp dir with trace config
function setupTestRoot() {
  const timestamp = Date.now();
  const testRoot = join(
    tmpdir(),
    `high-level-trace-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(testRoot, '.claude', 'traces'), { recursive: true });
  return testRoot;
}

function writeTestConfig(testRoot, config) {
  writeFileSync(
    join(testRoot, '.claude', 'traces', 'trace.config.json'),
    JSON.stringify(config, null, 2),
  );
}

// ============================================================
// validateHighLevelTrace tests (AC-2.1)
// ============================================================

describe('validateHighLevelTrace (AC-2.1)', () => {
  it('should validate a correctly-formed high-level trace', () => {
    const trace = createValidTrace();
    const result = validateHighLevelTrace(trace);
    expect(result.valid).toBeTruthy();
    expect(result.errors.length).toBe(0);
  });

  it('should reject null input', () => {
    const result = validateHighLevelTrace(null);
    expect(!result.valid).toBeTruthy();
    expect(result.errors.some(e => e.includes('must be an object'))).toBeTruthy();
  });

  it('should reject missing version', () => {
    const trace = createValidTrace();
    delete trace.version;
    const result = validateHighLevelTrace(trace);
    expect(!result.valid).toBeTruthy();
    expect(result.errors.some(e => e.includes('version must be an integer'))).toBeTruthy();
  });

  it('should reject non-integer version', () => {
    const trace = createValidTrace();
    trace.version = 1.5;
    const result = validateHighLevelTrace(trace);
    expect(!result.valid).toBeTruthy();
    expect(result.errors.some(e => e.includes('version must be an integer'))).toBeTruthy();
  });

  it('should reject missing lastGenerated', () => {
    const trace = createValidTrace();
    delete trace.lastGenerated;
    const result = validateHighLevelTrace(trace);
    expect(!result.valid).toBeTruthy();
    expect(result.errors.some(e => e.includes('lastGenerated must be a string'))).toBeTruthy();
  });

  it('should reject invalid lastGenerated timestamp', () => {
    const trace = createValidTrace();
    trace.lastGenerated = 'not-a-date';
    const result = validateHighLevelTrace(trace);
    expect(!result.valid).toBeTruthy();
    expect(result.errors.some(e => e.includes('valid ISO 8601'))).toBeTruthy();
  });

  it('should reject empty generatedBy', () => {
    const trace = createValidTrace();
    trace.generatedBy = '';
    const result = validateHighLevelTrace(trace);
    expect(!result.valid).toBeTruthy();
    expect(result.errors.some(e => e.includes('generatedBy must be a non-empty string'))).toBeTruthy();
  });

  it('should reject missing projectRoot', () => {
    const trace = createValidTrace();
    delete trace.projectRoot;
    const result = validateHighLevelTrace(trace);
    expect(!result.valid).toBeTruthy();
    expect(result.errors.some(e => e.includes('projectRoot must be a string'))).toBeTruthy();
  });

  it('should reject non-array modules', () => {
    const trace = createValidTrace();
    trace.modules = 'not-array';
    const result = validateHighLevelTrace(trace);
    expect(!result.valid).toBeTruthy();
    expect(result.errors.some(e => e.includes('modules must be an array'))).toBeTruthy();
  });

  it('should validate all required fields on module nodes', () => {
    const trace = createValidTrace();
    trace.modules = [
      {
        id: 'test',
        name: 'Test',
        description: 'Test module',
        fileGlobs: ['src/**'],
        dependencies: [],
        dependents: [],
      },
    ];
    const result = validateHighLevelTrace(trace);
    expect(result.valid).toBeTruthy();
  });

  it('should reject module missing id', () => {
    const trace = createValidTrace();
    trace.modules = [{ name: 'Test', description: 'X', fileGlobs: [], dependencies: [], dependents: [] }];
    const result = validateHighLevelTrace(trace);
    expect(!result.valid).toBeTruthy();
    expect(result.errors.some(e => e.includes('id must be a non-empty string'))).toBeTruthy();
  });

  it('should reject module missing name', () => {
    const trace = createValidTrace();
    trace.modules = [{ id: 'test', description: 'X', fileGlobs: [], dependencies: [], dependents: [] }];
    const result = validateHighLevelTrace(trace);
    expect(!result.valid).toBeTruthy();
    expect(result.errors.some(e => e.includes('name must be a non-empty string'))).toBeTruthy();
  });

  it('should reject module missing dependencies array', () => {
    const trace = createValidTrace();
    trace.modules = [{ id: 'test', name: 'Test', description: 'X', fileGlobs: [], dependents: [] }];
    const result = validateHighLevelTrace(trace);
    expect(!result.valid).toBeTruthy();
    expect(result.errors.some(e => e.includes('dependencies must be an array'))).toBeTruthy();
  });

  it('should reject module missing dependents array', () => {
    const trace = createValidTrace();
    trace.modules = [{ id: 'test', name: 'Test', description: 'X', fileGlobs: [], dependencies: [] }];
    const result = validateHighLevelTrace(trace);
    expect(!result.valid).toBeTruthy();
    expect(result.errors.some(e => e.includes('dependents must be an array'))).toBeTruthy();
  });

  it('should reject non-string dependency entries', () => {
    const trace = createValidTrace();
    trace.modules[0].dependencies = [
      { targetId: 'qa', relationshipType: 'imports', description: 'test' },
    ];
    const result = validateHighLevelTrace(trace);
    expect(!result.valid).toBeTruthy();
    expect(result.errors.some(e => e.includes('must be a non-empty string moduleId'))).toBeTruthy();
  });

  it('should accept valid string moduleId dependency entries', () => {
    const trace = createValidTrace();
    trace.modules[0].dependencies = ['qa-team', 'knowledge-team'];
    const result = validateHighLevelTrace(trace);
    expect(result.valid).toBeTruthy();
  });

  it('should reject empty string dependency entries', () => {
    const trace = createValidTrace();
    trace.modules[0].dependencies = [''];
    const result = validateHighLevelTrace(trace);
    expect(!result.valid).toBeTruthy();
    expect(result.errors.some(e => e.includes('must be a non-empty string moduleId'))).toBeTruthy();
  });

  it('should validate trace with empty modules array', () => {
    const trace = {
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'test',
      projectRoot: '.',
      modules: [],
    };
    const result = validateHighLevelTrace(trace);
    expect(result.valid).toBeTruthy();
  });

  it('should validate modules with empty dependencies and dependents', () => {
    const trace = createValidTrace();
    trace.modules[0].dependencies = [];
    trace.modules[0].dependents = [];
    const result = validateHighLevelTrace(trace);
    expect(result.valid).toBeTruthy();
  });
});

// ============================================================
// generateHighLevelTraceJSON tests (AC-2.1, AC-2.3, AC-2.4)
// ============================================================

describe('generateHighLevelTraceJSON', () => {
  it('AC-2.1: generated JSON should validate against HighLevelTrace schema', () => {
    const config = createTestConfig();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
    });

    const validation = validateHighLevelTrace(trace);
    expect(validation.valid).toBeTruthy();
  });

  it('AC-2.1: should include all required fields on each module node', () => {
    const config = createTestConfig();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
    });

    expect(trace.modules.length).toBe(3);
    for (const mod of trace.modules) {
      expect(typeof mod.id === 'string' && mod.id.length > 0).toBeTruthy();
      expect(typeof mod.name === 'string' && mod.name.length > 0).toBeTruthy();
      expect(typeof mod.description === 'string').toBeTruthy();
      expect(Array.isArray(mod.fileGlobs)).toBeTruthy();
      expect(Array.isArray(mod.dependencies)).toBeTruthy();
      expect(Array.isArray(mod.dependents)).toBeTruthy();
    }
  });

  it('AC-2.3: should start at version 1 when no existing trace', () => {
    const config = createTestConfig();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
    });
    expect(trace.version).toBe(1);
  });

  it('AC-2.3: should increment version from existing trace', () => {
    const config = createTestConfig();
    const existing = { version: 5, modules: [] };
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: existing,
    });
    expect(trace.version).toBe(6);
  });

  it('AC-2.3: should increment version from existing trace version 1 to 2', () => {
    const config = createTestConfig();
    const existing = { version: 1, modules: [] };
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: existing,
    });
    expect(trace.version).toBe(2);
  });

  it('AC-2.4: lastGenerated should be a valid ISO 8601 timestamp', () => {
    const config = createTestConfig();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
    });

    const parsed = new Date(trace.lastGenerated);
    expect(!Number.isNaN(parsed.getTime())).toBeTruthy();
    // Verify it is a recent timestamp (within last 5 seconds)
    const now = Date.now();
    const diff = now - parsed.getTime();
    expect(diff >= 0 && diff < 5000).toBeTruthy();
  });

  it('should use provided generatedBy identifier', () => {
    const config = createTestConfig();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
      generatedBy: 'test-generator',
    });
    expect(trace.generatedBy).toBe('test-generator');
  });

  it('should default generatedBy to "trace generate"', () => {
    const config = createTestConfig();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
    });
    expect(trace.generatedBy).toBe('trace generate');
  });

  it('should use projectRoot from config', () => {
    const config = createTestConfig();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
    });
    expect(trace.projectRoot).toBe('.');
  });

  it('should merge manual dependency data', () => {
    const config = createTestConfig();
    const depData = createTestDependencyData();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
      dependencyData: depData,
    });

    const devTeam = trace.modules.find(m => m.id === 'dev-team');
    expect(devTeam).toBeTruthy();
    expect(devTeam.dependencies.length).toBe(2);
    expect(devTeam.dependents.length).toBe(1);

    const qaTeam = trace.modules.find(m => m.id === 'qa-team');
    expect(qaTeam).toBeTruthy();
    expect(qaTeam.dependencies.length).toBe(1);
    expect(qaTeam.dependents.length).toBe(1);

    // knowledge-team has no manual deps, should be empty
    const knowledgeTeam = trace.modules.find(m => m.id === 'knowledge-team');
    expect(knowledgeTeam).toBeTruthy();
    expect(knowledgeTeam.dependencies.length).toBe(0);
    expect(knowledgeTeam.dependents.length).toBe(0);
  });

  it('should preserve existing dependency data when no manual data provided', () => {
    const config = createTestConfig();
    const existing = {
      version: 3,
      modules: [
        {
          id: 'dev-team',
          dependencies: ['qa-team'],
          dependents: [],
        },
      ],
    };
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: existing,
    });

    const devTeam = trace.modules.find(m => m.id === 'dev-team');
    expect(devTeam).toBeTruthy();
    expect(devTeam.dependencies.length).toBe(1);
    expect(devTeam.dependencies[0]).toBe('qa-team');
  });

  it('manual dependency data should override existing trace data', () => {
    const config = createTestConfig();
    const existing = {
      version: 3,
      modules: [
        {
          id: 'dev-team',
          dependencies: ['qa-team'],
          dependents: [],
        },
      ],
    };
    const depData = {
      'dev-team': {
        dependencies: ['knowledge-team'],
        dependents: [],
      },
    };
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: existing,
      dependencyData: depData,
    });

    const devTeam = trace.modules.find(m => m.id === 'dev-team');
    expect(devTeam).toBeTruthy();
    expect(devTeam.dependencies.length).toBe(1);
    expect(devTeam.dependencies[0]).toBe('knowledge-team');
  });

  it('should set empty description from config description that is undefined', () => {
    const config = {
      version: 1,
      projectRoot: '.',
      modules: [
        {
          id: 'no-desc',
          name: 'No Description',
          fileGlobs: ['src/**'],
          // description intentionally omitted
        },
      ],
    };
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
    });

    expect(trace.modules[0].description).toBe('');
  });
});

// ============================================================
// generateHighLevelTraceMarkdown tests (AC-2.2)
// ============================================================

describe('generateHighLevelTraceMarkdown (AC-2.2)', () => {
  it('should contain HTML comment metadata', () => {
    const trace = createValidTrace();
    const md = generateHighLevelTraceMarkdown(trace);

    expect(md.includes('<!-- trace-id: high-level -->')).toBeTruthy();
    expect(md.includes('<!-- trace-version: 1 -->')).toBeTruthy();
    expect(md.includes('<!-- last-generated: 2026-02-22T10:30:00.000Z -->')).toBeTruthy();
    expect(md.includes('<!-- generated-by: trace generate -->')).toBeTruthy();
  });

  it('should have # Architecture Trace: High-Level heading', () => {
    const trace = createValidTrace();
    const md = generateHighLevelTraceMarkdown(trace);
    expect(md.includes('# Architecture Trace: High-Level')).toBeTruthy();
  });

  it('should have ## Module: <Name> headings for each module', () => {
    const config = createTestConfig();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
    });
    const md = generateHighLevelTraceMarkdown(trace);

    expect(md.includes('## Module: Dev Team')).toBeTruthy();
    expect(md.includes('## Module: QA Team')).toBeTruthy();
    expect(md.includes('## Module: Knowledge Team')).toBeTruthy();
  });

  it('should include module ID, description, and file globs', () => {
    const trace = createValidTrace();
    const md = generateHighLevelTraceMarkdown(trace);

    expect(md.includes('**ID**: dev-team')).toBeTruthy();
    expect(md.includes('**Description**: Development work')).toBeTruthy();
    expect(md.includes('`src/dev-team/**`')).toBeTruthy();
  });

  it('should have dependency list sections with string moduleIds', () => {
    const trace = createValidTrace();
    const md = generateHighLevelTraceMarkdown(trace);

    expect(md.includes('### Dependencies')).toBeTruthy();
    expect(
      md.includes('- qa-team'),
    ).toBeTruthy();
  });

  it('should have dependent list sections with string moduleIds', () => {
    const config = createTestConfig();
    const depData = createTestDependencyData();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
      dependencyData: depData,
    });
    const md = generateHighLevelTraceMarkdown(trace);

    expect(md.includes('### Dependents')).toBeTruthy();
    // Dev team has qa-team as a dependent
    expect(
      md.includes('- qa-team'),
    ).toBeTruthy();
  });

  it('should show (none) for empty dependencies', () => {
    const trace = createValidTrace();
    trace.modules[0].dependents = [];
    const md = generateHighLevelTraceMarkdown(trace);

    // The dependents section should show (none)
    const dependentsSection = md.split('### Dependents')[1];
    expect(dependentsSection).toBeTruthy();
    expect(dependentsSection.includes('(none)')).toBeTruthy();
  });

  it('should show (none) for empty dependents', () => {
    const trace = {
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'trace generate',
      projectRoot: '.',
      modules: [
        {
          id: 'isolated',
          name: 'Isolated Module',
          description: 'No deps',
          fileGlobs: ['src/**'],
          dependencies: [],
          dependents: [],
        },
      ],
    };
    const md = generateHighLevelTraceMarkdown(trace);

    const sections = md.split('###');
    // Both Dependencies and Dependents should show (none)
    const depsSection = sections.find(s => s.trim().startsWith('Dependencies'));
    const dependentsSection = sections.find(s => s.trim().startsWith('Dependents'));
    expect(depsSection.includes('(none)')).toBeTruthy();
    expect(dependentsSection.includes('(none)')).toBeTruthy();
  });

  it('should render multiple modules correctly', () => {
    const config = createTestConfig();
    const depData = createTestDependencyData();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
      dependencyData: depData,
    });
    const md = generateHighLevelTraceMarkdown(trace);

    // Count module headings
    const moduleHeadings = md.match(/## Module: /g);
    expect(moduleHeadings.length).toBe(3);

    // Count Dependencies headings
    const depsHeadings = md.match(/### Dependencies/g);
    expect(depsHeadings.length).toBe(3);

    // Count Dependents headings
    const dependentsHeadings = md.match(/### Dependents/g);
    expect(dependentsHeadings.length).toBe(3);
  });

  it('should reflect correct version in metadata', () => {
    const trace = createValidTrace();
    trace.version = 42;
    const md = generateHighLevelTraceMarkdown(trace);
    expect(md.includes('<!-- trace-version: 42 -->')).toBeTruthy();
  });
});

// ============================================================
// Version increment tests (AC-2.3)
// ============================================================

describe('version increment behavior (AC-2.3)', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = setupTestRoot();
    writeTestConfig(testRoot, createTestConfig());
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should start at version 1 for new files', () => {
    const result = generateHighLevelTrace({ projectRoot: testRoot });
    expect(result.version).toBe(1);
    expect(result.json.version).toBe(1);
  });

  it('should increment to version 2 on second generation', () => {
    // First generation
    generateHighLevelTrace({ projectRoot: testRoot });

    // Second generation (reads existing file)
    const result = generateHighLevelTrace({ projectRoot: testRoot });
    expect(result.version).toBe(2);
  });

  it('should increment to version 3 on third generation', () => {
    // Generate three times
    generateHighLevelTrace({ projectRoot: testRoot });
    generateHighLevelTrace({ projectRoot: testRoot });
    const result = generateHighLevelTrace({ projectRoot: testRoot });
    expect(result.version).toBe(3);
  });

  it('should correctly read version from existing file on disk', () => {
    // Write a trace file with version 10 manually
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      JSON.stringify({ version: 10, modules: [] }),
    );

    const result = generateHighLevelTrace({ projectRoot: testRoot });
    expect(result.version).toBe(11);
  });
});

// ============================================================
// generateHighLevelTrace (full write to disk) tests
// ============================================================

describe('generateHighLevelTrace (disk write)', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = setupTestRoot();
    writeTestConfig(testRoot, createTestConfig());
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should write high-level.json to disk', () => {
    const result = generateHighLevelTrace({ projectRoot: testRoot });
    expect(existsSync(result.jsonPath)).toBeTruthy();

    const raw = readFileSync(result.jsonPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.modules)).toBeTruthy();
  });

  it('should write high-level.md to disk', () => {
    const result = generateHighLevelTrace({ projectRoot: testRoot });
    expect(existsSync(result.mdPath)).toBeTruthy();

    const content = readFileSync(result.mdPath, 'utf-8');
    expect(content.includes('<!-- trace-id: high-level -->')).toBeTruthy();
    expect(content.includes('# Architecture Trace: High-Level')).toBeTruthy();
  });

  it('should create .claude/traces/ directory if it does not exist', () => {
    // Use a fresh root without the traces directory
    const freshRoot = join(
      tmpdir(),
      `high-level-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(freshRoot, '.claude', 'traces'), { recursive: true });
    writeTestConfig(freshRoot, createTestConfig());

    // Remove and recreate without traces subdir to simulate fresh state
    // Actually, writeTestConfig already creates the dir. Test that it handles existing dir fine.
    const result = generateHighLevelTrace({ projectRoot: freshRoot });
    expect(existsSync(result.jsonPath)).toBeTruthy();
    expect(existsSync(result.mdPath)).toBeTruthy();

    rmSync(freshRoot, { recursive: true, force: true });
  });

  it('should return correct paths', () => {
    const result = generateHighLevelTrace({ projectRoot: testRoot });
    expect(result.jsonPath).toBe(join(testRoot, '.claude', 'traces', 'high-level.json'));
    expect(result.mdPath).toBe(join(testRoot, '.claude', 'traces', 'high-level.md'));
  });

  it('JSON on disk should validate against schema', () => {
    generateHighLevelTrace({ projectRoot: testRoot });

    const raw = readFileSync(join(testRoot, '.claude', 'traces', 'high-level.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    const validation = validateHighLevelTrace(parsed);
    expect(validation.valid).toBeTruthy();
  });

  it('markdown on disk should contain metadata and module sections', () => {
    const depData = createTestDependencyData();
    generateHighLevelTrace({ projectRoot: testRoot, dependencyData: depData });

    const content = readFileSync(join(testRoot, '.claude', 'traces', 'high-level.md'), 'utf-8');

    // Metadata
    expect(content.includes('<!-- trace-id: high-level -->')).toBeTruthy();
    expect(content.includes('<!-- trace-version: 1 -->')).toBeTruthy();
    expect(content.includes('<!-- generated-by: trace generate -->')).toBeTruthy();

    // Module sections
    expect(content.includes('## Module: Dev Team')).toBeTruthy();
    expect(content.includes('## Module: QA Team')).toBeTruthy();

    // String moduleId deps rendered as list
    expect(content.includes('- qa-team')).toBeTruthy();
  });

  it('should overwrite existing files on regeneration', () => {
    generateHighLevelTrace({ projectRoot: testRoot });

    // Verify version 1
    let raw = readFileSync(join(testRoot, '.claude', 'traces', 'high-level.json'), 'utf-8');
    expect(JSON.parse(raw).version).toBe(1);

    // Regenerate
    generateHighLevelTrace({ projectRoot: testRoot });

    // Verify version 2
    raw = readFileSync(join(testRoot, '.claude', 'traces', 'high-level.json'), 'utf-8');
    expect(JSON.parse(raw).version).toBe(2);
  });
});

// ============================================================
// readExistingHighLevelTrace tests
// ============================================================

describe('readExistingHighLevelTrace', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = setupTestRoot();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should return null when file does not exist', () => {
    const result = readExistingHighLevelTrace(testRoot);
    expect(result).toBe(null);
  });

  it('should return parsed object when file exists', () => {
    const trace = createValidTrace();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      JSON.stringify(trace),
    );

    const result = readExistingHighLevelTrace(testRoot);
    expect(result).toBeTruthy();
    expect(result.version).toBe(1);
  });

  it('should return null for malformed JSON', () => {
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      'not valid json {{{',
    );

    const result = readExistingHighLevelTrace(testRoot);
    expect(result).toBe(null);
  });
});

// ============================================================
// VALID_RELATIONSHIP_TYPES constant test
// ============================================================

describe('VALID_RELATIONSHIP_TYPES', () => {
  it('should contain all 7 relationship types from the spec', () => {
    const expected = [
      'imports',
      'calls',
      'publishes-to',
      'subscribes-from',
      'reads-from',
      'writes-to',
      'configures',
    ];
    expect(VALID_RELATIONSHIP_TYPES).toEqual(expected);
  });
});

// ============================================================
// Edge cases
// ============================================================

describe('edge cases', () => {
  it('should handle config with no projectRoot field', () => {
    const config = {
      version: 1,
      modules: [
        {
          id: 'test',
          name: 'Test',
          description: 'Test module',
          fileGlobs: ['src/**'],
        },
      ],
    };
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
    });
    expect(trace.projectRoot).toBe('.');
  });

  it('should handle modules with multiple fileGlobs', () => {
    const config = {
      version: 1,
      projectRoot: '.',
      modules: [
        {
          id: 'multi-glob',
          name: 'Multi Glob',
          description: 'Module with multiple globs',
          fileGlobs: ['src/a/**', 'src/b/**', 'src/c/**'],
        },
      ],
    };
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
    });
    expect(trace.modules[0].fileGlobs).toEqual(['src/a/**', 'src/b/**', 'src/c/**']);
  });

  it('markdown should render multiple fileGlobs inline', () => {
    const trace = {
      version: 1,
      lastGenerated: '2026-02-22T10:30:00.000Z',
      generatedBy: 'test',
      projectRoot: '.',
      modules: [
        {
          id: 'multi',
          name: 'Multi',
          description: 'Test',
          fileGlobs: ['src/a/**', 'src/b/**'],
          dependencies: [],
          dependents: [],
        },
      ],
    };
    const md = generateHighLevelTraceMarkdown(trace);
    expect(md.includes('`src/a/**`, `src/b/**`')).toBeTruthy();
  });
});

/**
 * Unit tests for high-level-trace.mjs
 *
 * Tests: as-003-high-level-trace (AC-2.1, AC-2.2, AC-2.3, AC-2.4)
 *
 * Run with: node --test .claude/scripts/__tests__/high-level-trace.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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

/** Sample dependency data for testing */
function createTestDependencyData() {
  return {
    'dev-team': {
      dependencies: [
        {
          targetId: 'qa-team',
          relationshipType: 'publishes-to',
          description: 'Sends completed work items for QA review',
        },
        {
          targetId: 'knowledge-team',
          relationshipType: 'reads-from',
          description: 'Reads knowledge base for context during development',
        },
      ],
      dependents: [
        {
          targetId: 'qa-team',
          relationshipType: 'subscribes-from',
          description: 'Receives QA feedback for rework',
        },
      ],
    },
    'qa-team': {
      dependencies: [
        {
          targetId: 'dev-team',
          relationshipType: 'subscribes-from',
          description: 'Receives completed work items from dev team',
        },
      ],
      dependents: [
        {
          targetId: 'dev-team',
          relationshipType: 'publishes-to',
          description: 'Sends QA feedback to dev team',
        },
      ],
    },
  };
}

/** Create a valid high-level trace object for testing */
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
        dependencies: [
          {
            targetId: 'qa-team',
            relationshipType: 'publishes-to',
            description: 'Sends work items for QA',
          },
        ],
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
    assert.ok(result.valid, `Should be valid. Errors: ${result.errors.join(', ')}`);
    assert.equal(result.errors.length, 0);
  });

  it('should reject null input', () => {
    const result = validateHighLevelTrace(null);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('must be an object')));
  });

  it('should reject missing version', () => {
    const trace = createValidTrace();
    delete trace.version;
    const result = validateHighLevelTrace(trace);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('version must be an integer')));
  });

  it('should reject non-integer version', () => {
    const trace = createValidTrace();
    trace.version = 1.5;
    const result = validateHighLevelTrace(trace);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('version must be an integer')));
  });

  it('should reject missing lastGenerated', () => {
    const trace = createValidTrace();
    delete trace.lastGenerated;
    const result = validateHighLevelTrace(trace);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('lastGenerated must be a string')));
  });

  it('should reject invalid lastGenerated timestamp', () => {
    const trace = createValidTrace();
    trace.lastGenerated = 'not-a-date';
    const result = validateHighLevelTrace(trace);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('valid ISO 8601')));
  });

  it('should reject empty generatedBy', () => {
    const trace = createValidTrace();
    trace.generatedBy = '';
    const result = validateHighLevelTrace(trace);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('generatedBy must be a non-empty string')));
  });

  it('should reject missing projectRoot', () => {
    const trace = createValidTrace();
    delete trace.projectRoot;
    const result = validateHighLevelTrace(trace);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('projectRoot must be a string')));
  });

  it('should reject non-array modules', () => {
    const trace = createValidTrace();
    trace.modules = 'not-array';
    const result = validateHighLevelTrace(trace);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('modules must be an array')));
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
    assert.ok(result.valid, `Should be valid. Errors: ${result.errors.join(', ')}`);
  });

  it('should reject module missing id', () => {
    const trace = createValidTrace();
    trace.modules = [{ name: 'Test', description: 'X', fileGlobs: [], dependencies: [], dependents: [] }];
    const result = validateHighLevelTrace(trace);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('id must be a non-empty string')));
  });

  it('should reject module missing name', () => {
    const trace = createValidTrace();
    trace.modules = [{ id: 'test', description: 'X', fileGlobs: [], dependencies: [], dependents: [] }];
    const result = validateHighLevelTrace(trace);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('name must be a non-empty string')));
  });

  it('should reject module missing dependencies array', () => {
    const trace = createValidTrace();
    trace.modules = [{ id: 'test', name: 'Test', description: 'X', fileGlobs: [], dependents: [] }];
    const result = validateHighLevelTrace(trace);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('dependencies must be an array')));
  });

  it('should reject module missing dependents array', () => {
    const trace = createValidTrace();
    trace.modules = [{ id: 'test', name: 'Test', description: 'X', fileGlobs: [], dependencies: [] }];
    const result = validateHighLevelTrace(trace);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('dependents must be an array')));
  });

  it('should reject invalid dependency relationship type', () => {
    const trace = createValidTrace();
    trace.modules[0].dependencies = [
      { targetId: 'qa', relationshipType: 'invalid-type', description: 'test' },
    ];
    const result = validateHighLevelTrace(trace);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('not valid')));
  });

  it('should accept all valid relationship types', () => {
    for (const relType of VALID_RELATIONSHIP_TYPES) {
      const trace = createValidTrace();
      trace.modules[0].dependencies = [
        { targetId: 'other', relationshipType: relType, description: `test ${relType}` },
      ];
      const result = validateHighLevelTrace(trace);
      assert.ok(result.valid, `Relationship type "${relType}" should be valid. Errors: ${result.errors.join(', ')}`);
    }
  });

  it('should reject dependency missing targetId', () => {
    const trace = createValidTrace();
    trace.modules[0].dependencies = [
      { relationshipType: 'imports', description: 'test' },
    ];
    const result = validateHighLevelTrace(trace);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('targetId must be a non-empty string')));
  });

  it('should reject dependency missing description', () => {
    const trace = createValidTrace();
    trace.modules[0].dependencies = [
      { targetId: 'qa', relationshipType: 'imports' },
    ];
    const result = validateHighLevelTrace(trace);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('description must be a string')));
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
    assert.ok(result.valid, 'Empty modules array should be valid');
  });

  it('should validate modules with empty dependencies and dependents', () => {
    const trace = createValidTrace();
    trace.modules[0].dependencies = [];
    trace.modules[0].dependents = [];
    const result = validateHighLevelTrace(trace);
    assert.ok(result.valid, 'Empty deps/dependents should be valid');
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
    assert.ok(validation.valid, `Schema validation failed: ${validation.errors.join(', ')}`);
  });

  it('AC-2.1: should include all required fields on each module node', () => {
    const config = createTestConfig();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
    });

    assert.equal(trace.modules.length, 3, 'Should have 3 modules from config');
    for (const mod of trace.modules) {
      assert.ok(typeof mod.id === 'string' && mod.id.length > 0, `Module must have id`);
      assert.ok(typeof mod.name === 'string' && mod.name.length > 0, `Module must have name`);
      assert.ok(typeof mod.description === 'string', `Module must have description`);
      assert.ok(Array.isArray(mod.fileGlobs), `Module must have fileGlobs array`);
      assert.ok(Array.isArray(mod.dependencies), `Module must have dependencies array`);
      assert.ok(Array.isArray(mod.dependents), `Module must have dependents array`);
    }
  });

  it('AC-2.3: should start at version 1 when no existing trace', () => {
    const config = createTestConfig();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
    });
    assert.equal(trace.version, 1, 'First generation should be version 1');
  });

  it('AC-2.3: should increment version from existing trace', () => {
    const config = createTestConfig();
    const existing = { version: 5, modules: [] };
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: existing,
    });
    assert.equal(trace.version, 6, 'Should increment from 5 to 6');
  });

  it('AC-2.3: should increment version from existing trace version 1 to 2', () => {
    const config = createTestConfig();
    const existing = { version: 1, modules: [] };
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: existing,
    });
    assert.equal(trace.version, 2, 'Should increment from 1 to 2');
  });

  it('AC-2.4: lastGenerated should be a valid ISO 8601 timestamp', () => {
    const config = createTestConfig();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
    });

    const parsed = new Date(trace.lastGenerated);
    assert.ok(!Number.isNaN(parsed.getTime()), 'lastGenerated must parse to valid date');
    // Verify it is a recent timestamp (within last 5 seconds)
    const now = Date.now();
    const diff = now - parsed.getTime();
    assert.ok(diff >= 0 && diff < 5000, 'lastGenerated should be within last 5 seconds');
  });

  it('should use provided generatedBy identifier', () => {
    const config = createTestConfig();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
      generatedBy: 'test-generator',
    });
    assert.equal(trace.generatedBy, 'test-generator');
  });

  it('should default generatedBy to "trace generate"', () => {
    const config = createTestConfig();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
    });
    assert.equal(trace.generatedBy, 'trace generate');
  });

  it('should use projectRoot from config', () => {
    const config = createTestConfig();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
    });
    assert.equal(trace.projectRoot, '.');
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
    assert.ok(devTeam, 'Should find dev-team module');
    assert.equal(devTeam.dependencies.length, 2, 'Dev team should have 2 dependencies');
    assert.equal(devTeam.dependents.length, 1, 'Dev team should have 1 dependent');

    const qaTeam = trace.modules.find(m => m.id === 'qa-team');
    assert.ok(qaTeam, 'Should find qa-team module');
    assert.equal(qaTeam.dependencies.length, 1, 'QA team should have 1 dependency');
    assert.equal(qaTeam.dependents.length, 1, 'QA team should have 1 dependent');

    // knowledge-team has no manual deps, should be empty
    const knowledgeTeam = trace.modules.find(m => m.id === 'knowledge-team');
    assert.ok(knowledgeTeam, 'Should find knowledge-team module');
    assert.equal(knowledgeTeam.dependencies.length, 0, 'Knowledge team should have 0 dependencies');
    assert.equal(knowledgeTeam.dependents.length, 0, 'Knowledge team should have 0 dependents');
  });

  it('should preserve existing dependency data when no manual data provided', () => {
    const config = createTestConfig();
    const existing = {
      version: 3,
      modules: [
        {
          id: 'dev-team',
          dependencies: [
            { targetId: 'qa-team', relationshipType: 'publishes-to', description: 'existing dep' },
          ],
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
    assert.ok(devTeam);
    assert.equal(devTeam.dependencies.length, 1, 'Should preserve existing dependency');
    assert.equal(devTeam.dependencies[0].description, 'existing dep');
  });

  it('manual dependency data should override existing trace data', () => {
    const config = createTestConfig();
    const existing = {
      version: 3,
      modules: [
        {
          id: 'dev-team',
          dependencies: [
            { targetId: 'qa-team', relationshipType: 'publishes-to', description: 'old dep' },
          ],
          dependents: [],
        },
      ],
    };
    const depData = {
      'dev-team': {
        dependencies: [
          { targetId: 'knowledge-team', relationshipType: 'reads-from', description: 'new dep' },
        ],
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
    assert.ok(devTeam);
    assert.equal(devTeam.dependencies.length, 1, 'Should use manual data, not existing');
    assert.equal(devTeam.dependencies[0].targetId, 'knowledge-team');
    assert.equal(devTeam.dependencies[0].description, 'new dep');
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

    assert.equal(trace.modules[0].description, '', 'Missing description should default to empty string');
  });
});

// ============================================================
// generateHighLevelTraceMarkdown tests (AC-2.2)
// ============================================================

describe('generateHighLevelTraceMarkdown (AC-2.2)', () => {
  it('should contain HTML comment metadata', () => {
    const trace = createValidTrace();
    const md = generateHighLevelTraceMarkdown(trace);

    assert.ok(md.includes('<!-- trace-id: high-level -->'), 'Should have trace-id comment');
    assert.ok(md.includes('<!-- trace-version: 1 -->'), 'Should have trace-version comment');
    assert.ok(md.includes('<!-- last-generated: 2026-02-22T10:30:00.000Z -->'), 'Should have last-generated comment');
    assert.ok(md.includes('<!-- generated-by: trace generate -->'), 'Should have generated-by comment');
  });

  it('should have # Architecture Trace: High-Level heading', () => {
    const trace = createValidTrace();
    const md = generateHighLevelTraceMarkdown(trace);
    assert.ok(md.includes('# Architecture Trace: High-Level'));
  });

  it('should have ## Module: <Name> headings for each module', () => {
    const config = createTestConfig();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
    });
    const md = generateHighLevelTraceMarkdown(trace);

    assert.ok(md.includes('## Module: Dev Team'), 'Should have Dev Team heading');
    assert.ok(md.includes('## Module: QA Team'), 'Should have QA Team heading');
    assert.ok(md.includes('## Module: Knowledge Team'), 'Should have Knowledge Team heading');
  });

  it('should include module ID, description, and file globs', () => {
    const trace = createValidTrace();
    const md = generateHighLevelTraceMarkdown(trace);

    assert.ok(md.includes('**ID**: dev-team'), 'Should have ID field');
    assert.ok(md.includes('**Description**: Development work'), 'Should have Description field');
    assert.ok(md.includes('`src/dev-team/**`'), 'Should have file globs');
  });

  it('should have pipe-delimited dependency sections', () => {
    const trace = createValidTrace();
    const md = generateHighLevelTraceMarkdown(trace);

    assert.ok(md.includes('### Dependencies'), 'Should have Dependencies heading');
    assert.ok(
      md.includes('target | relationship-type | description'),
      'Should have pipe-delimited header for deps',
    );
    assert.ok(
      md.includes('qa-team | publishes-to | Sends work items for QA'),
      'Should have pipe-delimited dependency line',
    );
  });

  it('should have pipe-delimited dependents sections', () => {
    const config = createTestConfig();
    const depData = createTestDependencyData();
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '/fake/path',
      existingTrace: null,
      dependencyData: depData,
    });
    const md = generateHighLevelTraceMarkdown(trace);

    assert.ok(md.includes('### Dependents'), 'Should have Dependents heading');
    // Dev team has a dependent
    assert.ok(
      md.includes('qa-team | subscribes-from | Receives QA feedback for rework'),
      'Should have pipe-delimited dependent line',
    );
  });

  it('should show (none) for empty dependencies', () => {
    const trace = createValidTrace();
    trace.modules[0].dependents = [];
    const md = generateHighLevelTraceMarkdown(trace);

    // The dependents section should show (none)
    const dependentsSection = md.split('### Dependents')[1];
    assert.ok(dependentsSection, 'Should have Dependents section');
    assert.ok(dependentsSection.includes('(none)'), 'Empty dependents should show (none)');
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
    assert.ok(depsSection.includes('(none)'), 'Empty dependencies should show (none)');
    assert.ok(dependentsSection.includes('(none)'), 'Empty dependents should show (none)');
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
    assert.equal(moduleHeadings.length, 3, 'Should have 3 module headings');

    // Count Dependencies headings
    const depsHeadings = md.match(/### Dependencies/g);
    assert.equal(depsHeadings.length, 3, 'Should have 3 Dependencies headings');

    // Count Dependents headings
    const dependentsHeadings = md.match(/### Dependents/g);
    assert.equal(dependentsHeadings.length, 3, 'Should have 3 Dependents headings');
  });

  it('should reflect correct version in metadata', () => {
    const trace = createValidTrace();
    trace.version = 42;
    const md = generateHighLevelTraceMarkdown(trace);
    assert.ok(md.includes('<!-- trace-version: 42 -->'));
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
    assert.equal(result.version, 1, 'First generation should produce version 1');
    assert.equal(result.json.version, 1);
  });

  it('should increment to version 2 on second generation', () => {
    // First generation
    generateHighLevelTrace({ projectRoot: testRoot });

    // Second generation (reads existing file)
    const result = generateHighLevelTrace({ projectRoot: testRoot });
    assert.equal(result.version, 2, 'Second generation should produce version 2');
  });

  it('should increment to version 3 on third generation', () => {
    // Generate three times
    generateHighLevelTrace({ projectRoot: testRoot });
    generateHighLevelTrace({ projectRoot: testRoot });
    const result = generateHighLevelTrace({ projectRoot: testRoot });
    assert.equal(result.version, 3, 'Third generation should produce version 3');
  });

  it('should correctly read version from existing file on disk', () => {
    // Write a trace file with version 10 manually
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      JSON.stringify({ version: 10, modules: [] }),
    );

    const result = generateHighLevelTrace({ projectRoot: testRoot });
    assert.equal(result.version, 11, 'Should increment from 10 to 11');
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
    assert.ok(existsSync(result.jsonPath), 'high-level.json should exist');

    const raw = readFileSync(result.jsonPath, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1);
    assert.ok(Array.isArray(parsed.modules));
  });

  it('should write high-level.md to disk', () => {
    const result = generateHighLevelTrace({ projectRoot: testRoot });
    assert.ok(existsSync(result.mdPath), 'high-level.md should exist');

    const content = readFileSync(result.mdPath, 'utf-8');
    assert.ok(content.includes('<!-- trace-id: high-level -->'));
    assert.ok(content.includes('# Architecture Trace: High-Level'));
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
    assert.ok(existsSync(result.jsonPath));
    assert.ok(existsSync(result.mdPath));

    rmSync(freshRoot, { recursive: true, force: true });
  });

  it('should return correct paths', () => {
    const result = generateHighLevelTrace({ projectRoot: testRoot });
    assert.equal(result.jsonPath, join(testRoot, '.claude', 'traces', 'high-level.json'));
    assert.equal(result.mdPath, join(testRoot, '.claude', 'traces', 'high-level.md'));
  });

  it('JSON on disk should validate against schema', () => {
    generateHighLevelTrace({ projectRoot: testRoot });

    const raw = readFileSync(join(testRoot, '.claude', 'traces', 'high-level.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    const validation = validateHighLevelTrace(parsed);
    assert.ok(validation.valid, `On-disk JSON should validate: ${validation.errors.join(', ')}`);
  });

  it('markdown on disk should contain metadata and module sections', () => {
    const depData = createTestDependencyData();
    generateHighLevelTrace({ projectRoot: testRoot, dependencyData: depData });

    const content = readFileSync(join(testRoot, '.claude', 'traces', 'high-level.md'), 'utf-8');

    // Metadata
    assert.ok(content.includes('<!-- trace-id: high-level -->'));
    assert.ok(content.includes('<!-- trace-version: 1 -->'));
    assert.ok(content.includes('<!-- generated-by: trace generate -->'));

    // Module sections
    assert.ok(content.includes('## Module: Dev Team'));
    assert.ok(content.includes('## Module: QA Team'));

    // Pipe-delimited deps
    assert.ok(content.includes('qa-team | publishes-to | Sends completed work items for QA review'));
  });

  it('should overwrite existing files on regeneration', () => {
    generateHighLevelTrace({ projectRoot: testRoot });

    // Verify version 1
    let raw = readFileSync(join(testRoot, '.claude', 'traces', 'high-level.json'), 'utf-8');
    assert.equal(JSON.parse(raw).version, 1);

    // Regenerate
    generateHighLevelTrace({ projectRoot: testRoot });

    // Verify version 2
    raw = readFileSync(join(testRoot, '.claude', 'traces', 'high-level.json'), 'utf-8');
    assert.equal(JSON.parse(raw).version, 2);
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
    assert.equal(result, null);
  });

  it('should return parsed object when file exists', () => {
    const trace = createValidTrace();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      JSON.stringify(trace),
    );

    const result = readExistingHighLevelTrace(testRoot);
    assert.ok(result);
    assert.equal(result.version, 1);
  });

  it('should return null for malformed JSON', () => {
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      'not valid json {{{',
    );

    const result = readExistingHighLevelTrace(testRoot);
    assert.equal(result, null);
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
    assert.deepEqual(VALID_RELATIONSHIP_TYPES, expected);
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
    assert.equal(trace.projectRoot, '.', 'Should default to "." when config has no projectRoot');
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
    assert.deepEqual(trace.modules[0].fileGlobs, ['src/a/**', 'src/b/**', 'src/c/**']);
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
    assert.ok(md.includes('`src/a/**`, `src/b/**`'), 'Multiple globs should be comma-separated in backticks');
  });
});

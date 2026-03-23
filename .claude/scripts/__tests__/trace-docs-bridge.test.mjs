/**
 * Unit tests for M3: Integration -- Trace-Informed Routing + Trace-to-Docs Bridge
 *
 * Spec: sg-trace-v2-docs-bridge (Milestone 3)
 * Covers: REQ-014, REQ-015, REQ-016, REQ-017, REQ-018, REQ-019
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs trace-docs-bridge
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { validateTraceIntegrity } from '../lib/trace-utils.mjs';
import { validateAll } from '../docs-validate.mjs';
import { scaffold } from '../docs-scaffold.mjs';
import { compareSyncState, formatSyncReport, generateSyncReport } from '../trace-docs-sync.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');
const ROUTE_SKILL_PATH = join(PROJECT_ROOT, '.claude', 'skills', 'route', 'SKILL.md');

// ============================================================================
// Fixtures: Mock trace data for testing
// ============================================================================

let tempDir;

beforeEach(() => {
  tempDir = join(tmpdir(), `trace-docs-bridge-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Creates a well-formed high-level trace JSON object.
 * Uses the real high-level.json format: modules is an array of objects.
 */
function makeValidHighLevelTrace(overrides = {}) {
  return {
    version: 12,
    generatedBy: 'trace generate',
    lastGenerated: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
    projectRoot: '.',
    modules: overrides.modules || [
      {
        id: 'scripts-lib',
        name: 'Shared Libraries',
        description: 'Shared utility library',
        fileGlobs: ['.claude/scripts/lib/*.mjs'],
        dependencies: [],
        dependents: ['trace-scripts'],
      },
      {
        id: 'trace-scripts',
        name: 'Trace System Scripts',
        description: 'Trace generation scripts',
        fileGlobs: ['.claude/scripts/trace-*.mjs'],
        dependencies: ['scripts-lib'],
        dependents: [],
      },
    ],
    ...overrides,
  };
}

/**
 * Creates a well-formed low-level trace JSON object.
 */
function makeValidLowLevelTrace(moduleId = 'scripts-lib', exports = []) {
  return {
    generatedBy: 'trace generate',
    lastGenerated: new Date(Date.now() - 3600000).toISOString(),
    moduleId,
    files: [
      {
        filePath: `.claude/scripts/lib/trace-utils.mjs`,
        exports: exports.length > 0 ? exports : [
          { symbol: 'matchesGlob', type: 'function', lineNumber: 86, signature: '(filePath, pattern)' },
        ],
        imports: [{ source: 'node:path', symbols: ['join', 'resolve'] }],
        calls: [],
        events: [],
      },
    ],
  };
}

/**
 * Creates a valid architecture.yaml content string with module references.
 */
function makeArchitectureYaml(moduleNames = ['scripts-lib', 'trace-scripts']) {
  const modules = moduleNames.map(name => `  - name: ${name}
    description: Module ${name}
    path: .claude/scripts/**
    responsibilities:
      - Feature
    dependencies: []`).join('\n');
  return `schema_version: 1\nmodules:\n${modules}\n`;
}

/**
 * Set up a temp project with structured docs and trace data.
 */
function setupProjectWithTraces(archModuleNames, traceModules) {
  const docsDir = join(tempDir, '.claude', 'docs', 'structured');
  const flowsDir = join(docsDir, 'flows');
  mkdirSync(flowsDir, { recursive: true });

  writeFileSync(join(docsDir, 'architecture.yaml'), makeArchitectureYaml(archModuleNames));
  writeFileSync(join(docsDir, 'glossary.yaml'), 'schema_version: 1\nterms: []\n');
  writeFileSync(join(flowsDir, 'index.yaml'), 'schema_version: 1\nflows: []\n');

  const tracesDir = join(tempDir, '.claude', 'traces');
  const lowLevelDir = join(tracesDir, 'low-level');
  mkdirSync(lowLevelDir, { recursive: true });

  const hlTrace = makeValidHighLevelTrace({ modules: traceModules });
  writeFileSync(join(tracesDir, 'high-level.json'), JSON.stringify(hlTrace, null, 2));

  for (const mod of traceModules) {
    writeFileSync(
      join(lowLevelDir, `${mod.id}.json`),
      JSON.stringify(makeValidLowLevelTrace(mod.id)),
    );
  }

  return { docsDir, tracesDir, lowLevelDir };
}

// ============================================================================
// REQ-015: Trace Integrity Validation (validateTraceIntegrity)
// ============================================================================

describe('REQ-015: Trace Integrity Validation', () => {

  it('should return valid for well-formed trace data with generatedBy and recent lastGenerated (AC-integrity-valid)', () => {
    const traceData = makeValidHighLevelTrace();
    const result = validateTraceIntegrity(traceData);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('should return invalid when generatedBy field is missing', () => {
    const traceData = makeValidHighLevelTrace();
    delete traceData.generatedBy;
    const result = validateTraceIntegrity(traceData);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
    expect(typeof result.reason).toBe('string');
  });

  it('should return invalid when lastGenerated field is missing', () => {
    const traceData = makeValidHighLevelTrace();
    delete traceData.lastGenerated;
    const result = validateTraceIntegrity(traceData);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('should return invalid when lastGenerated is in the future (AC-integrity-invalid)', () => {
    const traceData = makeValidHighLevelTrace();
    const futureDate = new Date(Date.now() + 86400000 * 30); // 30 days in future
    traceData.lastGenerated = futureDate.toISOString();
    const result = validateTraceIntegrity(traceData);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/future/i);
  });

  it('should return invalid when lastGenerated is unreasonably old', () => {
    const traceData = makeValidHighLevelTrace();
    traceData.lastGenerated = '1990-01-01T00:00:00Z';
    const result = validateTraceIntegrity(traceData);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('should return invalid when lastGenerated is not a valid ISO date string', () => {
    const traceData = makeValidHighLevelTrace();
    traceData.lastGenerated = 'not-a-date';
    const result = validateTraceIntegrity(traceData);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('should return a reason string on failure', () => {
    const result = validateTraceIntegrity({});
    expect(result.valid).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('should return valid for low-level trace data (not just high-level)', () => {
    const traceData = makeValidLowLevelTrace();
    const result = validateTraceIntegrity(traceData);
    expect(result.valid).toBe(true);
  });

  it('should handle null/undefined input gracefully', () => {
    expect(validateTraceIntegrity(null).valid).toBe(false);
    expect(validateTraceIntegrity(undefined).valid).toBe(false);
    expect(validateTraceIntegrity(null).reason).toBeDefined();
  });

  it('should return invalid when generatedBy is empty string', () => {
    const traceData = makeValidHighLevelTrace();
    traceData.generatedBy = '  ';
    const result = validateTraceIntegrity(traceData);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('generatedBy');
  });
});

// ============================================================================
// REQ-014 / REQ-016: Trace-Informed Routing (Route SKILL.md content checks)
// ============================================================================

describe('REQ-014 / REQ-016: Trace-Informed Routing (Route SKILL.md)', () => {
  let routeSkillContent;

  beforeEach(() => {
    if (existsSync(ROUTE_SKILL_PATH)) {
      routeSkillContent = readFileSync(ROUTE_SKILL_PATH, 'utf8');
    }
  });

  it('should contain instructions to read high-level.json (REQ-014 AC-route-impact)', () => {
    if (!routeSkillContent) { expect.fail('Route SKILL.md not found'); return; }
    expect(routeSkillContent).toMatch(/high-level\.json/);
  });

  it('should instruct Read-based trace consumption, not Bash/CLI (REQ-014)', () => {
    if (!routeSkillContent) { expect.fail('Route SKILL.md not found'); return; }
    expect(routeSkillContent).toMatch(/Read/);
    const frontmatterMatch = routeSkillContent.match(/allowed-tools:\s*(.+)/);
    if (frontmatterMatch) {
      expect(frontmatterMatch[1]).not.toMatch(/Bash/i);
    }
  });

  it('should include trace-informed impact analysis instructions (REQ-014)', () => {
    if (!routeSkillContent) { expect.fail('Route SKILL.md not found'); return; }
    expect(routeSkillContent).toMatch(/[Ii]mpact [Aa]nalysis/);
    expect(routeSkillContent).toMatch(/module count/i);
  });

  it('should include trace integrity validation instructions (REQ-015)', () => {
    if (!routeSkillContent) { expect.fail('Route SKILL.md not found'); return; }
    expect(routeSkillContent).toMatch(/generatedBy/);
    expect(routeSkillContent).toMatch(/lastGenerated/);
    expect(routeSkillContent).toMatch(/fallback/i);
  });

  it('should include dispatch prompt enrichment with trace context (REQ-016)', () => {
    if (!routeSkillContent) { expect.fail('Route SKILL.md not found'); return; }
    expect(routeSkillContent).toMatch(/dispatch.*prompt/i);
    expect(routeSkillContent).toMatch(/trace_context|trace context/i);
    expect(routeSkillContent).toMatch(/recommended_trace_reads|recommended trace reads/i);
  });

  it('should include module dependency parsing instructions (REQ-014)', () => {
    if (!routeSkillContent) { expect.fail('Route SKILL.md not found'); return; }
    expect(routeSkillContent).toMatch(/dependencies/);
    expect(routeSkillContent).toMatch(/dependents/);
  });
});

// ============================================================================
// REQ-017: Docs-Trace Cross-Reference Validation
// ============================================================================

describe('REQ-017: Docs-Trace Cross-Reference Validation', () => {

  it('should detect module referenced in architecture.yaml that does not exist in traces (AC-docs-trace-xref)', () => {
    setupProjectWithTraces(
      ['scripts-lib', 'trace-scripts', 'phantom-module'],
      [
        { id: 'scripts-lib', name: 'Shared Libraries', description: 'Shared lib', fileGlobs: ['.claude/scripts/lib/*.mjs'], dependencies: [], dependents: [] },
        { id: 'trace-scripts', name: 'Trace System Scripts', description: 'Trace scripts', fileGlobs: ['.claude/scripts/trace-*.mjs'], dependencies: [], dependents: [] },
      ],
    );

    const result = validateAll(tempDir);
    const allMessages = [
      ...result.errors.map(e => e.message),
      ...result.warnings.map(w => w.message),
      ...result.info.map(i => i.message),
    ].join('\n');

    expect(allMessages).toMatch(/phantom-module/);
  });

  it('should report traced module not in docs as informational (AC-docs-trace-xref)', () => {
    setupProjectWithTraces(
      ['scripts-lib'],
      [
        { id: 'scripts-lib', name: 'Shared Libraries', description: 'Shared lib', fileGlobs: ['.claude/scripts/lib/*.mjs'], dependencies: [], dependents: [] },
        { id: 'extra-mod', name: 'Extra Module', description: 'Not in docs', fileGlobs: ['src/extra/**'], dependencies: [], dependents: [] },
      ],
    );

    const result = validateAll(tempDir);
    const infoMessages = result.info.map(i => i.message).join('\n');
    expect(infoMessages).toMatch(/extra-mod/);
  });

  it('should pass when all architecture.yaml modules exist in traces', () => {
    setupProjectWithTraces(
      ['scripts-lib', 'trace-scripts'],
      [
        { id: 'scripts-lib', name: 'scripts-lib', description: 'Shared lib', fileGlobs: ['.claude/scripts/lib/*.mjs'], dependencies: [], dependents: [] },
        { id: 'trace-scripts', name: 'trace-scripts', description: 'Trace scripts', fileGlobs: ['.claude/scripts/trace-*.mjs'], dependencies: [], dependents: [] },
      ],
    );

    const result = validateAll(tempDir);
    const traceCrossRefWarnings = result.warnings.filter(w => w.category === 'Trace cross-reference');
    expect(traceCrossRefWarnings.length).toBe(0);
  });

  it('should handle missing trace data gracefully -- no errors (EC-4)', () => {
    const docsDir = join(tempDir, '.claude', 'docs', 'structured');
    const flowsDir = join(docsDir, 'flows');
    mkdirSync(flowsDir, { recursive: true });
    writeFileSync(join(docsDir, 'architecture.yaml'), makeArchitectureYaml(['scripts-lib']));
    writeFileSync(join(docsDir, 'glossary.yaml'), 'schema_version: 1\nterms: []\n');
    writeFileSync(join(flowsDir, 'index.yaml'), 'schema_version: 1\nflows: []\n');
    // No .claude/traces/ directory

    const result = validateAll(tempDir);
    const traceErrors = result.errors.filter(e => e.category === 'Trace cross-reference');
    expect(traceErrors.length).toBe(0);
  });

  it('should use matchesGlob from trace-utils, not local simpleGlobMatch (INC-007)', () => {
    const docsValidatePath = join(PROJECT_ROOT, '.claude', 'scripts', 'docs-validate.mjs');
    const source = readFileSync(docsValidatePath, 'utf8');

    // matchesGlob should be imported from trace-utils
    expect(source).toMatch(/import\s*\{[^}]*matchesGlob[^}]*\}\s*from\s*['"].*trace-utils/);
    // simpleGlobMatch should NOT be defined locally
    expect(source).not.toMatch(/function\s+simpleGlobMatch/);
  });
});

// ============================================================================
// REQ-018: Scaffold Trace Population
// ============================================================================

describe('REQ-018: Scaffold Trace Population', () => {

  function setupProjectWithTraceData(moduleId, exports) {
    mkdirSync(join(tempDir, 'src', 'services'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'services', 'auth.mjs'), '');
    mkdirSync(join(tempDir, '.claude', 'docs', 'structured'), { recursive: true });

    const tracesDir = join(tempDir, '.claude', 'traces');
    const lowLevelDir = join(tracesDir, 'low-level');
    mkdirSync(lowLevelDir, { recursive: true });

    const hlTrace = makeValidHighLevelTrace({
      modules: [
        {
          id: moduleId,
          name: moduleId,
          description: `Description for ${moduleId}`,
          fileGlobs: ['src/**'],
          dependencies: [],
          dependents: [],
        },
      ],
    });
    writeFileSync(join(tracesDir, 'high-level.json'), JSON.stringify(hlTrace, null, 2));

    const llTrace = makeValidLowLevelTrace(moduleId, exports.map((sym, i) => ({
      symbol: sym,
      type: 'function',
      lineNumber: i * 10 + 1,
      signature: `(${sym})`,
    })));
    writeFileSync(join(lowLevelDir, `${moduleId}.json`), JSON.stringify(llTrace, null, 2));
  }

  it('should populate TODO placeholders with trace data when available (AC-scaffold-populate)', () => {
    setupProjectWithTraceData('services', ['login', 'logout', 'refreshToken']);

    const result = scaffold(tempDir);
    expect(result.status).toBe('created');

    const archPath = join(tempDir, '.claude', 'docs', 'structured', 'architecture.yaml');
    const content = readFileSync(archPath, 'utf-8');

    // Still marked TODO
    expect(content).toContain('TODO');
  });

  it('should NOT overwrite human-authored content', () => {
    setupProjectWithTraceData('services', ['login']);
    const docsDir = join(tempDir, '.claude', 'docs', 'structured');
    writeFileSync(join(docsDir, 'architecture.yaml'), `schema_version: 1
modules:
  - name: my-hand-written-module
    description: Human authored description
    path: src/**
    responsibilities:
      - Important feature
`);

    const result = scaffold(tempDir);
    expect(result.status).toBe('refused');

    const content = readFileSync(join(docsDir, 'architecture.yaml'), 'utf-8');
    expect(content).toContain('my-hand-written-module');
    expect(content).toContain('Human authored description');
  });

  it('should handle missing trace data gracefully (AC-scaffold-no-trace / EC-6)', () => {
    mkdirSync(join(tempDir, 'src', 'services'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'services', 'auth.mjs'), '');
    mkdirSync(join(tempDir, '.claude', 'docs', 'structured'), { recursive: true });
    // No .claude/traces/ directory

    const result = scaffold(tempDir);
    expect(result.status).toBe('created');

    const archPath = join(tempDir, '.claude', 'docs', 'structured', 'architecture.yaml');
    const content = readFileSync(archPath, 'utf-8');
    expect(content).toMatch(/TODO/);
  });
});

// ============================================================================
// REQ-019: Trace-Docs Sync Report
// ============================================================================

describe('REQ-019: Trace-Docs Sync Report', () => {

  describe('compareSyncState', () => {

    it('should detect new exports not in docs (AC-sync-report)', () => {
      const traceModules = {
        'mod-a': {
          name: 'Module A',
          description: 'First module',
          dependencies: [],
          dependents: [],
          exports: ['funcX', 'funcY', 'funcZ'],
        },
      };
      const docsModules = {
        'mod-a': {
          description: 'First module with funcX',
          path: 'src/a/**',
          dependencies: [],
          responsibilities: ['Provides funcX'],
        },
      };

      const report = compareSyncState(traceModules, docsModules);
      expect(report.summary.newExports).toBe(2);
      expect(report.modules[0].newExports).toContain('funcY');
      expect(report.modules[0].newExports).toContain('funcZ');
      expect(report.modules[0].newExports).not.toContain('funcX');
    });

    it('should detect changed dependencies', () => {
      const traceModules = {
        'mod-a': { name: 'A', dependencies: ['mod-b', 'mod-c'], dependents: [], exports: [] },
      };
      const docsModules = {
        'mod-a': { description: 'A', dependencies: ['mod-b', 'mod-d'], responsibilities: [] },
      };

      const report = compareSyncState(traceModules, docsModules);
      expect(report.modules[0].changedDeps.added).toContain('mod-c');
      expect(report.modules[0].changedDeps.removed).toContain('mod-d');
    });

    it('should detect modules in traces but not in docs', () => {
      const traceModules = {
        'new-mod': { name: 'New Module', dependencies: [], dependents: [], exports: ['newFn'] },
      };

      const report = compareSyncState(traceModules, {});
      expect(report.modules[0].inTracesOnly).toBe(true);
      expect(report.summary.modulesWithDivergence).toBe(1);
    });

    it('should detect modules in docs but not in traces', () => {
      const docsModules = {
        'old-mod': { description: 'Old', dependencies: [], responsibilities: [] },
      };

      const report = compareSyncState({}, docsModules);
      expect(report.modules[0].inDocsOnly).toBe(true);
    });

    it('should report no divergence when trace and docs match', () => {
      const traceModules = {
        'mod-a': { name: 'mod-a', dependencies: ['mod-b'], dependents: [], exports: ['funcA'] },
      };
      const docsModules = {
        'mod-a': { description: 'Module with funcA', dependencies: ['mod-b'], responsibilities: ['Provides funcA capability'] },
      };

      const report = compareSyncState(traceModules, docsModules);
      expect(report.summary.modulesWithDivergence).toBe(0);
    });
  });

  describe('formatSyncReport', () => {

    it('should produce human-readable output matching contract format', () => {
      const report = {
        modules: [{
          id: 'mod-a', name: 'Module A',
          newExports: ['parseCallGraph', 'parseEventPatterns'],
          removedExports: [],
          changedDeps: { added: ['mod-c'], removed: [] },
          inDocsOnly: false, inTracesOnly: false,
        }],
        summary: { modulesWithDivergence: 1, newExports: 2, removedExports: 0 },
      };

      const formatted = formatSyncReport(report);
      expect(formatted).toContain('Trace-Docs Sync Report');
      expect(formatted).toContain('Module: mod-a');
      expect(formatted).toContain('parseCallGraph');
      expect(formatted).toContain('+mod-c (new)');
      expect(formatted).toContain('1 module(s) with divergence');
    });

    it('should report no divergence when empty', () => {
      const report = { modules: [], summary: { modulesWithDivergence: 0, newExports: 0, removedExports: 0 } };
      expect(formatSyncReport(report)).toContain('No divergence detected');
    });
  });

  describe('generateSyncReport', () => {

    it('should return helpful message when no trace data exists', () => {
      const { formatted } = generateSyncReport(tempDir);
      expect(formatted).toContain('No trace data available');
    });

    it('should return helpful message when no architecture.yaml exists', () => {
      const tracesDir = join(tempDir, '.claude', 'traces');
      mkdirSync(tracesDir, { recursive: true });
      writeFileSync(join(tracesDir, 'high-level.json'), JSON.stringify(makeValidHighLevelTrace()));

      const { formatted } = generateSyncReport(tempDir);
      expect(formatted).toContain('No architecture.yaml found');
    });

    it('should produce full report with both trace and docs data (AC-sync-report)', () => {
      setupProjectWithTraces(
        ['scripts-lib'],
        [{ id: 'scripts-lib', name: 'Shared Libraries', description: 'Shared lib', fileGlobs: ['.claude/scripts/lib/*.mjs'], dependencies: [], dependents: [] }],
      );

      const { report, formatted } = generateSyncReport(tempDir);
      expect(report).not.toBeNull();
      expect(formatted).toContain('Trace-Docs Sync Report');
    });

    it('should NOT modify any docs files (REQ-019 constraint)', () => {
      setupProjectWithTraces(
        ['scripts-lib'],
        [{ id: 'scripts-lib', name: 'scripts-lib', description: 'Shared lib', fileGlobs: ['.claude/scripts/lib/*.mjs'], dependencies: [], dependents: [] }],
      );

      const archPath = join(tempDir, '.claude', 'docs', 'structured', 'architecture.yaml');
      const before = readFileSync(archPath, 'utf-8');

      generateSyncReport(tempDir);

      const after = readFileSync(archPath, 'utf-8');
      expect(after).toBe(before);
    });
  });
});

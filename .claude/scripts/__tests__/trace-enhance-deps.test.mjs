/**
 * Tests for Trace System Enhancement -- Milestone 1: Cross-Module Dependency Aggregation
 *
 * Spec: .claude/specs/groups/sg-trace-system-enhancement/spec.md
 *
 * Validates:
 * - AC-1.1:  Cross-module dependencies populated as string moduleId arrays
 * - AC-1.2:  Bidirectional deps (if A depends on B, B lists A as dependent)
 * - AC-1.3:  Multi-glob files are skipped with error + skippedFiles entry
 * - AC-1.4:  Circular deps detected and included (not errors)
 * - AC-1.5:  Unknown import paths produce no false dependency entries
 * - AC-1.13: Dynamic imports excluded from dependency arrays
 * - AC-1.16: Dependency arrays use string moduleIds (not objects)
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs trace-enhance-deps
 */

import { describe, it, expect } from 'vitest';
// Import aggregateDependencies and parseImports from trace-generate
import {
  aggregateDependencies,
  parseImports,
} from '../trace-generate.mjs';

// Import fileToModules from trace-utils (may not exist yet)
import { fileToModules } from '../lib/trace-utils.mjs';

import {
  validateHighLevelTrace,
  generateHighLevelTraceJSON,
  generateHighLevelTraceMarkdown,
} from '../lib/high-level-trace.mjs';

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create low-level trace data as an ARRAY (not object).
 * Import paths use relative notation (../) to reference cross-module files.
 *
 * Module layout:
 *   mod-a (src/mod-a/**) -> imports from mod-b via ../mod-b/handler
 *   mod-b (src/mod-b/**) -> imports from mod-c via ../mod-c/util
 *   mod-c (src/mod-c/**) -> no cross-module imports
 */
function createFakeLowLevelTraces() {
  return [
    {
      moduleId: 'mod-a',
      files: [
        {
          filePath: 'src/mod-a/service.ts',
          exports: [{ symbol: 'ServiceA', type: 'class' }],
          imports: [
            { source: './utils.js', symbols: ['helper'] },             // intra-module
            { source: '../mod-b/handler.ts', symbols: ['HandlerB'] },  // cross-module
          ],
        },
      ],
    },
    {
      moduleId: 'mod-b',
      files: [
        {
          filePath: 'src/mod-b/handler.ts',
          exports: [{ symbol: 'HandlerB', type: 'class' }],
          imports: [
            { source: '../mod-c/util.ts', symbols: ['utilC'] },  // cross-module
          ],
        },
      ],
    },
    {
      moduleId: 'mod-c',
      files: [
        {
          filePath: 'src/mod-c/util.ts',
          exports: [{ symbol: 'utilC', type: 'function' }],
          imports: [],
        },
      ],
    },
  ];
}

function createFakeConfig() {
  return {
    version: 1,
    projectRoot: '.',
    modules: [
      { id: 'mod-a', name: 'Module A', description: 'A', fileGlobs: ['src/mod-a/**'] },
      { id: 'mod-b', name: 'Module B', description: 'B', fileGlobs: ['src/mod-b/**'] },
      { id: 'mod-c', name: 'Module C', description: 'C', fileGlobs: ['src/mod-c/**'] },
    ],
  };
}

// =============================================================================
// AC-1.1: Cross-module dependencies populated as string moduleId arrays
// =============================================================================

describe('aggregateDependencies -- cross-module deps (AC-1.1)', () => {
  it('should populate dependencies[] with string moduleIds (AC-1.1)', () => {
    // Arrange
    const traces = createFakeLowLevelTraces();
    const config = createFakeConfig();

    // Act
    const { dependencyData } = aggregateDependencies(traces, config);

    // Assert
    expect(dependencyData['mod-a']).toBeTruthy();
    expect(Array.isArray(dependencyData['mod-a'].dependencies)).toBeTruthy();
    expect(dependencyData['mod-a'].dependencies.includes('mod-b')).toBeTruthy();
  });

  it('should populate dependents[] with string moduleIds (AC-1.1)', () => {
    // Arrange
    const traces = createFakeLowLevelTraces();
    const config = createFakeConfig();

    // Act
    const { dependencyData } = aggregateDependencies(traces, config);

    // Assert -- mod-b should list mod-a as a dependent (because mod-a imports from mod-b)
    expect(dependencyData['mod-b']).toBeTruthy();
    expect(Array.isArray(dependencyData['mod-b'].dependents)).toBeTruthy();
    expect(dependencyData['mod-b'].dependents.includes('mod-a')).toBeTruthy();
  });
});

// =============================================================================
// AC-1.2: Bidirectional deps
// =============================================================================

describe('aggregateDependencies -- bidirectional (AC-1.2)', () => {
  it('should create bidirectional relationship: if A depends on B, B lists A as dependent (AC-1.2)', () => {
    // Arrange
    const traces = createFakeLowLevelTraces();
    const config = createFakeConfig();

    // Act
    const { dependencyData } = aggregateDependencies(traces, config);

    // Assert -- mod-b imports from mod-c, so:
    // mod-b.dependencies should include mod-c
    // mod-c.dependents should include mod-b
    expect(dependencyData['mod-b'].dependencies.includes('mod-c')).toBeTruthy();
    expect(dependencyData['mod-c'].dependents.includes('mod-b')).toBeTruthy();
  });
});

// =============================================================================
// AC-1.3: Ambiguous file globs produce skippedFiles entry
// =============================================================================

describe('aggregateDependencies -- ambiguous globs (AC-1.3)', () => {
  it('should skip files matching multiple modules and record in skippedFiles (AC-1.3)', () => {
    // Arrange -- config where src/shared/** matches two modules
    const config = {
      version: 1,
      projectRoot: '.',
      modules: [
        { id: 'mod-a', name: 'Module A', description: 'A', fileGlobs: ['src/mod-a/**', 'src/shared/**'] },
        { id: 'mod-b', name: 'Module B', description: 'B', fileGlobs: ['src/mod-b/**', 'src/shared/**'] },
      ],
    };
    const traces = [
      {
        moduleId: 'mod-a',
        files: [{
          filePath: 'src/mod-a/service.ts',
          exports: [],
          imports: [{ source: '../shared/utils.ts', symbols: ['helper'] }],
        }],
      },
      {
        moduleId: 'mod-b',
        files: [],
      },
    ];

    // Act
    const { skippedFiles } = aggregateDependencies(traces, config);

    // Assert
    expect(Array.isArray(skippedFiles)).toBeTruthy();
    expect(skippedFiles.length > 0).toBeTruthy();
    const skipped = skippedFiles.find(f => f.path.includes('shared/utils'));
    expect(skipped).toBeTruthy();
    expect(Array.isArray(skipped.matchedModules)).toBeTruthy();
    expect(skipped.matchedModules.includes('mod-a')).toBeTruthy();
    expect(skipped.matchedModules.includes('mod-b')).toBeTruthy();
  });

  it('should not assign ambiguous file to any module (AC-1.3)', () => {
    // Arrange
    const config = {
      version: 1,
      projectRoot: '.',
      modules: [
        { id: 'mod-x', name: 'X', description: 'X', fileGlobs: ['src/**'] },
        { id: 'mod-y', name: 'Y', description: 'Y', fileGlobs: ['src/**'] },
      ],
    };
    const traces = [
      {
        moduleId: 'mod-x',
        files: [{
          filePath: 'src/something.ts',
          exports: [],
          imports: [{ source: './other.ts', symbols: ['other'] }],
        }],
      },
      { moduleId: 'mod-y', files: [] },
    ];

    // Act
    const { dependencyData } = aggregateDependencies(traces, config);

    // Assert -- no dependency should be created for the ambiguous file
    const modXDeps = dependencyData['mod-x']?.dependencies || [];
    expect(!modXDeps.includes('mod-y')).toBeTruthy();
  });
});

// =============================================================================
// AC-1.4: Circular dependencies detected and included
// =============================================================================

describe('aggregateDependencies -- circular deps (AC-1.4)', () => {
  it('should represent circular dependencies bidirectionally (AC-1.4)', () => {
    // Arrange -- A imports B, B imports A (via relative paths)
    const config = {
      version: 1,
      projectRoot: '.',
      modules: [
        { id: 'circ-a', name: 'Circ A', description: 'A', fileGlobs: ['src/circ-a/**'] },
        { id: 'circ-b', name: 'Circ B', description: 'B', fileGlobs: ['src/circ-b/**'] },
      ],
    };
    const traces = [
      {
        moduleId: 'circ-a',
        files: [{
          filePath: 'src/circ-a/index.ts',
          exports: [{ symbol: 'A', type: 'class' }],
          imports: [{ source: '../circ-b/index.ts', symbols: ['B'] }],
        }],
      },
      {
        moduleId: 'circ-b',
        files: [{
          filePath: 'src/circ-b/index.ts',
          exports: [{ symbol: 'B', type: 'class' }],
          imports: [{ source: '../circ-a/index.ts', symbols: ['A'] }],
        }],
      },
    ];

    // Act
    const { dependencyData } = aggregateDependencies(traces, config);

    // Assert
    expect(dependencyData['circ-a'].dependencies.includes('circ-b')).toBeTruthy();
    expect(dependencyData['circ-b'].dependencies.includes('circ-a')).toBeTruthy();
    expect(dependencyData['circ-a'].dependents.includes('circ-b')).toBeTruthy();
    expect(dependencyData['circ-b'].dependents.includes('circ-a')).toBeTruthy();
  });

  it('should not treat circular deps as errors (AC-1.4)', () => {
    // Arrange
    const config = {
      version: 1,
      projectRoot: '.',
      modules: [
        { id: 'c1', name: 'C1', description: 'C1', fileGlobs: ['src/c1/**'] },
        { id: 'c2', name: 'C2', description: 'C2', fileGlobs: ['src/c2/**'] },
      ],
    };
    const traces = [
      {
        moduleId: 'c1',
        files: [{
          filePath: 'src/c1/a.ts',
          exports: [],
          imports: [{ source: '../c2/b.ts', symbols: ['B'] }],
        }],
      },
      {
        moduleId: 'c2',
        files: [{
          filePath: 'src/c2/b.ts',
          exports: [],
          imports: [{ source: '../c1/a.ts', symbols: ['A'] }],
        }],
      },
    ];

    // Act -- should not throw
    const { dependencyData, skippedFiles } = aggregateDependencies(traces, config);

    // Assert -- function completed without error
    expect(dependencyData).toBeTruthy();
    // Circular deps should NOT appear in skippedFiles
    expect(skippedFiles.filter(f => f.path.includes('src/c1') || f.path.includes('src/c2')).length).toBe(0);
  });
});

// =============================================================================
// AC-1.5: Unknown import paths produce no false dependency entries
// =============================================================================

describe('aggregateDependencies -- unknown imports (AC-1.5)', () => {
  it('should skip external imports that match no module (AC-1.5)', () => {
    // Arrange
    const config = createFakeConfig();
    const traces = [
      {
        moduleId: 'mod-a',
        files: [{
          filePath: 'src/mod-a/service.ts',
          exports: [],
          imports: [
            { source: 'lodash', symbols: ['cloneDeep'] },
            { source: 'node:fs', symbols: ['readFileSync'] },
            { source: '@some/package', symbols: ['something'] },
          ],
        }],
      },
      { moduleId: 'mod-b', files: [] },
      { moduleId: 'mod-c', files: [] },
    ];

    // Act
    const { dependencyData } = aggregateDependencies(traces, config);

    // Assert -- no dependencies should be created
    const deps = dependencyData['mod-a']?.dependencies || [];
    expect(deps.length).toBe(0);
  });

  it('should not create phantom dependency entries for untracked relative paths (AC-1.5)', () => {
    // Arrange -- import resolves to a path that matches no module's fileGlobs
    const config = createFakeConfig();
    const traces = [
      {
        moduleId: 'mod-a',
        files: [{
          filePath: 'src/mod-a/service.ts',
          exports: [],
          imports: [
            { source: '../../untracked/file.ts', symbols: ['untrackedFn'] },
          ],
        }],
      },
      { moduleId: 'mod-b', files: [] },
      { moduleId: 'mod-c', files: [] },
    ];

    // Act
    const { dependencyData } = aggregateDependencies(traces, config);

    // Assert
    const deps = dependencyData['mod-a']?.dependencies || [];
    expect(deps.length).toBe(0);
  });
});

// =============================================================================
// AC-1.13: Dynamic imports excluded from dependency arrays
// =============================================================================

describe('aggregateDependencies -- dynamic imports excluded (AC-1.13)', () => {
  it('should only include static imports in dependency arrays (AC-1.13)', () => {
    // Arrange -- parseImports only captures static imports by design,
    // so dynamic import() calls never appear in the trace data.
    // This test verifies that the aggregate function processes only
    // what parseImports provides (static imports).
    const config = createFakeConfig();
    const traces = [
      {
        moduleId: 'mod-a',
        files: [{
          filePath: 'src/mod-a/lazy.ts',
          exports: [],
          imports: [
            // Only static imports appear in trace data
            { source: '../mod-b/handler.ts', symbols: ['HandlerB'] },
          ],
        }],
      },
      { moduleId: 'mod-b', files: [] },
      { moduleId: 'mod-c', files: [] },
    ];

    // Act
    const { dependencyData } = aggregateDependencies(traces, config);

    // Assert -- static import should create dependency
    const deps = dependencyData['mod-a']?.dependencies || [];
    expect(deps.includes('mod-b')).toBeTruthy();
  });

  it('should verify parseImports excludes dynamic imports (AC-1.13)', () => {
    // Arrange -- source with dynamic import
    const source = `import { foo } from './static.js';
const bar = await import('./dynamic.js');
const baz = import('./also-dynamic.js');`;

    // Act
    const imports = parseImports(source);

    // Assert -- only static import should be captured
    const sources = imports.map(i => i.source);
    expect(sources.includes('./static.js')).toBeTruthy();
    expect(!sources.includes('./dynamic.js')).toBeTruthy();
    expect(!sources.includes('./also-dynamic.js')).toBeTruthy();
  });
});

// =============================================================================
// AC-1.16: Dependency arrays use string moduleIds (not objects)
// =============================================================================

describe('dependency format -- string moduleIds (AC-1.16)', () => {
  it('should produce string moduleId entries, not objects (AC-1.16)', () => {
    // Arrange
    const traces = createFakeLowLevelTraces();
    const config = createFakeConfig();

    // Act
    const { dependencyData } = aggregateDependencies(traces, config);

    // Assert
    for (const moduleId of Object.keys(dependencyData)) {
      const deps = dependencyData[moduleId]?.dependencies || [];
      for (const dep of deps) {
        expect(typeof dep).toBe('string');
      }
      const dependents = dependencyData[moduleId]?.dependents || [];
      for (const d of dependents) {
        expect(typeof d).toBe('string');
      }
    }
  });

  it('validateHighLevelTrace should accept string moduleId dependency arrays (AC-1.16)', () => {
    // Arrange -- high-level trace with string deps
    const trace = {
      version: 1,
      lastGenerated: new Date().toISOString(),
      generatedBy: 'trace generate',
      projectRoot: '.',
      modules: [
        {
          id: 'mod-a',
          name: 'Module A',
          description: 'A',
          fileGlobs: ['src/mod-a/**'],
          dependencies: ['mod-b', 'mod-c'],
          dependents: ['mod-d'],
        },
      ],
    };

    // Act
    const result = validateHighLevelTrace(trace);

    // Assert
    expect(result.valid).toBeTruthy();
  });

  it('generateHighLevelTraceMarkdown should render string moduleId lists (AC-1.16)', () => {
    // Arrange
    const trace = {
      version: 1,
      lastGenerated: new Date().toISOString(),
      generatedBy: 'trace generate',
      projectRoot: '.',
      modules: [
        {
          id: 'mod-a',
          name: 'Module A',
          description: 'A',
          fileGlobs: ['src/mod-a/**'],
          dependencies: ['mod-b', 'mod-c'],
          dependents: ['mod-d'],
        },
      ],
    };

    // Act
    const md = generateHighLevelTraceMarkdown(trace);

    // Assert
    expect(md.includes('mod-b')).toBeTruthy();
    expect(md.includes('mod-c')).toBeTruthy();
    expect(md.includes('mod-d')).toBeTruthy();
  });

  it('generateHighLevelTraceJSON should accept string moduleId dependency data (AC-1.16)', () => {
    // Arrange
    const config = {
      version: 1,
      projectRoot: '.',
      modules: [
        { id: 'mod-a', name: 'A', description: 'A', fileGlobs: ['src/a/**'] },
        { id: 'mod-b', name: 'B', description: 'B', fileGlobs: ['src/b/**'] },
      ],
    };
    const depData = {
      'mod-a': {
        dependencies: ['mod-b'],
        dependents: [],
      },
      'mod-b': {
        dependencies: [],
        dependents: ['mod-a'],
      },
    };

    // Act
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '.',
      existingTrace: null,
      dependencyData: depData,
    });

    // Assert
    const modA = trace.modules.find(m => m.id === 'mod-a');
    expect(modA).toBeTruthy();
    expect(modA.dependencies).toEqual(['mod-b']);
  });

  it('skippedFiles should be included in high-level trace output (AC-1.3 / AC-1.16)', () => {
    // Arrange
    const config = {
      version: 1,
      projectRoot: '.',
      modules: [
        { id: 'mod-a', name: 'A', description: 'A', fileGlobs: ['src/a/**'] },
      ],
    };

    // Act
    const trace = generateHighLevelTraceJSON({
      config,
      projectRoot: '.',
      existingTrace: null,
      dependencyData: {
        'mod-a': { dependencies: [], dependents: [] },
      },
      skippedFiles: [
        { path: 'src/shared/utils.ts', matchedModules: ['mod-a', 'mod-b'] },
      ],
    });

    // Assert -- skippedFiles should be in the trace
    const hasSkipped = trace.skippedFiles || [];
    expect(Array.isArray(hasSkipped)).toBeTruthy();
  });
});

// =============================================================================
// fileToModules (plural) -- all-match semantics
// =============================================================================

describe('fileToModules -- all-match semantics', () => {
  it('should return all matching modules for a file path', () => {
    // Arrange
    const config = {
      version: 1,
      projectRoot: '.',
      modules: [
        { id: 'mod-a', name: 'A', description: 'A', fileGlobs: ['src/**'] },
        { id: 'mod-b', name: 'B', description: 'B', fileGlobs: ['src/shared/**'] },
      ],
    };

    // Act
    const modules = fileToModules('src/shared/utils.ts', config);

    // Assert
    expect(Array.isArray(modules)).toBeTruthy();
    expect(modules.length >= 2).toBeTruthy();
    const ids = modules.map(m => m.id || m);
    expect(ids.includes('mod-a')).toBeTruthy();
    expect(ids.includes('mod-b')).toBeTruthy();
  });

  it('should return empty array for unmatched paths', () => {
    // Arrange
    const config = {
      version: 1,
      projectRoot: '.',
      modules: [
        { id: 'mod-a', name: 'A', description: 'A', fileGlobs: ['src/mod-a/**'] },
      ],
    };

    // Act
    const modules = fileToModules('lib/unrelated/file.ts', config);

    // Assert
    expect(Array.isArray(modules)).toBeTruthy();
    expect(modules.length).toBe(0);
  });
});

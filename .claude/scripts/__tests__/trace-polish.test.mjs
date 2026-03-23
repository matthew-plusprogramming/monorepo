/**
 * Unit tests for M5: Polish -- PR Trace Diff + Trace-Sync Merge Strategies
 *
 * Tests: REQ-023 (PR trace diff summary), REQ-024 (auto-merge for non-conflicting divergence)
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs trace-polish.test.mjs
 */

import { describe, it, expect } from 'vitest';

// =============================================================================
// M5 functions under test (Task 5.1 and Task 5.2)
// =============================================================================

import {
  computeTraceDiff,
  hasChanges,
  formatTraceDiff,
  parseCliArgs as parseDiffCliArgs,
} from '../trace-diff.mjs';

import {
  classifyDivergence,
  getKeyFn,
  classifyConflictsForAutoMerge,
  applyAutoMerge,
  formatAutoMergeLog,
  parseCliArgs,
} from '../trace-sync.mjs';

// =============================================================================
// Test Fixtures
// =============================================================================

function makeHighLevelTrace(overrides = {}) {
  return {
    version: 1,
    lastGenerated: '2026-03-20T10:00:00.000Z',
    generatedBy: 'trace-generate',
    projectRoot: '.',
    modules: overrides.modules || [
      {
        id: 'scripts-lib',
        name: 'Scripts Lib',
        description: 'Shared library utilities',
        fileGlobs: ['.claude/scripts/lib/**'],
        dependencies: [],
        dependents: ['trace-scripts'],
      },
      {
        id: 'trace-scripts',
        name: 'Trace Scripts',
        description: 'Trace generation and query',
        fileGlobs: ['.claude/scripts/trace-*.mjs'],
        dependencies: ['scripts-lib'],
        dependents: [],
      },
    ],
  };
}

function makeLowLevelTrace(moduleId, overrides = {}) {
  return {
    moduleId,
    version: 1,
    lastGenerated: '2026-03-20T10:00:00.000Z',
    generatedBy: 'trace-generate',
    files: overrides.files || [
      {
        filePath: `.claude/scripts/lib/${moduleId}.mjs`,
        exports: overrides.exports || [
          { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x)' },
          { symbol: 'helperB', type: 'function', lineNumber: 25, signature: '(y, z)' },
        ],
        imports: overrides.imports || [
          { source: 'node:fs', symbols: ['readFileSync'] },
        ],
        calls: overrides.calls || [
          {
            callerFile: `.claude/scripts/lib/${moduleId}.mjs`,
            callerLine: 12,
            calleeName: 'readFileSync',
            calleeFile: null,
            calleeLine: null,
          },
        ],
        events: overrides.events || [],
      },
    ],
  };
}

// =============================================================================
// REQ-023: PR Trace Diff Summary
// =============================================================================

describe('computeTraceDiff (REQ-023: PR Trace Diff Summary)', () => {
  it('should detect new modules added (REQ-023 AC-pr-diff)', () => {
    const baseHL = makeHighLevelTrace();
    const branchHL = makeHighLevelTrace({
      modules: [
        ...baseHL.modules,
        {
          id: 'docs-scripts',
          name: 'Docs Scripts',
          description: 'Documentation generation',
          fileGlobs: ['.claude/scripts/docs-*.mjs'],
          dependencies: ['scripts-lib'],
          dependents: [],
        },
      ],
    });
    const baseLl = new Map([
      ['scripts-lib', makeLowLevelTrace('scripts-lib')],
      ['trace-scripts', makeLowLevelTrace('trace-scripts')],
    ]);
    const branchLl = new Map([
      ['scripts-lib', makeLowLevelTrace('scripts-lib')],
      ['trace-scripts', makeLowLevelTrace('trace-scripts')],
      ['docs-scripts', makeLowLevelTrace('docs-scripts')],
    ]);

    const diff = computeTraceDiff(baseHL, baseLl, branchHL, branchLl);

    expect(diff.newModules.some(m => m.id === 'docs-scripts')).toBe(true);
    expect(diff.newModules.length).toBe(1);
  });

  it('should detect removed modules (REQ-023 AC-pr-diff)', () => {
    const baseHL = makeHighLevelTrace();
    const branchHL = makeHighLevelTrace({
      modules: [baseHL.modules[0]], // only scripts-lib
    });
    const baseLl = new Map([
      ['scripts-lib', makeLowLevelTrace('scripts-lib')],
      ['trace-scripts', makeLowLevelTrace('trace-scripts')],
    ]);
    const branchLl = new Map([
      ['scripts-lib', makeLowLevelTrace('scripts-lib')],
    ]);

    const diff = computeTraceDiff(baseHL, baseLl, branchHL, branchLl);

    expect(diff.removedModules.some(m => m.id === 'trace-scripts')).toBe(true);
    expect(diff.removedModules.length).toBe(1);
  });

  it('should detect new exports in existing module (REQ-023 AC-pr-diff)', () => {
    const hl = makeHighLevelTrace();
    const baseLl = new Map([
      ['scripts-lib', makeLowLevelTrace('scripts-lib', {
        exports: [
          { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x)' },
        ],
      })],
    ]);
    const branchLl = new Map([
      ['scripts-lib', makeLowLevelTrace('scripts-lib', {
        exports: [
          { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x)' },
          { symbol: 'helperC', type: 'function', lineNumber: 40, signature: '(a, b)' },
        ],
      })],
    ]);

    const diff = computeTraceDiff(hl, baseLl, hl, branchLl);

    const libChanges = diff.exportChanges.find(c => c.moduleId === 'scripts-lib');
    expect(libChanges).toBeTruthy();
    expect(libChanges.added.some(e => e.symbol === 'helperC')).toBe(true);
  });

  it('should detect removed exports (REQ-023 AC-pr-diff)', () => {
    const hl = makeHighLevelTrace();
    const baseLl = new Map([
      ['scripts-lib', makeLowLevelTrace('scripts-lib', {
        exports: [
          { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x)' },
          { symbol: 'helperB', type: 'function', lineNumber: 25, signature: '(y, z)' },
        ],
      })],
    ]);
    const branchLl = new Map([
      ['scripts-lib', makeLowLevelTrace('scripts-lib', {
        exports: [
          { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x)' },
        ],
      })],
    ]);

    const diff = computeTraceDiff(hl, baseLl, hl, branchLl);

    const libChanges = diff.exportChanges.find(c => c.moduleId === 'scripts-lib');
    expect(libChanges).toBeTruthy();
    expect(libChanges.removed.some(e => e.symbol === 'helperB')).toBe(true);
  });

  it('should detect changed dependencies -- new edges (REQ-023 AC-pr-diff)', () => {
    const baseModules = [
      {
        id: 'scripts-lib',
        name: 'Scripts Lib',
        description: 'Shared lib',
        fileGlobs: ['.claude/scripts/lib/**'],
        dependencies: [],
        dependents: ['trace-scripts'],
      },
      {
        id: 'trace-scripts',
        name: 'Trace Scripts',
        description: 'Trace gen',
        fileGlobs: ['.claude/scripts/trace-*.mjs'],
        dependencies: ['scripts-lib'],
        dependents: [],
      },
    ];
    const branchModules = [
      ...baseModules,
      {
        id: 'docs-scripts',
        name: 'Docs Scripts',
        description: 'Docs gen',
        fileGlobs: ['.claude/scripts/docs-*.mjs'],
        dependencies: ['scripts-lib'],
        dependents: [],
      },
    ];

    const baseHL = makeHighLevelTrace({ modules: baseModules });
    const branchHL = makeHighLevelTrace({ modules: branchModules });

    const diff = computeTraceDiff(baseHL, new Map(), branchHL, new Map());

    // docs-scripts is new module, its dependencies are captured at module level
    expect(diff.newModules.some(m => m.id === 'docs-scripts')).toBe(true);
  });

  it('should detect new call graph edges (REQ-023 AC-pr-diff)', () => {
    const hl = makeHighLevelTrace();
    const baseLl = new Map([
      ['scripts-lib', makeLowLevelTrace('scripts-lib', { calls: [] })],
    ]);
    const branchLl = new Map([
      ['scripts-lib', makeLowLevelTrace('scripts-lib', {
        calls: [
          {
            callerFile: '.claude/scripts/lib/scripts-lib.mjs',
            callerLine: 15,
            calleeName: 'readFileSync',
            calleeFile: null,
            calleeLine: null,
          },
        ],
      })],
    ]);

    const diff = computeTraceDiff(hl, baseLl, hl, branchLl);

    const libChanges = diff.callChanges.find(c => c.moduleId === 'scripts-lib');
    expect(libChanges).toBeTruthy();
    expect(libChanges.added.length).toBe(1);
  });

  it('should detect new event patterns (REQ-023 AC-pr-diff)', () => {
    const hl = makeHighLevelTrace();
    const baseLl = new Map([
      ['scripts-lib', makeLowLevelTrace('scripts-lib', { events: [] })],
    ]);
    const branchLl = new Map([
      ['scripts-lib', makeLowLevelTrace('scripts-lib', {
        events: [
          {
            file: '.claude/scripts/lib/scripts-lib.mjs',
            line: 30,
            eventName: 'trace:complete',
            type: 'emit',
          },
        ],
      })],
    ]);

    const diff = computeTraceDiff(hl, baseLl, hl, branchLl);

    const libChanges = diff.eventChanges.find(c => c.moduleId === 'scripts-lib');
    expect(libChanges).toBeTruthy();
    expect(libChanges.added.length).toBe(1);
  });

  it('should produce valid markdown output (REQ-023 AC-pr-diff)', () => {
    const hl = makeHighLevelTrace();
    const baseLl = new Map([
      ['scripts-lib', makeLowLevelTrace('scripts-lib', {
        exports: [
          { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x)' },
        ],
      })],
    ]);
    const branchLl = new Map([
      ['scripts-lib', makeLowLevelTrace('scripts-lib', {
        exports: [
          { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x)' },
          { symbol: 'helperNew', type: 'function', lineNumber: 50, signature: '()' },
        ],
      })],
    ]);

    const diff = computeTraceDiff(hl, baseLl, hl, branchLl);
    const markdown = formatTraceDiff(diff);

    expect(typeof markdown).toBe('string');
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown).toMatch(/^#/m);
  });

  it('should output "No architectural changes" when traces are identical (REQ-023 AC-pr-no-changes, EC-7)', () => {
    const hl = makeHighLevelTrace();
    const ll = new Map([
      ['scripts-lib', makeLowLevelTrace('scripts-lib')],
    ]);

    const diff = computeTraceDiff(hl, ll, hl, ll);
    const markdown = formatTraceDiff(diff);

    expect(markdown).toMatch(/no architectural changes/i);
    expect(diff.newModules.length).toBe(0);
    expect(diff.removedModules.length).toBe(0);
  });

  it('should treat everything as new when base traces are missing (REQ-023)', () => {
    const branchHL = makeHighLevelTrace();
    const branchLl = new Map([
      ['scripts-lib', makeLowLevelTrace('scripts-lib')],
      ['trace-scripts', makeLowLevelTrace('trace-scripts')],
    ]);

    const diff = computeTraceDiff(null, new Map(), branchHL, branchLl);

    expect(diff.newModules.some(m => m.id === 'scripts-lib')).toBe(true);
    expect(diff.newModules.some(m => m.id === 'trace-scripts')).toBe(true);
    expect(diff.newModules.length).toBe(2);
    expect(diff.removedModules.length).toBe(0);
  });

  it('should default base branch to "main" (REQ-023)', () => {
    const result = parseDiffCliArgs(['node', 'trace-diff.mjs']);
    expect(result.baseBranch).toBe('main');
  });
});

// =============================================================================
// REQ-024: Auto-Merge for Non-Conflicting Trace Divergence
// =============================================================================

describe('classifyDivergence (REQ-024: Divergence Classification)', () => {
  it('should classify additions-only divergence (REQ-024 AC-auto-merge-additions)', () => {
    const keyFn = getKeyFn('exports');
    const jsonData = [
      { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x)' },
      { symbol: 'helperB', type: 'function', lineNumber: 25, signature: '(y)' },
      { symbol: 'helperC', type: 'function', lineNumber: 40, signature: '(z)' },
    ];
    const mdData = [
      { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x)' },
      { symbol: 'helperB', type: 'function', lineNumber: 25, signature: '(y)' },
    ];

    const result = classifyDivergence(jsonData, mdData, keyFn);

    // helperC is in JSON but not in markdown -> from JSON perspective, mdData is missing it
    // From mdData's perspective, jsonData has an addition: helperC
    // classifyDivergence: additions = in md not in json, deletions = in json not in md
    // Since helperC is in json but not md, it's a deletion from md's perspective
    expect(result.deletions.length).toBe(1);
    expect(result.deletions[0].symbol).toBe('helperC');
    expect(result.additions.length).toBe(0);
    expect(result.modifications.length).toBe(0);
  });

  it('should classify deletions (REQ-024 AC-auto-merge-fallback)', () => {
    const keyFn = getKeyFn('exports');
    const jsonData = [
      { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x)' },
    ];
    const mdData = [
      { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x)' },
      { symbol: 'helperB', type: 'function', lineNumber: 25, signature: '(y)' },
    ];

    const result = classifyDivergence(jsonData, mdData, keyFn);

    // helperB is in md but not json -> addition from md's perspective
    expect(result.additions.length).toBe(1);
    expect(result.additions[0].symbol).toBe('helperB');
  });

  it('should classify modifications (REQ-024 AC-auto-merge-fallback)', () => {
    const keyFn = getKeyFn('exports');
    const jsonData = [
      { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x, y)' },
    ];
    const mdData = [
      { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x)' },
    ];

    const result = classifyDivergence(jsonData, mdData, keyFn);

    expect(result.modifications.length).toBe(1);
    expect(result.modifications[0].json.signature).toBe('(x, y)');
    expect(result.modifications[0].markdown.signature).toBe('(x)');
  });

  it('should handle mixed changes: additions + deletions (REQ-024)', () => {
    const keyFn = getKeyFn('exports');
    const jsonData = [
      { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x)' },
      { symbol: 'helperC', type: 'function', lineNumber: 40, signature: '(z)' },
    ];
    const mdData = [
      { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x)' },
      { symbol: 'helperB', type: 'function', lineNumber: 25, signature: '(y)' },
    ];

    const result = classifyDivergence(jsonData, mdData, keyFn);

    expect(result.additions.length).toBe(1); // helperB is in md but not json
    expect(result.deletions.length).toBe(1); // helperC is in json but not md
  });
});

describe('classifyConflictsForAutoMerge (REQ-024: Auto-Merge Strategies)', () => {
  it('should auto-merge additions-only divergence (REQ-024 AC-auto-merge-additions)', () => {
    const conflicts = [{
      module: 'file.mjs',
      field: 'exports',
      jsonValue: [
        { symbol: 'helperA', type: 'function' },
      ],
      markdownValue: [
        { symbol: 'helperA', type: 'function' },
        { symbol: 'helperC', type: 'function' },
      ],
    }];

    const result = classifyConflictsForAutoMerge(conflicts);

    expect(result.autoMergeable.length).toBe(1);
    expect(result.autoMergeable[0].additions.length).toBe(1);
    expect(result.autoMergeable[0].additions[0].symbol).toBe('helperC');
    expect(result.manual.length).toBe(0);
  });

  it('should NOT auto-merge deletions -- flag for manual resolution (REQ-024 AC-auto-merge-fallback)', () => {
    const conflicts = [{
      module: 'file.mjs',
      field: 'exports',
      jsonValue: [
        { symbol: 'helperA', type: 'function' },
        { symbol: 'helperB', type: 'function' },
      ],
      markdownValue: [
        { symbol: 'helperA', type: 'function' },
      ],
    }];

    const result = classifyConflictsForAutoMerge(conflicts);

    expect(result.autoMergeable.length).toBe(0);
    expect(result.manual.length).toBe(1);
    expect(result.manual[0].deletions.length).toBe(1);
  });

  it('should NOT auto-merge modifications -- flag for manual resolution (REQ-024 AC-auto-merge-fallback)', () => {
    const conflicts = [{
      module: 'file.mjs',
      field: 'exports',
      jsonValue: [
        { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x, y)' },
      ],
      markdownValue: [
        { symbol: 'helperA', type: 'function', lineNumber: 10, signature: '(x)' },
      ],
    }];

    const result = classifyConflictsForAutoMerge(conflicts);

    expect(result.autoMergeable.length).toBe(0);
    expect(result.manual.length).toBe(1);
    expect(result.manual[0].modifications.length).toBe(1);
  });

  it('should auto-merge additions and flag deletions/modifications in mixed changes (REQ-024)', () => {
    const conflicts = [
      {
        module: 'file.mjs',
        field: 'exports',
        jsonValue: [{ symbol: 'helperA', type: 'function' }],
        markdownValue: [
          { symbol: 'helperA', type: 'function' },
          { symbol: 'helperC', type: 'function' },
        ],
      },
      {
        module: 'file.mjs',
        field: 'imports',
        jsonValue: [
          { source: 'node:fs', symbols: ['readFileSync'] },
          { source: 'node:path', symbols: ['join'] },
        ],
        markdownValue: [
          { source: 'node:fs', symbols: ['readFileSync'] },
        ],
      },
    ];

    const result = classifyConflictsForAutoMerge(conflicts);

    // exports conflict is additions-only (helperC added)
    expect(result.autoMergeable.length).toBe(1);
    expect(result.autoMergeable[0].conflict.field).toBe('exports');
    // imports conflict has deletion (node:path removed)
    expect(result.manual.length).toBe(1);
    expect(result.manual[0].conflict.field).toBe('imports');
  });

  it('should produce dry-run log showing what was auto-merged (REQ-024)', () => {
    const mergedItems = [{
      conflict: { module: 'file.mjs', field: 'exports' },
      additions: [{ symbol: 'helperNew', type: 'function' }],
    }];

    const lines = formatAutoMergeLog(mergedItems, []);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some(l => l.includes('helperNew') || l.includes('Auto-merged'))).toBe(true);
  });

  it('should not auto-merge when --auto-merge flag is off (REQ-024 default behavior)', () => {
    // Without --auto-merge, conflicts are just reported normally
    const result = parseCliArgs(['node', 'trace-sync.mjs']);
    expect(result.autoMerge).toBe(false);
  });

  it('applyAutoMerge produces clean merge for additions-only (REQ-024)', () => {
    const jsonArr = [
      { symbol: 'helperA', type: 'function' },
      { symbol: 'helperB', type: 'function' },
    ];
    const additions = [
      { symbol: 'helperC', type: 'function' },
    ];

    const merged = applyAutoMerge(jsonArr, additions);

    expect(merged.length).toBe(3);
    expect(merged.some(e => e.symbol === 'helperC')).toBe(true);
  });
});

// =============================================================================
// REQ-024: parseCliArgs --auto-merge flag
// =============================================================================

describe('parseCliArgs --auto-merge flag (REQ-024)', () => {
  it('should default --auto-merge to off (REQ-024)', () => {
    const result = parseCliArgs(['node', 'trace-sync.mjs']);
    expect(result.autoMerge).toBe(false);
  });

  it('should parse --auto-merge flag to enable auto-merge (REQ-024)', () => {
    const result = parseCliArgs(['node', 'trace-sync.mjs', '--auto-merge']);
    expect(result.autoMerge).toBe(true);
  });

  it('should combine --auto-merge with other flags (REQ-024)', () => {
    const result = parseCliArgs(['node', 'trace-sync.mjs', '--auto-merge', '--dry-run']);
    expect(result.autoMerge).toBe(true);
    expect(result.dryRun).toBe(true);
  });
});

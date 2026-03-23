/**
 * Tests for trace-diff.mjs (M5, Task 5.1)
 *
 * Covers:
 * - REQ-023 (AC-pr-diff): Branch with trace changes produces summary
 * - REQ-023 (AC-pr-no-changes): Branch with no trace changes outputs "No architectural changes detected"
 * - EC-7: Empty diff handled gracefully
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs trace-diff.test.mjs
 */

import { describe, it, expect } from 'vitest';
import {
  computeTraceDiff,
  hasChanges,
  formatTraceDiff,
  parseCliArgs,
} from '../trace-diff.mjs';

// =============================================================================
// Test Fixtures
// =============================================================================

function makeHighLevel(modules) {
  return {
    version: 1,
    lastGenerated: '2026-03-20T10:00:00.000Z',
    generatedBy: 'trace generate',
    projectRoot: '.',
    modules,
  };
}

function makeLowLevel(moduleId, files) {
  return {
    moduleId,
    version: 1,
    lastGenerated: '2026-03-20T10:00:00.000Z',
    generatedBy: 'trace-generate',
    files,
  };
}

function makeFile(filePath, { exports = [], imports = [], calls = [], events = [] } = {}) {
  return { filePath, exports, imports, calls, events };
}

// =============================================================================
// computeTraceDiff tests
// =============================================================================

describe('computeTraceDiff', () => {
  it('should detect no changes when base and current are identical', () => {
    const hl = makeHighLevel([
      { id: 'mod-a', name: 'Module A', dependencies: ['mod-b'], dependents: [] },
    ]);
    const ll = new Map([
      ['mod-a', makeLowLevel('mod-a', [
        makeFile('src/a.mjs', {
          exports: [{ symbol: 'foo', type: 'function' }],
        }),
      ])],
    ]);

    const diff = computeTraceDiff(hl, ll, hl, ll);
    expect(hasChanges(diff)).toBe(false);
  });

  it('should detect new modules', () => {
    const baseHL = makeHighLevel([
      { id: 'mod-a', name: 'Module A', dependencies: [], dependents: [] },
    ]);
    const currentHL = makeHighLevel([
      { id: 'mod-a', name: 'Module A', dependencies: [], dependents: [] },
      { id: 'mod-b', name: 'Module B', dependencies: [], dependents: [] },
    ]);

    const diff = computeTraceDiff(baseHL, new Map(), currentHL, new Map());
    expect(diff.newModules).toEqual([{ id: 'mod-b', name: 'Module B' }]);
  });

  it('should detect removed modules', () => {
    const baseHL = makeHighLevel([
      { id: 'mod-a', name: 'Module A', dependencies: [], dependents: [] },
      { id: 'mod-b', name: 'Module B', dependencies: [], dependents: [] },
    ]);
    const currentHL = makeHighLevel([
      { id: 'mod-a', name: 'Module A', dependencies: [], dependents: [] },
    ]);

    const diff = computeTraceDiff(baseHL, new Map(), currentHL, new Map());
    expect(diff.removedModules).toEqual([{ id: 'mod-b', name: 'Module B' }]);
  });

  it('should detect new exports', () => {
    const hl = makeHighLevel([
      { id: 'mod-a', name: 'Module A', dependencies: [], dependents: [] },
    ]);
    const baseLl = new Map([
      ['mod-a', makeLowLevel('mod-a', [
        makeFile('src/a.mjs', {
          exports: [{ symbol: 'foo', type: 'function' }],
        }),
      ])],
    ]);
    const currentLl = new Map([
      ['mod-a', makeLowLevel('mod-a', [
        makeFile('src/a.mjs', {
          exports: [
            { symbol: 'foo', type: 'function' },
            { symbol: 'bar', type: 'const' },
          ],
        }),
      ])],
    ]);

    const diff = computeTraceDiff(hl, baseLl, hl, currentLl);
    expect(diff.exportChanges).toHaveLength(1);
    expect(diff.exportChanges[0].moduleId).toBe('mod-a');
    expect(diff.exportChanges[0].added).toHaveLength(1);
    expect(diff.exportChanges[0].added[0].symbol).toBe('bar');
    expect(diff.exportChanges[0].removed).toHaveLength(0);
  });

  it('should detect removed exports', () => {
    const hl = makeHighLevel([
      { id: 'mod-a', name: 'Module A', dependencies: [], dependents: [] },
    ]);
    const baseLl = new Map([
      ['mod-a', makeLowLevel('mod-a', [
        makeFile('src/a.mjs', {
          exports: [
            { symbol: 'foo', type: 'function' },
            { symbol: 'bar', type: 'const' },
          ],
        }),
      ])],
    ]);
    const currentLl = new Map([
      ['mod-a', makeLowLevel('mod-a', [
        makeFile('src/a.mjs', {
          exports: [{ symbol: 'foo', type: 'function' }],
        }),
      ])],
    ]);

    const diff = computeTraceDiff(hl, baseLl, hl, currentLl);
    expect(diff.exportChanges).toHaveLength(1);
    expect(diff.exportChanges[0].removed).toHaveLength(1);
    expect(diff.exportChanges[0].removed[0].symbol).toBe('bar');
  });

  it('should detect new call graph edges', () => {
    const hl = makeHighLevel([
      { id: 'mod-a', name: 'Module A', dependencies: [], dependents: [] },
    ]);
    const baseLl = new Map([
      ['mod-a', makeLowLevel('mod-a', [
        makeFile('src/a.mjs', {
          calls: [
            { callerFile: 'src/a.mjs', callerLine: 10, calleeName: 'foo', calleeFile: null, calleeLine: null },
          ],
        }),
      ])],
    ]);
    const currentLl = new Map([
      ['mod-a', makeLowLevel('mod-a', [
        makeFile('src/a.mjs', {
          calls: [
            { callerFile: 'src/a.mjs', callerLine: 10, calleeName: 'foo', calleeFile: null, calleeLine: null },
            { callerFile: 'src/a.mjs', callerLine: 15, calleeName: 'bar', calleeFile: null, calleeLine: null },
          ],
        }),
      ])],
    ]);

    const diff = computeTraceDiff(hl, baseLl, hl, currentLl);
    expect(diff.callChanges).toHaveLength(1);
    expect(diff.callChanges[0].added).toHaveLength(1);
    expect(diff.callChanges[0].added[0].calleeName).toBe('bar');
  });

  it('should detect new event patterns', () => {
    const hl = makeHighLevel([
      { id: 'mod-a', name: 'Module A', dependencies: [], dependents: [] },
    ]);
    const baseLl = new Map([
      ['mod-a', makeLowLevel('mod-a', [
        makeFile('src/a.mjs', { events: [] }),
      ])],
    ]);
    const currentLl = new Map([
      ['mod-a', makeLowLevel('mod-a', [
        makeFile('src/a.mjs', {
          events: [
            { file: 'src/a.mjs', line: 42, eventName: 'task:complete', type: 'emit' },
          ],
        }),
      ])],
    ]);

    const diff = computeTraceDiff(hl, baseLl, hl, currentLl);
    expect(diff.eventChanges).toHaveLength(1);
    expect(diff.eventChanges[0].added).toHaveLength(1);
    expect(diff.eventChanges[0].added[0].eventName).toBe('task:complete');
  });

  it('should detect dependency changes', () => {
    const baseHL = makeHighLevel([
      { id: 'mod-a', name: 'Module A', dependencies: ['mod-b'], dependents: [] },
    ]);
    const currentHL = makeHighLevel([
      { id: 'mod-a', name: 'Module A', dependencies: ['mod-b', 'mod-c'], dependents: [] },
    ]);

    const diff = computeTraceDiff(baseHL, new Map(), currentHL, new Map());
    expect(diff.dependencyChanges).toHaveLength(1);
    expect(diff.dependencyChanges[0].added).toContain('mod-c');
  });

  it('should treat everything as new when base has no traces', () => {
    const currentHL = makeHighLevel([
      { id: 'mod-a', name: 'Module A', dependencies: [], dependents: [] },
    ]);
    const currentLl = new Map([
      ['mod-a', makeLowLevel('mod-a', [
        makeFile('src/a.mjs', {
          exports: [{ symbol: 'foo', type: 'function' }],
        }),
      ])],
    ]);

    // Base is null (no traces on base branch)
    const diff = computeTraceDiff(null, new Map(), currentHL, currentLl);
    expect(diff.newModules).toHaveLength(1);
    expect(diff.newModules[0].id).toBe('mod-a');
    expect(diff.exportChanges).toHaveLength(1);
    expect(diff.exportChanges[0].added).toHaveLength(1);
  });

  it('should handle modules only in low-level but not high-level gracefully', () => {
    const hl = makeHighLevel([]);
    const baseLl = new Map();
    const currentLl = new Map([
      ['mod-orphan', makeLowLevel('mod-orphan', [
        makeFile('src/orphan.mjs', {
          exports: [{ symbol: 'orphanFn', type: 'function' }],
        }),
      ])],
    ]);

    const diff = computeTraceDiff(hl, baseLl, hl, currentLl);
    expect(diff.exportChanges).toHaveLength(1);
    expect(diff.exportChanges[0].moduleId).toBe('mod-orphan');
  });
});

// =============================================================================
// hasChanges tests
// =============================================================================

describe('hasChanges', () => {
  it('should return false for empty diff', () => {
    const diff = {
      newModules: [],
      removedModules: [],
      exportChanges: [],
      dependencyChanges: [],
      callChanges: [],
      eventChanges: [],
    };
    expect(hasChanges(diff)).toBe(false);
  });

  it('should return true when any section has changes', () => {
    const diff = {
      newModules: [{ id: 'x', name: 'X' }],
      removedModules: [],
      exportChanges: [],
      dependencyChanges: [],
      callChanges: [],
      eventChanges: [],
    };
    expect(hasChanges(diff)).toBe(true);
  });
});

// =============================================================================
// formatTraceDiff tests
// =============================================================================

describe('formatTraceDiff', () => {
  it('should output "No architectural changes detected." for empty diff (EC-7)', () => {
    const diff = {
      newModules: [],
      removedModules: [],
      exportChanges: [],
      dependencyChanges: [],
      callChanges: [],
      eventChanges: [],
    };
    const output = formatTraceDiff(diff);
    expect(output).toBe('No architectural changes detected.');
  });

  it('should include new modules in output (REQ-023, AC-pr-diff)', () => {
    const diff = {
      newModules: [{ id: 'mod-new', name: 'New Module' }],
      removedModules: [],
      exportChanges: [],
      dependencyChanges: [],
      callChanges: [],
      eventChanges: [],
    };
    const output = formatTraceDiff(diff);
    expect(output).toContain('### New Modules');
    expect(output).toContain('**New Module**');
    expect(output).toContain('`mod-new`');
  });

  it('should include removed modules in output', () => {
    const diff = {
      newModules: [],
      removedModules: [{ id: 'mod-old', name: 'Old Module' }],
      exportChanges: [],
      dependencyChanges: [],
      callChanges: [],
      eventChanges: [],
    };
    const output = formatTraceDiff(diff);
    expect(output).toContain('### Removed Modules');
    expect(output).toContain('**Old Module**');
  });

  it('should include export changes with + and - indicators', () => {
    const diff = {
      newModules: [],
      removedModules: [],
      exportChanges: [{
        moduleId: 'mod-a',
        added: [{ symbol: 'newFn', type: 'function', file: 'src/a.mjs' }],
        removed: [{ symbol: 'oldFn', type: 'function', file: 'src/a.mjs' }],
      }],
      dependencyChanges: [],
      callChanges: [],
      eventChanges: [],
    };
    const output = formatTraceDiff(diff);
    expect(output).toContain('### Export Changes');
    expect(output).toContain('+ `newFn`');
    expect(output).toContain('- `oldFn`');
  });

  it('should include dependency changes', () => {
    const diff = {
      newModules: [],
      removedModules: [],
      exportChanges: [],
      dependencyChanges: [{
        moduleId: 'mod-a',
        added: ['mod-c'],
        removed: ['mod-b'],
      }],
      callChanges: [],
      eventChanges: [],
    };
    const output = formatTraceDiff(diff);
    expect(output).toContain('### Dependency Changes');
    expect(output).toContain('+ mod-c');
    expect(output).toContain('- mod-b');
  });

  it('should include call graph changes', () => {
    const diff = {
      newModules: [],
      removedModules: [],
      exportChanges: [],
      dependencyChanges: [],
      callChanges: [{
        moduleId: 'mod-a',
        added: [{ calleeName: 'newCall', callerFile: 'src/a.mjs', callerLine: 10 }],
        removed: [],
      }],
      eventChanges: [],
    };
    const output = formatTraceDiff(diff);
    expect(output).toContain('### Call Graph Changes');
    expect(output).toContain('`newCall`');
  });

  it('should include event pattern changes', () => {
    const diff = {
      newModules: [],
      removedModules: [],
      exportChanges: [],
      dependencyChanges: [],
      callChanges: [],
      eventChanges: [{
        moduleId: 'mod-a',
        added: [{ type: 'emit', eventName: 'task:done', file: 'src/a.mjs', line: 5 }],
        removed: [],
      }],
    };
    const output = formatTraceDiff(diff);
    expect(output).toContain('### Event Pattern Changes');
    expect(output).toContain('`task:done`');
  });
});

// =============================================================================
// parseCliArgs tests
// =============================================================================

describe('parseCliArgs', () => {
  it('should default to main base branch', () => {
    const result = parseCliArgs(['node', 'trace-diff.mjs']);
    expect(result.baseBranch).toBe('main');
  });

  it('should parse --base flag', () => {
    const result = parseCliArgs(['node', 'trace-diff.mjs', '--base', 'develop']);
    expect(result.baseBranch).toBe('develop');
  });
});

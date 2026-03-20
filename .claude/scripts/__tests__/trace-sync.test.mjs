/**
 * Unit and integration tests for trace-sync.mjs
 *
 * Tests: as-011-trace-sync-core (AC-10.1, AC-10.2, AC-10.4)
 *         as-012-trace-sync-conflicts (AC-10.3, AC-10.5)
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs trace-sync.test.mjs
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseHtmlCommentMetadata,
  parsePipeDelimitedLine,
  parsePipeDelimitedSection,
  isNotSyncedSection,
  splitIntoSections,
  parseHighLevelMarkdown,
  parseLowLevelMarkdown,
  applyHighLevelSync,
  applyLowLevelSync,
  arraysDeepEqual,
  syncAll,
  detectHighLevelConflicts,
  detectLowLevelConflicts,
  jsonDivergedFromMarkdown,
  formatConflictReport,
  buildSyncSummary,
  parseCliArgs,
} from '../trace-sync.mjs';

// =============================================================================
// Test Helpers
// =============================================================================

function setupTestRoot() {
  const timestamp = Date.now();
  const testRoot = join(
    tmpdir(),
    `trace-sync-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true });
  return testRoot;
}

function createHighLevelJson() {
  return {
    version: 1,
    lastGenerated: '2026-02-22T10:30:00.000Z',
    generatedBy: 'trace generate',
    projectRoot: '.',
    modules: [
      {
        id: 'dev-team',
        name: 'Dev Team',
        description: 'Handles development work items',
        fileGlobs: ['apps/agent-orchestrator/src/dev-team/**'],
        dependencies: [
          {
            targetId: 'qa-team',
            relationshipType: 'publishes-to',
            description: 'Sends completed work items for QA review',
          },
        ],
        dependents: [
          {
            targetId: 'triage-team',
            relationshipType: 'calls',
            description: 'Receives triaged work items',
          },
        ],
      },
      {
        id: 'qa-team',
        name: 'QA Team',
        description: 'Quality assurance',
        fileGlobs: ['apps/agent-orchestrator/src/qa-team/**'],
        dependencies: [],
        dependents: [],
      },
    ],
  };
}

function createHighLevelMarkdown(options = {}) {
  const version = options.version || 1;
  const deps = options.devTeamDeps || 'qa-team | publishes-to | Sends completed work items for QA review';
  const dependents = options.devTeamDependents || 'triage-team | calls | Receives triaged work items';
  const notes = options.notes || '';

  return `<!-- trace-id: high-level -->
<!-- trace-version: ${version} -->
<!-- last-generated: 2026-02-22T10:30:00.000Z -->
<!-- generated-by: trace generate -->

# Architecture Trace: High-Level

## Module: Dev Team

**ID**: dev-team
**Description**: Handles development work items
**File Globs**: \`apps/agent-orchestrator/src/dev-team/**\`

### Dependencies

target | relationship-type | description
${deps}

### Dependents

target | relationship-type | description
${dependents}
${notes}
## Module: QA Team

**ID**: qa-team
**Description**: Quality assurance
**File Globs**: \`apps/agent-orchestrator/src/qa-team/**\`

### Dependencies

(none)

### Dependents

(none)
`;
}

function createLowLevelJson() {
  return {
    moduleId: 'dev-team',
    version: 1,
    lastGenerated: '2026-02-22T10:30:00.000Z',
    generatedBy: 'trace-generate',
    files: [
      {
        filePath: 'apps/agent-orchestrator/src/dev-team/service.py',
        exports: [
          { symbol: 'process_work_item', type: 'function' },
          { symbol: 'DevTeamService', type: 'class' },
        ],
        imports: [
          { source: '../knowledge-team/service', symbols: ['KnowledgeService'] },
          { source: '../common/models', symbols: ['WorkItem', 'Status'] },
        ],
        calls: [
          { target: 'knowledge-team/service.py', function: 'query_knowledge', context: 'process_work_item' },
        ],
        events: [
          { type: 'publish', eventName: 'work.completed', channel: 'dev-team-output' },
        ],
      },
    ],
  };
}

function createLowLevelMarkdown(options = {}) {
  const exports = options.exports || `process_work_item | function
DevTeamService | class`;
  const imports = options.imports || `../knowledge-team/service | KnowledgeService
../common/models | WorkItem, Status`;
  const calls = options.calls || `knowledge-team/service.py | query_knowledge | process_work_item`;
  const events = options.events || `publish | work.completed | dev-team-output`;
  const notes = options.notes || '';

  return `<!-- trace-id: dev-team -->
<!-- trace-version: 1 -->
<!-- last-generated: 2026-02-22T10:30:00.000Z -->
<!-- generated-by: trace-generate -->

# Low-Level Trace: Dev Team

## File: apps/agent-orchestrator/src/dev-team/service.py

### Exports

symbol | type
${exports}

### Imports

source | symbols
${imports}

### Function Calls

target | function | context
${calls}

### Events

type | event-name | channel
${events}

## Notes (not synced)

${notes}
`;
}

// =============================================================================
// parseHtmlCommentMetadata tests
// =============================================================================

describe('parseHtmlCommentMetadata', () => {
  it('should extract all four metadata fields', () => {
    const md = `<!-- trace-id: high-level -->
<!-- trace-version: 3 -->
<!-- last-generated: 2026-02-22T10:30:00.000Z -->
<!-- generated-by: trace generate -->`;

    const result = parseHtmlCommentMetadata(md);
    expect(result.traceId).toBe('high-level');
    expect(result.traceVersion).toBe(3);
    expect(result.lastGenerated).toBe('2026-02-22T10:30:00.000Z');
    expect(result.generatedBy).toBe('trace generate');
  });

  it('should return null for missing fields', () => {
    const md = '<!-- trace-id: test -->';
    const result = parseHtmlCommentMetadata(md);
    expect(result.traceId).toBe('test');
    expect(result.traceVersion).toBe(null);
    expect(result.lastGenerated).toBe(null);
    expect(result.generatedBy).toBe(null);
  });

  it('should parse trace-version as integer', () => {
    const md = '<!-- trace-version: 42 -->';
    const result = parseHtmlCommentMetadata(md);
    expect(result.traceVersion).toBe(42);
  });

  it('should return null for non-numeric trace-version', () => {
    const md = '<!-- trace-version: abc -->';
    const result = parseHtmlCommentMetadata(md);
    expect(result.traceVersion).toBe(null);
  });

  it('should handle whitespace in values', () => {
    const md = '<!-- trace-id:   my-module   -->';
    const result = parseHtmlCommentMetadata(md);
    expect(result.traceId).toBe('my-module');
  });

  it('should return all nulls for empty string', () => {
    const result = parseHtmlCommentMetadata('');
    expect(result.traceId).toBe(null);
    expect(result.traceVersion).toBe(null);
    expect(result.lastGenerated).toBe(null);
    expect(result.generatedBy).toBe(null);
  });
});

// =============================================================================
// parsePipeDelimitedLine tests
// =============================================================================

describe('parsePipeDelimitedLine', () => {
  it('should parse a valid 3-column line', () => {
    const result = parsePipeDelimitedLine('qa-team | publishes-to | Sends work items', 3, 'test');
    expect(result.fields).toEqual(['qa-team', 'publishes-to', 'Sends work items']);
    expect(result.error).toBe(null);
  });

  it('should parse a valid 2-column line', () => {
    const result = parsePipeDelimitedLine('process_work_item | function', 2, 'test');
    expect(result.fields).toEqual(['process_work_item', 'function']);
    expect(result.error).toBe(null);
  });

  it('should trim whitespace from fields', () => {
    const result = parsePipeDelimitedLine('  target  |  rel-type  |  desc  ', 3, 'test');
    expect(result.fields).toEqual(['target', 'rel-type', 'desc']);
  });

  it('should report error for wrong column count', () => {
    const result = parsePipeDelimitedLine('only-two | columns', 3, 'test:context');
    expect(result.fields).toBe(null);
    expect(result.error.includes('expected 3 columns, got 2')).toBeTruthy();
    expect(result.error.includes('test:context')).toBeTruthy();
  });

  it('should report error for too many columns', () => {
    const result = parsePipeDelimitedLine('a | b | c | d', 3, 'test');
    expect(result.fields).toBe(null);
    expect(result.error.includes('expected 3 columns, got 4')).toBeTruthy();
  });

  it('should report error for empty fields', () => {
    const result = parsePipeDelimitedLine('target |  | description', 3, 'test');
    expect(result.fields).toBe(null);
    expect(result.error.includes('empty field')).toBeTruthy();
  });

  it('should skip empty lines', () => {
    const result = parsePipeDelimitedLine('', 3, 'test');
    expect(result.fields).toBe(null);
    expect(result.error).toBe(null);
  });

  it('should skip (none) placeholder', () => {
    const result = parsePipeDelimitedLine('(none)', 3, 'test');
    expect(result.fields).toBe(null);
    expect(result.error).toBe(null);
  });

  it('should skip markdown emphasis lines (starting with _)', () => {
    const result = parsePipeDelimitedLine('_No exports_', 2, 'test');
    expect(result.fields).toBe(null);
    expect(result.error).toBe(null);
  });
});

// =============================================================================
// parsePipeDelimitedSection tests
// =============================================================================

describe('parsePipeDelimitedSection', () => {
  it('should parse lines skipping header', () => {
    const lines = [
      'target | relationship-type | description',
      'qa-team | publishes-to | Sends work',
      'knowledge | reads-from | Reads data',
    ];
    const result = parsePipeDelimitedSection(lines, 3, 'test');
    expect(result.entries.length).toBe(2);
    expect(result.entries[0]).toEqual(['qa-team', 'publishes-to', 'Sends work']);
    expect(result.entries[1]).toEqual(['knowledge', 'reads-from', 'Reads data']);
    expect(result.errors.length).toBe(0);
  });

  it('should skip empty lines and heading lines', () => {
    const lines = [
      '',
      '### Dependencies',
      '',
      'target | relationship-type | description',
      'qa-team | publishes-to | Sends work',
    ];
    const result = parsePipeDelimitedSection(lines, 3, 'test');
    expect(result.entries.length).toBe(1);
  });

  it('should skip (none) lines', () => {
    const lines = ['(none)'];
    const result = parsePipeDelimitedSection(lines, 3, 'test');
    expect(result.entries.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  it('should collect errors for malformed lines', () => {
    const lines = [
      'target | relationship-type | description',
      'qa-team | publishes-to | Sends work',
      'malformed-line-no-pipes',
      'also | bad',
    ];
    const result = parsePipeDelimitedSection(lines, 3, 'test');
    expect(result.entries.length).toBe(1); // only the valid line
    expect(result.errors.length).toBe(1); // "also | bad" has wrong count
  });

  it('should handle section with only header (no data)', () => {
    const lines = ['target | relationship-type | description'];
    const result = parsePipeDelimitedSection(lines, 3, 'test');
    expect(result.entries.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });
});

// =============================================================================
// isNotSyncedSection tests
// =============================================================================

describe('isNotSyncedSection', () => {
  it('should return true for "Notes (not synced)"', () => {
    expect(isNotSyncedSection('Notes (not synced)')).toBeTruthy();
  });

  it('should be case-insensitive', () => {
    expect(isNotSyncedSection('Notes (NOT SYNCED)')).toBeTruthy();
    expect(isNotSyncedSection('notes (Not Synced)')).toBeTruthy();
  });

  it('should return false for regular headings', () => {
    expect(isNotSyncedSection('Dependencies')).toBeFalsy();
    expect(isNotSyncedSection('Dependents')).toBeFalsy();
    expect(isNotSyncedSection('Module: Dev Team')).toBeFalsy();
  });

  it('should return true for any heading containing "(not synced)"', () => {
    expect(isNotSyncedSection('Custom Section (not synced)')).toBeTruthy();
    expect(isNotSyncedSection('My notes (not synced) extra')).toBeTruthy();
  });
});

// =============================================================================
// splitIntoSections tests
// =============================================================================

describe('splitIntoSections', () => {
  it('should split by level 2 headings', () => {
    const md = `## Module: Dev Team

Some content

## Module: QA Team

Other content
`;
    const sections = splitIntoSections(md, 2);
    expect(sections.length).toBe(2);
    expect(sections[0].heading).toBe('Module: Dev Team');
    expect(sections[1].heading).toBe('Module: QA Team');
  });

  it('should split by level 3 headings', () => {
    const md = `### Dependencies

target | rel | desc

### Dependents

target | rel | desc
`;
    const sections = splitIntoSections(md, 3);
    expect(sections.length).toBe(2);
    expect(sections[0].heading).toBe('Dependencies');
    expect(sections[1].heading).toBe('Dependents');
  });

  it('should not include content before first heading', () => {
    const md = `Some preamble

## Module: Dev Team

Content
`;
    const sections = splitIntoSections(md, 2);
    expect(sections.length).toBe(1);
    expect(sections[0].heading).toBe('Module: Dev Team');
  });

  it('should capture lines between headings', () => {
    const md = `## Module: A

Line 1
Line 2

## Module: B

Line 3
`;
    const sections = splitIntoSections(md, 2);
    expect(sections[0].lines.some(l => l.includes('Line 1'))).toBeTruthy();
    expect(sections[0].lines.some(l => l.includes('Line 2'))).toBeTruthy();
  });

  it('should stop level 3 sections at level 2 boundaries', () => {
    const md = `### Dependencies

dep content

## Next Module

different content
`;
    const sections = splitIntoSections(md, 3);
    expect(sections.length).toBe(1);
    expect(sections[0].heading).toBe('Dependencies');
    expect(sections[0].lines.some(l => l.includes('different content'))).toBeFalsy();
  });
});

// =============================================================================
// parseHighLevelMarkdown tests
// =============================================================================

describe('parseHighLevelMarkdown', () => {
  it('should extract metadata from high-level markdown', () => {
    const md = createHighLevelMarkdown();
    const result = parseHighLevelMarkdown(md);

    expect(result.metadata.traceId).toBe('high-level');
    expect(result.metadata.traceVersion).toBe(1);
    expect(result.metadata.lastGenerated).toBe('2026-02-22T10:30:00.000Z');
    expect(result.metadata.generatedBy).toBe('trace generate');
  });

  it('should parse module dependencies', () => {
    const md = createHighLevelMarkdown();
    const result = parseHighLevelMarkdown(md);

    const devTeam = result.modules.find(m => m.id === 'dev-team');
    expect(devTeam).toBeTruthy();
    expect(devTeam.dependencies.length).toBe(1);
    expect(devTeam.dependencies[0]).toEqual({
      targetId: 'qa-team',
      relationshipType: 'publishes-to',
      description: 'Sends completed work items for QA review',
    });
  });

  it('should parse module dependents', () => {
    const md = createHighLevelMarkdown();
    const result = parseHighLevelMarkdown(md);

    const devTeam = result.modules.find(m => m.id === 'dev-team');
    expect(devTeam.dependents.length).toBe(1);
    expect(devTeam.dependents[0]).toEqual({
      targetId: 'triage-team',
      relationshipType: 'calls',
      description: 'Receives triaged work items',
    });
  });

  it('should handle modules with (none) dependencies', () => {
    const md = createHighLevelMarkdown();
    const result = parseHighLevelMarkdown(md);

    const qaTeam = result.modules.find(m => m.id === 'qa-team');
    expect(qaTeam).toBeTruthy();
    expect(qaTeam.dependencies.length).toBe(0);
    expect(qaTeam.dependents.length).toBe(0);
  });

  it('AC-10.2: should ignore Notes (not synced) section', () => {
    const md = createHighLevelMarkdown({
      notes: '\n## Notes (not synced)\n\nFreeform notes that should be ignored.\n',
    });
    const result = parseHighLevelMarkdown(md);

    // Should still parse dev-team and qa-team
    expect(result.modules.length).toBe(2);
    expect(result.errors.length).toBe(0);
  });

  it('should detect changes when dependency line is modified', () => {
    const md = createHighLevelMarkdown({
      devTeamDeps: 'knowledge-team | reads-from | Reads KB for context',
    });
    const result = parseHighLevelMarkdown(md);

    const devTeam = result.modules.find(m => m.id === 'dev-team');
    expect(devTeam.dependencies.length).toBe(1);
    expect(devTeam.dependencies[0].targetId).toBe('knowledge-team');
    expect(devTeam.dependencies[0].relationshipType).toBe('reads-from');
  });

  it('should handle multiple dependencies', () => {
    const md = createHighLevelMarkdown({
      devTeamDeps: `qa-team | publishes-to | Sends work
knowledge-team | reads-from | Reads KB`,
    });
    const result = parseHighLevelMarkdown(md);

    const devTeam = result.modules.find(m => m.id === 'dev-team');
    expect(devTeam.dependencies.length).toBe(2);
    expect(devTeam.dependencies[0].targetId).toBe('qa-team');
    expect(devTeam.dependencies[1].targetId).toBe('knowledge-team');
  });

  it('AC-10.4: should report errors for malformed dependency lines', () => {
    const md = createHighLevelMarkdown({
      devTeamDeps: 'qa-team | publishes-to',  // Missing description column
    });
    const result = parseHighLevelMarkdown(md);

    expect(result.errors.length > 0).toBeTruthy();
    expect(result.errors[0].includes('expected 3 columns')).toBeTruthy();
  });
});

// =============================================================================
// parseLowLevelMarkdown tests
// =============================================================================

describe('parseLowLevelMarkdown', () => {
  it('should extract metadata from low-level markdown', () => {
    const md = createLowLevelMarkdown();
    const result = parseLowLevelMarkdown(md);

    expect(result.metadata.traceId).toBe('dev-team');
    expect(result.metadata.traceVersion).toBe(1);
  });

  it('should parse file exports', () => {
    const md = createLowLevelMarkdown();
    const result = parseLowLevelMarkdown(md);

    expect(result.files.length).toBe(1);
    const file = result.files[0];
    expect(file.filePath).toBe('apps/agent-orchestrator/src/dev-team/service.py');
    expect(file.exports.length).toBe(2);
    expect(file.exports[0]).toEqual({ symbol: 'process_work_item', type: 'function' });
    expect(file.exports[1]).toEqual({ symbol: 'DevTeamService', type: 'class' });
  });

  it('should parse file imports with comma-separated symbols', () => {
    const md = createLowLevelMarkdown();
    const result = parseLowLevelMarkdown(md);

    const file = result.files[0];
    expect(file.imports.length).toBe(2);
    expect(file.imports[0]).toEqual({
      source: '../knowledge-team/service',
      symbols: ['KnowledgeService'],
    });
    expect(file.imports[1]).toEqual({
      source: '../common/models',
      symbols: ['WorkItem', 'Status'],
    });
  });

  it('should parse function calls', () => {
    const md = createLowLevelMarkdown();
    const result = parseLowLevelMarkdown(md);

    const file = result.files[0];
    expect(file.calls.length).toBe(1);
    expect(file.calls[0]).toEqual({
      target: 'knowledge-team/service.py',
      function: 'query_knowledge',
      context: 'process_work_item',
    });
  });

  it('should parse events', () => {
    const md = createLowLevelMarkdown();
    const result = parseLowLevelMarkdown(md);

    const file = result.files[0];
    expect(file.events.length).toBe(1);
    expect(file.events[0]).toEqual({
      type: 'publish',
      eventName: 'work.completed',
      channel: 'dev-team-output',
    });
  });

  it('AC-10.2: should ignore Notes (not synced) section', () => {
    const md = createLowLevelMarkdown({
      notes: 'These notes should be completely ignored by the sync process.',
    });
    const result = parseLowLevelMarkdown(md);

    // Should still parse the file entry correctly
    expect(result.files.length).toBe(1);
    expect(result.errors.length).toBe(0);
  });

  it('should detect modified export', () => {
    const md = createLowLevelMarkdown({
      exports: 'handle_request | function',
    });
    const result = parseLowLevelMarkdown(md);

    const file = result.files[0];
    expect(file.exports.length).toBe(1);
    expect(file.exports[0].symbol).toBe('handle_request');
  });

  it('AC-10.4: should report errors for malformed export lines', () => {
    const md = createLowLevelMarkdown({
      exports: 'only_symbol_no_pipe',
    });
    const result = parseLowLevelMarkdown(md);

    // "only_symbol_no_pipe" doesn't contain a pipe so it won't match the pipe logic
    // It should be silently skipped (no pipe = not a data line)
    expect(result.files[0].exports.length).toBe(0);
  });

  it('AC-10.4: should report error for wrong column count in exports', () => {
    const md = createLowLevelMarkdown({
      exports: 'sym | type | extra_column',
    });
    const result = parseLowLevelMarkdown(md);

    expect(result.errors.length > 0).toBeTruthy();
    expect(result.errors[0].includes('expected 2 columns')).toBeTruthy();
  });

  it('should handle (side-effect) imports', () => {
    const md = createLowLevelMarkdown({
      imports: './polyfills | (side-effect)',
    });
    const result = parseLowLevelMarkdown(md);

    const file = result.files[0];
    expect(file.imports.length).toBe(1);
    expect(file.imports[0].source).toBe('./polyfills');
    expect(file.imports[0].symbols).toEqual([]);
  });
});

// =============================================================================
// arraysDeepEqual tests
// =============================================================================

describe('arraysDeepEqual', () => {
  it('should return true for identical arrays', () => {
    const a = [{ x: 1 }, { y: 2 }];
    const b = [{ x: 1 }, { y: 2 }];
    expect(arraysDeepEqual(a, b)).toBeTruthy();
  });

  it('should return false for different arrays', () => {
    const a = [{ x: 1 }];
    const b = [{ x: 2 }];
    expect(arraysDeepEqual(a, b)).toBeFalsy();
  });

  it('should return false for different lengths', () => {
    const a = [{ x: 1 }];
    const b = [{ x: 1 }, { y: 2 }];
    expect(arraysDeepEqual(a, b)).toBeFalsy();
  });

  it('should return false for non-array inputs', () => {
    expect(arraysDeepEqual('not-array', [])).toBeFalsy();
    expect(arraysDeepEqual([], null)).toBeFalsy();
  });

  it('should return true for empty arrays', () => {
    expect(arraysDeepEqual([], [])).toBeTruthy();
  });
});

// =============================================================================
// applyHighLevelSync tests
// =============================================================================

describe('applyHighLevelSync', () => {
  it('AC-10.1: should update dependencies when markdown differs', () => {
    const json = createHighLevelJson();
    const parsedMd = {
      metadata: {},
      modules: [
        {
          id: 'dev-team',
          dependencies: [
            { targetId: 'knowledge-team', relationshipType: 'reads-from', description: 'Reads KB' },
          ],
          dependents: json.modules[0].dependents,
        },
      ],
    };

    const { updatedJson, changes } = applyHighLevelSync(json, parsedMd);

    const devTeam = updatedJson.modules.find(m => m.id === 'dev-team');
    expect(devTeam.dependencies.length).toBe(1);
    expect(devTeam.dependencies[0].targetId).toBe('knowledge-team');
    expect(changes.length > 0).toBeTruthy();
    expect(changes.some(c => c.includes('Updated') && c.includes('dependencies') && c.includes('dev-team'))).toBeTruthy();
  });

  it('AC-10.1: should update dependents when markdown differs', () => {
    const json = createHighLevelJson();
    const parsedMd = {
      metadata: {},
      modules: [
        {
          id: 'dev-team',
          dependencies: json.modules[0].dependencies,
          dependents: [
            { targetId: 'security-team', relationshipType: 'calls', description: 'Security review' },
            { targetId: 'triage-team', relationshipType: 'calls', description: 'Receives triaged work items' },
          ],
        },
      ],
    };

    const { updatedJson, changes } = applyHighLevelSync(json, parsedMd);

    const devTeam = updatedJson.modules.find(m => m.id === 'dev-team');
    expect(devTeam.dependents.length).toBe(2);
    expect(changes.some(c => c.includes('Updated') && c.includes('dependents'))).toBeTruthy();
  });

  it('should report no changes when markdown matches JSON', () => {
    const json = createHighLevelJson();
    const parsedMd = {
      metadata: {},
      modules: [
        {
          id: 'dev-team',
          dependencies: JSON.parse(JSON.stringify(json.modules[0].dependencies)),
          dependents: JSON.parse(JSON.stringify(json.modules[0].dependents)),
        },
        {
          id: 'qa-team',
          dependencies: [],
          dependents: [],
        },
      ],
    };

    const { changes } = applyHighLevelSync(json, parsedMd);
    expect(changes.length).toBe(0);
  });

  it('should skip modules not found in JSON', () => {
    const json = createHighLevelJson();
    const parsedMd = {
      metadata: {},
      modules: [
        {
          id: 'nonexistent-module',
          dependencies: [],
          dependents: [],
        },
      ],
    };

    const { changes } = applyHighLevelSync(json, parsedMd);
    expect(changes.some(c => c.includes('Skipped') && c.includes('nonexistent-module'))).toBeTruthy();
  });

  it('should not mutate original JSON', () => {
    const json = createHighLevelJson();
    const originalDepCount = json.modules[0].dependencies.length;
    const parsedMd = {
      metadata: {},
      modules: [
        {
          id: 'dev-team',
          dependencies: [],
          dependents: [],
        },
      ],
    };

    applyHighLevelSync(json, parsedMd);
    expect(json.modules[0].dependencies.length).toBe(originalDepCount);
  });
});

// =============================================================================
// applyLowLevelSync tests
// =============================================================================

describe('applyLowLevelSync', () => {
  it('should update exports when markdown differs', () => {
    const json = createLowLevelJson();
    const parsedMd = {
      metadata: {},
      files: [
        {
          filePath: 'apps/agent-orchestrator/src/dev-team/service.py',
          exports: [{ symbol: 'new_function', type: 'function' }],
          imports: json.files[0].imports,
          calls: json.files[0].calls,
          events: json.files[0].events,
        },
      ],
    };

    const { updatedJson, changes } = applyLowLevelSync(json, parsedMd);

    const file = updatedJson.files[0];
    expect(file.exports.length).toBe(1);
    expect(file.exports[0].symbol).toBe('new_function');
    expect(changes.some(c => c.includes('exports'))).toBeTruthy();
  });

  it('should update imports when markdown differs', () => {
    const json = createLowLevelJson();
    const parsedMd = {
      metadata: {},
      files: [
        {
          filePath: 'apps/agent-orchestrator/src/dev-team/service.py',
          exports: json.files[0].exports,
          imports: [{ source: 'new-source', symbols: ['NewThing'] }],
          calls: json.files[0].calls,
          events: json.files[0].events,
        },
      ],
    };

    const { updatedJson, changes } = applyLowLevelSync(json, parsedMd);
    expect(updatedJson.files[0].imports[0].source).toBe('new-source');
    expect(changes.some(c => c.includes('imports'))).toBeTruthy();
  });

  it('should update function calls when markdown differs', () => {
    const json = createLowLevelJson();
    const parsedMd = {
      metadata: {},
      files: [
        {
          filePath: 'apps/agent-orchestrator/src/dev-team/service.py',
          exports: json.files[0].exports,
          imports: json.files[0].imports,
          calls: [],
          events: json.files[0].events,
        },
      ],
    };

    const { updatedJson, changes } = applyLowLevelSync(json, parsedMd);
    expect(updatedJson.files[0].calls.length).toBe(0);
    expect(changes.some(c => c.includes('function calls'))).toBeTruthy();
  });

  it('should update events when markdown differs', () => {
    const json = createLowLevelJson();
    const parsedMd = {
      metadata: {},
      files: [
        {
          filePath: 'apps/agent-orchestrator/src/dev-team/service.py',
          exports: json.files[0].exports,
          imports: json.files[0].imports,
          calls: json.files[0].calls,
          events: [
            { type: 'subscribe', eventName: 'new.event', channel: 'new-channel' },
          ],
        },
      ],
    };

    const { updatedJson, changes } = applyLowLevelSync(json, parsedMd);
    expect(updatedJson.files[0].events[0].eventName).toBe('new.event');
    expect(changes.some(c => c.includes('events'))).toBeTruthy();
  });

  it('should skip files not found in JSON', () => {
    const json = createLowLevelJson();
    const parsedMd = {
      metadata: {},
      files: [
        {
          filePath: 'nonexistent/file.py',
          exports: [],
          imports: [],
          calls: [],
          events: [],
        },
      ],
    };

    const { changes } = applyLowLevelSync(json, parsedMd);
    expect(changes.some(c => c.includes('Skipped') && c.includes('nonexistent/file.py'))).toBeTruthy();
  });
});

// =============================================================================
// Integration Tests: syncAll
// =============================================================================

describe('syncAll integration', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = setupTestRoot();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('AC-10.1: editing a dependency in high-level.md updates high-level.json', () => {
    // Setup: write JSON and markdown
    const json = createHighLevelJson();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      JSON.stringify(json, null, 2) + '\n',
    );

    // Markdown with modified dependency (changed target from qa-team to knowledge-team)
    const md = createHighLevelMarkdown({
      devTeamDeps: 'knowledge-team | reads-from | Reads KB for context',
    });
    writeFileSync(join(testRoot, '.claude', 'traces', 'high-level.md'), md);

    // Run sync
    const result = syncAll({ projectRoot: testRoot });

    // Verify JSON was updated
    const updatedJson = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'high-level.json'), 'utf-8'),
    );
    const devTeam = updatedJson.modules.find(m => m.id === 'dev-team');
    expect(devTeam.dependencies[0].targetId).toBe('knowledge-team');
    expect(devTeam.dependencies[0].relationshipType).toBe('reads-from');
    expect(result.filesUpdated > 0).toBeTruthy();
  });

  it('AC-10.2: adding content to Notes (not synced) does not affect JSON', () => {
    const json = createHighLevelJson();
    const originalJsonStr = JSON.stringify(json, null, 2) + '\n';
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      originalJsonStr,
    );

    // Markdown identical to JSON but with notes added
    const md = createHighLevelMarkdown({
      notes: '\n## Notes (not synced)\n\nThese are my custom freeform notes that should NOT change JSON.\nMore notes here.\n',
    });
    writeFileSync(join(testRoot, '.claude', 'traces', 'high-level.md'), md);

    // Run sync
    const result = syncAll({ projectRoot: testRoot });

    // Verify JSON is unchanged
    const afterJson = readFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      'utf-8',
    );
    expect(afterJson).toBe(originalJsonStr);
    expect(result.filesUpdated).toBe(0);
  });

  it('AC-10.4: malformed markdown lines produce errors and skip bad entries', () => {
    const json = createHighLevelJson();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      JSON.stringify(json, null, 2) + '\n',
    );

    // Markdown with a malformed dependency line (missing description column)
    const md = createHighLevelMarkdown({
      devTeamDeps: 'qa-team | publishes-to',
    });
    writeFileSync(join(testRoot, '.claude', 'traces', 'high-level.md'), md);

    // Run sync
    const result = syncAll({ projectRoot: testRoot });

    // Should report errors
    expect(result.allErrors.length > 0).toBeTruthy();
    expect(result.allErrors.some(e => e.includes('expected 3 columns'))).toBeTruthy();
  });

  it('should sync low-level markdown to low-level JSON', () => {
    // Setup low-level files
    const json = createLowLevelJson();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'low-level', 'dev-team.json'),
      JSON.stringify(json, null, 2) + '\n',
    );

    // Markdown with modified export
    const md = createLowLevelMarkdown({
      exports: 'handle_request | function',
    });
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'low-level', 'dev-team.md'),
      md,
    );

    const result = syncAll({ projectRoot: testRoot });

    // Verify JSON was updated
    const updatedJson = JSON.parse(
      readFileSync(
        join(testRoot, '.claude', 'traces', 'low-level', 'dev-team.json'),
        'utf-8',
      ),
    );
    expect(updatedJson.files[0].exports.length).toBe(1);
    expect(updatedJson.files[0].exports[0].symbol).toBe('handle_request');
    expect(result.filesUpdated > 0).toBeTruthy();
    expect(result.allChanges.some(c => c.includes('dev-team'))).toBeTruthy();
  });

  it('should handle missing JSON file gracefully', () => {
    // Write a markdown file without corresponding JSON
    const md = createLowLevelMarkdown();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'low-level', 'orphan-module.md'),
      md,
    );

    const result = syncAll({ projectRoot: testRoot });

    expect(result.allErrors.some(e => e.includes('No JSON file found') && e.includes('orphan-module'))).toBeTruthy();
  });

  it('should handle empty traces directory', () => {
    // No files in traces directory
    const result = syncAll({ projectRoot: testRoot });
    expect(result.filesUpdated).toBe(0);
    expect(result.allChanges.length).toBe(0);
  });

  it('round-trip: generate markdown -> edit -> sync -> verify JSON updated', () => {
    // Step 1: Create initial JSON
    const json = createHighLevelJson();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      JSON.stringify(json, null, 2) + '\n',
    );

    // Step 2: Write initial markdown (matching JSON)
    const initialMd = createHighLevelMarkdown();
    writeFileSync(join(testRoot, '.claude', 'traces', 'high-level.md'), initialMd);

    // Step 3: Verify sync with no edits produces no changes
    const noChangeResult = syncAll({ projectRoot: testRoot });
    expect(noChangeResult.filesUpdated).toBe(0);

    // Step 4: Edit the markdown (add a new dependency)
    const editedMd = createHighLevelMarkdown({
      devTeamDeps: `qa-team | publishes-to | Sends completed work items for QA review
knowledge-team | reads-from | Reads KB for development context`,
    });
    writeFileSync(join(testRoot, '.claude', 'traces', 'high-level.md'), editedMd);

    // Step 5: Run sync again
    const syncResult = syncAll({ projectRoot: testRoot });

    // Step 6: Verify JSON was updated with the new dependency
    const updatedJson = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'high-level.json'), 'utf-8'),
    );
    const devTeam = updatedJson.modules.find(m => m.id === 'dev-team');
    expect(devTeam.dependencies.length).toBe(2);
    expect(devTeam.dependencies[1].targetId).toBe('knowledge-team');
    expect(syncResult.filesUpdated > 0).toBeTruthy();
    expect(syncResult.allChanges.some(c => c.includes('Updated 2 dependencies in dev-team'))).toBeTruthy();
  });

  it('round-trip: low-level generate -> edit -> sync -> verify', () => {
    // Step 1: Create initial low-level JSON
    const json = createLowLevelJson();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'low-level', 'dev-team.json'),
      JSON.stringify(json, null, 2) + '\n',
    );

    // Step 2: Write matching markdown
    const initialMd = createLowLevelMarkdown();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'low-level', 'dev-team.md'),
      initialMd,
    );

    // Step 3: Verify no changes initially
    const noChangeResult = syncAll({ projectRoot: testRoot });
    expect(noChangeResult.filesUpdated).toBe(0);

    // Step 4: Edit markdown - add a new event
    const editedMd = createLowLevelMarkdown({
      events: `publish | work.completed | dev-team-output
subscribe | work.assigned | triage-output`,
    });
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'low-level', 'dev-team.md'),
      editedMd,
    );

    // Step 5: Sync
    const syncResult = syncAll({ projectRoot: testRoot });

    // Step 6: Verify JSON
    const updatedJson = JSON.parse(
      readFileSync(
        join(testRoot, '.claude', 'traces', 'low-level', 'dev-team.json'),
        'utf-8',
      ),
    );
    expect(updatedJson.files[0].events.length).toBe(2);
    expect(updatedJson.files[0].events[1].eventName).toBe('work.assigned');
    expect(syncResult.filesUpdated > 0).toBeTruthy();
  });
});

// =============================================================================
// as-012: Conflict Detection Unit Tests
// =============================================================================

describe('detectHighLevelConflicts', () => {
  it('should detect dependency conflict between JSON and markdown', () => {
    const json = createHighLevelJson();
    const parsedMd = {
      modules: [
        {
          id: 'dev-team',
          dependencies: [
            { targetId: 'knowledge-team', relationshipType: 'reads-from', description: 'Reads KB' },
          ],
          dependents: json.modules[0].dependents,
        },
      ],
    };

    const conflicts = detectHighLevelConflicts(json, parsedMd);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].module).toBe('dev-team');
    expect(conflicts[0].field).toBe('dependencies');
    expect(conflicts[0].jsonValue[0].targetId).toBe('qa-team');
    expect(conflicts[0].markdownValue[0].targetId).toBe('knowledge-team');
  });

  it('should detect dependents conflict', () => {
    const json = createHighLevelJson();
    const parsedMd = {
      modules: [
        {
          id: 'dev-team',
          dependencies: json.modules[0].dependencies,
          dependents: [], // Removed all dependents in markdown
        },
      ],
    };

    const conflicts = detectHighLevelConflicts(json, parsedMd);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].field).toBe('dependents');
    expect(conflicts[0].jsonValue.length).toBe(1);
    expect(conflicts[0].markdownValue.length).toBe(0);
  });

  it('should return empty array when no conflicts', () => {
    const json = createHighLevelJson();
    const parsedMd = {
      modules: [
        {
          id: 'dev-team',
          dependencies: JSON.parse(JSON.stringify(json.modules[0].dependencies)),
          dependents: JSON.parse(JSON.stringify(json.modules[0].dependents)),
        },
      ],
    };

    const conflicts = detectHighLevelConflicts(json, parsedMd);
    expect(conflicts.length).toBe(0);
  });

  it('should skip modules not in JSON', () => {
    const json = createHighLevelJson();
    const parsedMd = {
      modules: [
        {
          id: 'nonexistent-module',
          dependencies: [{ targetId: 'x', relationshipType: 'y', description: 'z' }],
          dependents: [],
        },
      ],
    };

    const conflicts = detectHighLevelConflicts(json, parsedMd);
    expect(conflicts.length).toBe(0);
  });
});

describe('detectLowLevelConflicts', () => {
  it('should detect export conflict', () => {
    const json = createLowLevelJson();
    const parsedMd = {
      files: [
        {
          filePath: 'apps/agent-orchestrator/src/dev-team/service.py',
          exports: [{ symbol: 'new_function', type: 'function' }],
          imports: json.files[0].imports,
          calls: json.files[0].calls,
          events: json.files[0].events,
        },
      ],
    };

    const conflicts = detectLowLevelConflicts(json, parsedMd);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].field).toBe('exports');
    expect(conflicts[0].module).toBe('apps/agent-orchestrator/src/dev-team/service.py');
  });

  it('should detect multiple field conflicts for same file', () => {
    const json = createLowLevelJson();
    const parsedMd = {
      files: [
        {
          filePath: 'apps/agent-orchestrator/src/dev-team/service.py',
          exports: [{ symbol: 'changed', type: 'function' }],
          imports: [{ source: 'changed-source', symbols: ['Changed'] }],
          calls: json.files[0].calls,
          events: json.files[0].events,
        },
      ],
    };

    const conflicts = detectLowLevelConflicts(json, parsedMd);
    expect(conflicts.length).toBe(2);
    expect(conflicts.some(c => c.field === 'exports')).toBeTruthy();
    expect(conflicts.some(c => c.field === 'imports')).toBeTruthy();
  });

  it('should return empty when no conflicts', () => {
    const json = createLowLevelJson();
    const parsedMd = {
      files: [
        {
          filePath: 'apps/agent-orchestrator/src/dev-team/service.py',
          exports: JSON.parse(JSON.stringify(json.files[0].exports)),
          imports: JSON.parse(JSON.stringify(json.files[0].imports)),
          calls: JSON.parse(JSON.stringify(json.files[0].calls)),
          events: JSON.parse(JSON.stringify(json.files[0].events)),
        },
      ],
    };

    const conflicts = detectLowLevelConflicts(json, parsedMd);
    expect(conflicts.length).toBe(0);
  });
});

// =============================================================================
// as-012: jsonDivergedFromMarkdown Tests
// =============================================================================

describe('jsonDivergedFromMarkdown', () => {
  it('should return false when timestamps match', () => {
    expect(jsonDivergedFromMarkdown('2026-02-22T10:30:00.000Z', '2026-02-22T10:30:00.000Z')).toBe(false);
  });

  it('should return true when timestamps differ', () => {
    expect(jsonDivergedFromMarkdown('2026-02-23T10:30:00.000Z', '2026-02-22T10:30:00.000Z')).toBe(true);
  });

  it('should return false when JSON lastGenerated is null', () => {
    expect(jsonDivergedFromMarkdown(null, '2026-02-22T10:30:00.000Z')).toBe(false);
  });

  it('should return false when markdown lastGenerated is null', () => {
    expect(jsonDivergedFromMarkdown('2026-02-22T10:30:00.000Z', null)).toBe(false);
  });

  it('should return false when both are null', () => {
    expect(jsonDivergedFromMarkdown(null, null)).toBe(false);
  });
});

// =============================================================================
// as-012: formatConflictReport Tests
// =============================================================================

describe('formatConflictReport', () => {
  it('should format conflicts with both values', () => {
    const conflicts = [
      {
        module: 'dev-team',
        field: 'dependencies',
        jsonValue: [{ targetId: 'qa-team' }],
        markdownValue: [{ targetId: 'knowledge-team' }],
      },
    ];

    const lines = formatConflictReport(conflicts);
    expect(lines.some(l => l.includes('CONFLICT: dev-team -> dependencies'))).toBeTruthy();
    expect(lines.some(l => l.includes('JSON value:') && l.includes('qa-team'))).toBeTruthy();
    expect(lines.some(l => l.includes('Markdown value:') && l.includes('knowledge-team'))).toBeTruthy();
  });

  it('should format multiple conflicts', () => {
    const conflicts = [
      { module: 'mod-a', field: 'deps', jsonValue: [], markdownValue: [1] },
      { module: 'mod-b', field: 'exports', jsonValue: [2], markdownValue: [] },
    ];

    const lines = formatConflictReport(conflicts);
    expect(lines.some(l => l.includes('mod-a -> deps'))).toBeTruthy();
    expect(lines.some(l => l.includes('mod-b -> exports'))).toBeTruthy();
  });

  it('should return empty array for no conflicts', () => {
    const lines = formatConflictReport([]);
    expect(lines.length).toBe(0);
  });
});

// =============================================================================
// as-012: buildSyncSummary Tests
// =============================================================================

describe('buildSyncSummary', () => {
  it('AC-10.3: should include modules updated, fields changed, conflicts, errors', () => {
    const summary = buildSyncSummary({
      changes: [
        'Updated 2 dependencies in dev-team (was 1)',
        '[dev-team] Updated exports in apps/dev-team/service.py',
      ],
      errors: ['Some parsing error'],
      conflicts: [{ module: 'qa-team', field: 'deps' }],
      filesUpdated: 2,
      dryRun: false,
    });

    expect(summary.text.includes('Modules updated:')).toBeTruthy();
    expect(summary.text.includes('Fields changed:')).toBeTruthy();
    expect(summary.text.includes('Conflicts detected:')).toBeTruthy();
    expect(summary.text.includes('Parsing errors:')).toBeTruthy();
    expect(summary.fieldsChanged).toBe(2);
    expect(summary.conflictsDetected).toBe(1);
    expect(summary.errorsEncountered).toBe(1);
  });

  it('should show per-module field counts', () => {
    const summary = buildSyncSummary({
      changes: [
        'Updated 1 dependencies in dev-team (was 0)',
        'Updated 1 dependents in dev-team (was 0)',
      ],
      errors: [],
      conflicts: [],
      filesUpdated: 1,
      dryRun: false,
    });

    expect(summary.text.includes('dev-team:')).toBeTruthy();
    expect(summary.text.includes('2 field(s)')).toBeTruthy();
  });

  it('should prefix with [DRY RUN] when dryRun is true', () => {
    const summary = buildSyncSummary({
      changes: [],
      errors: [],
      conflicts: [],
      filesUpdated: 0,
      dryRun: true,
    });

    expect(summary.text.startsWith('[DRY RUN]')).toBeTruthy();
  });

  it('should handle zero changes gracefully', () => {
    const summary = buildSyncSummary({
      changes: [],
      errors: [],
      conflicts: [],
      filesUpdated: 0,
      dryRun: false,
    });

    expect(summary.modulesUpdated).toBe(0);
    expect(summary.fieldsChanged).toBe(0);
    expect(summary.conflictsDetected).toBe(0);
    expect(summary.errorsEncountered).toBe(0);
  });

  it('should not count Skipped entries as fields changed', () => {
    const summary = buildSyncSummary({
      changes: [
        'Skipped module "nonexistent" (not found in JSON)',
        'Updated 1 dependencies in dev-team (was 0)',
      ],
      errors: [],
      conflicts: [],
      filesUpdated: 1,
      dryRun: false,
    });

    expect(summary.fieldsChanged).toBe(1);
  });
});

// =============================================================================
// as-012: parseCliArgs Tests
// =============================================================================

describe('parseCliArgs', () => {
  it('should parse --force flag', () => {
    const result = parseCliArgs(['node', 'trace-sync.mjs', '--force']);
    expect(result.force).toBe(true);
    expect(result.dryRun).toBe(false);
  });

  it('should parse --dry-run flag', () => {
    const result = parseCliArgs(['node', 'trace-sync.mjs', '--dry-run']);
    expect(result.force).toBe(false);
    expect(result.dryRun).toBe(true);
  });

  it('should parse both flags', () => {
    const result = parseCliArgs(['node', 'trace-sync.mjs', '--force', '--dry-run']);
    expect(result.force).toBe(true);
    expect(result.dryRun).toBe(true);
  });

  it('should default to false when no flags', () => {
    const result = parseCliArgs(['node', 'trace-sync.mjs']);
    expect(result.force).toBe(false);
    expect(result.dryRun).toBe(false);
  });
});

// =============================================================================
// as-012: Conflict Detection Integration Tests
// =============================================================================

describe('syncAll conflict detection integration', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = setupTestRoot();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('AC-10.5: detects conflict when JSON was regenerated with different data', () => {
    // Setup: JSON has lastGenerated = T1
    const json = createHighLevelJson();
    json.lastGenerated = '2026-02-23T12:00:00.000Z';
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      JSON.stringify(json, null, 2) + '\n',
    );

    // Markdown has lastGenerated = T0 (older) and different deps
    const md = createHighLevelMarkdown({
      devTeamDeps: 'knowledge-team | reads-from | Reads KB for context',
    });
    // The default markdown has lastGenerated = 2026-02-22T10:30:00.000Z (T0)
    writeFileSync(join(testRoot, '.claude', 'traces', 'high-level.md'), md);

    // Run sync without --force
    const result = syncAll({ projectRoot: testRoot });

    // Should detect conflict
    expect(result.allConflicts.length > 0).toBeTruthy();
    expect(result.allConflicts.some(c => c.module === 'dev-team')).toBeTruthy();
    expect(result.allConflicts.some(c => c.field === 'dependencies')).toBeTruthy();

    // JSON should NOT be modified (conflict prevents overwrite)
    const afterJson = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'high-level.json'), 'utf-8'),
    );
    expect(afterJson.modules[0].dependencies[0].targetId).toBe('qa-team');
  });

  it('AC-10.5: conflict report includes both JSON and markdown values', () => {
    const json = createHighLevelJson();
    json.lastGenerated = '2026-02-23T12:00:00.000Z'; // Newer than markdown
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      JSON.stringify(json, null, 2) + '\n',
    );

    const md = createHighLevelMarkdown({
      devTeamDeps: 'knowledge-team | reads-from | Reads KB',
    });
    writeFileSync(join(testRoot, '.claude', 'traces', 'high-level.md'), md);

    const result = syncAll({ projectRoot: testRoot });

    // Verify conflict contains both values
    const depConflict = result.allConflicts.find(c => c.field === 'dependencies');
    expect(depConflict).toBeTruthy();
    expect(depConflict.jsonValue[0].targetId).toBe('qa-team');
    expect(depConflict.markdownValue[0].targetId).toBe('knowledge-team');
  });

  it('--force overrides conflicts (markdown wins)', () => {
    // Setup: JSON has newer lastGenerated
    const json = createHighLevelJson();
    json.lastGenerated = '2026-02-23T12:00:00.000Z';
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      JSON.stringify(json, null, 2) + '\n',
    );

    // Markdown with different deps
    const md = createHighLevelMarkdown({
      devTeamDeps: 'knowledge-team | reads-from | Reads KB for context',
    });
    writeFileSync(join(testRoot, '.claude', 'traces', 'high-level.md'), md);

    // Run sync WITH --force
    const result = syncAll({ projectRoot: testRoot, force: true });

    // Should have no conflicts reported (force bypasses detection)
    expect(result.allConflicts.length).toBe(0);

    // JSON should be updated (markdown wins)
    const afterJson = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'high-level.json'), 'utf-8'),
    );
    expect(afterJson.modules[0].dependencies[0].targetId).toBe('knowledge-team');
    expect(result.filesUpdated > 0).toBeTruthy();
  });

  it('--dry-run shows changes without writing', () => {
    const json = createHighLevelJson();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      JSON.stringify(json, null, 2) + '\n',
    );

    // Markdown with different deps (same lastGenerated = no conflict, just change)
    const md = createHighLevelMarkdown({
      devTeamDeps: 'knowledge-team | reads-from | Reads KB for context',
    });
    writeFileSync(join(testRoot, '.claude', 'traces', 'high-level.md'), md);

    const originalJsonStr = readFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'), 'utf-8',
    );

    // Run sync with --dry-run
    const result = syncAll({ projectRoot: testRoot, dryRun: true });

    // Should report changes
    expect(result.allChanges.length > 0).toBeTruthy();
    expect(result.filesUpdated > 0).toBeTruthy();

    // JSON should NOT be written
    const afterJsonStr = readFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'), 'utf-8',
    );
    expect(afterJsonStr).toBe(originalJsonStr);
  });

  it('--dry-run shows summary with DRY RUN prefix', () => {
    const json = createHighLevelJson();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      JSON.stringify(json, null, 2) + '\n',
    );

    const md = createHighLevelMarkdown({
      devTeamDeps: 'knowledge-team | reads-from | Reads KB',
    });
    writeFileSync(join(testRoot, '.claude', 'traces', 'high-level.md'), md);

    const result = syncAll({ projectRoot: testRoot, dryRun: true });
    expect(result.summary.text.startsWith('[DRY RUN]')).toBeTruthy();
  });

  it('no conflict when lastGenerated timestamps match (normal edit scenario)', () => {
    // Both JSON and markdown have same lastGenerated
    const json = createHighLevelJson();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      JSON.stringify(json, null, 2) + '\n',
    );

    // Markdown with different deps but same lastGenerated
    const md = createHighLevelMarkdown({
      devTeamDeps: 'knowledge-team | reads-from | Reads KB for context',
    });
    writeFileSync(join(testRoot, '.claude', 'traces', 'high-level.md'), md);

    const result = syncAll({ projectRoot: testRoot });

    // Should have NO conflicts (same lastGenerated = markdown was just edited)
    expect(result.allConflicts.length).toBe(0);

    // JSON should be updated normally
    const afterJson = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'high-level.json'), 'utf-8'),
    );
    expect(afterJson.modules[0].dependencies[0].targetId).toBe('knowledge-team');
  });

  it('low-level conflict detection works for diverged timestamps', () => {
    // Setup: low-level JSON with newer lastGenerated
    const json = createLowLevelJson();
    json.lastGenerated = '2026-02-23T12:00:00.000Z'; // Newer
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'low-level', 'dev-team.json'),
      JSON.stringify(json, null, 2) + '\n',
    );

    // Markdown with different exports (default lastGenerated = T0, older)
    const md = createLowLevelMarkdown({
      exports: 'new_function | function',
    });
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'low-level', 'dev-team.md'),
      md,
    );

    const result = syncAll({ projectRoot: testRoot });

    // Should detect conflict
    expect(result.allConflicts.length > 0).toBeTruthy();

    // JSON should NOT be modified
    const afterJson = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'low-level', 'dev-team.json'), 'utf-8'),
    );
    expect(afterJson.files[0].exports.length).toBe(2);
  });

  it('AC-10.3: sync produces summary with correct counts', () => {
    const json = createHighLevelJson();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      JSON.stringify(json, null, 2) + '\n',
    );

    const md = createHighLevelMarkdown({
      devTeamDeps: `qa-team | publishes-to | Sends completed work items for QA review
knowledge-team | reads-from | Reads KB for context`,
    });
    writeFileSync(join(testRoot, '.claude', 'traces', 'high-level.md'), md);

    const result = syncAll({ projectRoot: testRoot });

    expect(result.summary).toBeTruthy();
    expect(result.summary.text.includes('Modules updated:')).toBeTruthy();
    expect(result.summary.text.includes('Fields changed:')).toBeTruthy();
    expect(result.summary.text.includes('Conflicts detected:')).toBeTruthy();
    expect(result.summary.text.includes('Parsing errors:')).toBeTruthy();
    expect(result.summary.conflictsDetected).toBe(0);
    expect(result.summary.fieldsChanged > 0).toBeTruthy();
  });

  it('AC-10.3: summary includes parsing error count', () => {
    const json = createHighLevelJson();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      JSON.stringify(json, null, 2) + '\n',
    );

    // Markdown with malformed line (wrong column count)
    const md = createHighLevelMarkdown({
      devTeamDeps: 'qa-team | publishes-to',  // Missing description column
    });
    writeFileSync(join(testRoot, '.claude', 'traces', 'high-level.md'), md);

    const result = syncAll({ projectRoot: testRoot });

    expect(result.summary.errorsEncountered > 0).toBeTruthy();
  });

  it('force + dry-run: shows changes without writing despite conflicts', () => {
    const json = createHighLevelJson();
    json.lastGenerated = '2026-02-23T12:00:00.000Z';
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      JSON.stringify(json, null, 2) + '\n',
    );

    const md = createHighLevelMarkdown({
      devTeamDeps: 'knowledge-team | reads-from | Reads KB',
    });
    writeFileSync(join(testRoot, '.claude', 'traces', 'high-level.md'), md);

    const originalJsonStr = readFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'), 'utf-8',
    );

    const result = syncAll({ projectRoot: testRoot, force: true, dryRun: true });

    // Force bypasses conflict, dry-run prevents writing
    expect(result.allConflicts.length).toBe(0);
    expect(result.allChanges.length > 0).toBeTruthy();

    // JSON should NOT be written
    const afterJsonStr = readFileSync(
      join(testRoot, '.claude', 'traces', 'high-level.json'), 'utf-8',
    );
    expect(afterJsonStr).toBe(originalJsonStr);
  });
});

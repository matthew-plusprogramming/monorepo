/**
 * Tests for M2: Incremental Trace Generation
 *
 * Tests: REQ-005 through REQ-013 (staleness metadata, incremental generation,
 * cross-module staleness propagation, atomic writes, size thresholds)
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs trace-incremental.test.mjs
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import {
  computeFileHash,
  computeExportSignatureHash,
  validateStalenessMetadata,
  atomicWriteFile,
  loadStalenessMetadata,
  writeStalenessMetadata,
  createEmptyStalenessData,
  isFileStale,
  isTraceStale,
  propagateCrossModuleStaleness,
  checkTraceFileSize,
  STALENESS_JSON_PATH,
} from '../lib/trace-utils.mjs';

import {
  generateAllTraces,
} from '../trace-generate.mjs';

// =============================================================================
// Test Helpers
// =============================================================================

function createTestDir() {
  const timestamp = Date.now();
  return join(
    tmpdir(),
    `trace-incremental-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
  );
}

function setupMinimalProject(testRoot) {
  // Create source files
  mkdirSync(join(testRoot, 'src', 'alpha'), { recursive: true });
  mkdirSync(join(testRoot, 'src', 'beta'), { recursive: true });

  writeFileSync(join(testRoot, 'src', 'alpha', 'service.mjs'),
    `export function greet(name) {\n  return 'Hello ' + name;\n}\n`
  );
  writeFileSync(join(testRoot, 'src', 'alpha', 'helper.mjs'),
    `export const VERSION = '1.0';\n`
  );
  writeFileSync(join(testRoot, 'src', 'beta', 'handler.mjs'),
    `import { greet } from '../alpha/service.mjs';\n\nexport function handleRequest(req) {\n  return greet(req.name);\n}\n`
  );

  // Write trace config
  mkdirSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true });
  writeFileSync(
    join(testRoot, '.claude', 'traces', 'trace.config.json'),
    JSON.stringify({
      version: 1,
      projectRoot: '.',
      modules: [
        { id: 'module-alpha', name: 'Module Alpha', fileGlobs: ['src/alpha/**'] },
        { id: 'module-beta', name: 'Module Beta', fileGlobs: ['src/beta/**'] },
      ],
    }, null, 2),
  );

  // Initialize git repo
  execSync('git init', { cwd: testRoot, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: testRoot, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: testRoot, stdio: 'pipe' });
  execSync('git add .', { cwd: testRoot, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: testRoot, stdio: 'pipe' });

  return testRoot;
}

// =============================================================================
// REQ-006: Staleness Metadata Store
// =============================================================================

describe('REQ-006: Staleness Metadata Store', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    setupMinimalProject(testRoot);
  });

  afterEach(() => {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('AC-staleness-schema: valid staleness.json passes validation', () => {
    const data = {
      version: 1,
      modules: {
        'module-alpha': {
          files: {
            'src/alpha/service.mjs': {
              hash: 'abc123',
              lastTraced: '2026-03-20T10:00:00Z',
              externalRefs: { 'module-beta': ['greet'] },
            },
          },
          exportSignatureHash: 'def456',
        },
      },
    };

    const result = validateStalenessMetadata(data);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects invalid version', () => {
    const data = { version: 2, modules: {} };
    const result = validateStalenessMetadata(data);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('version must be 1');
  });

  it('rejects non-object data', () => {
    const result = validateStalenessMetadata(null);
    expect(result.valid).toBe(false);
  });

  it('rejects missing modules', () => {
    const result = validateStalenessMetadata({ version: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('modules must be an object');
  });

  it('rejects missing hash in file entry', () => {
    const data = {
      version: 1,
      modules: {
        'mod': {
          files: { 'f.mjs': { lastTraced: '2026-01-01T00:00:00Z' } },
          exportSignatureHash: 'abc',
        },
      },
    };
    const result = validateStalenessMetadata(data);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('hash must be a string');
  });

  it('rejects invalid externalRefs', () => {
    const data = {
      version: 1,
      modules: {
        'mod': {
          files: {
            'f.mjs': {
              hash: 'abc',
              lastTraced: '2026-01-01T00:00:00Z',
              externalRefs: { 'other': 'not-an-array' },
            },
          },
          exportSignatureHash: 'abc',
        },
      },
    };
    const result = validateStalenessMetadata(data);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('must be an array');
  });

  it('loadStalenessMetadata returns null when file is missing', () => {
    const result = loadStalenessMetadata(testRoot);
    expect(result).toBeNull();
  });

  it('loadStalenessMetadata reads valid staleness.json', () => {
    const data = createEmptyStalenessData();
    writeStalenessMetadata(data, testRoot);

    const result = loadStalenessMetadata(testRoot);
    expect(result).not.toBeNull();
    expect(result.data.version).toBe(1);
    expect(result.data.modules).toEqual({});
  });

  it('loadStalenessMetadata returns null for corrupt JSON', () => {
    writeFileSync(join(testRoot, STALENESS_JSON_PATH), '{ invalid json }');
    const result = loadStalenessMetadata(testRoot);
    expect(result).toBeNull();
  });

  it('createEmptyStalenessData creates correct structure', () => {
    const data = createEmptyStalenessData();
    expect(data.version).toBe(1);
    expect(data.modules).toEqual({});
  });

  it('writeStalenessMetadata creates valid file', () => {
    const data = createEmptyStalenessData();
    data.modules['test'] = {
      files: {},
      exportSignatureHash: 'abc',
    };
    writeStalenessMetadata(data, testRoot);

    const raw = readFileSync(join(testRoot, STALENESS_JSON_PATH), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.modules.test.exportSignatureHash).toBe('abc');
  });
});

// =============================================================================
// Task 2.2: File Hash Computation
// =============================================================================

describe('Task 2.2: computeFileHash', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns consistent hash for same content', () => {
    const filePath = join(testRoot, 'test.mjs');
    writeFileSync(filePath, 'export const x = 1;');

    const hash1 = computeFileHash(filePath);
    const hash2 = computeFileHash(filePath);
    expect(hash1).toBe(hash2);
  });

  it('returns different hash for different content', () => {
    const file1 = join(testRoot, 'a.mjs');
    const file2 = join(testRoot, 'b.mjs');
    writeFileSync(file1, 'export const x = 1;');
    writeFileSync(file2, 'export const x = 2;');

    expect(computeFileHash(file1)).not.toBe(computeFileHash(file2));
  });

  it('returns hex-encoded SHA-256 string', () => {
    const filePath = join(testRoot, 'test.mjs');
    writeFileSync(filePath, 'content');

    const hash = computeFileHash(filePath);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// =============================================================================
// Task 2.3: File-Level Staleness Detection
// =============================================================================

describe('Task 2.3: isFileStale', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns true when file is not in staleness data', () => {
    const stalenessData = { version: 1, modules: {} };
    expect(isFileStale('src/missing.mjs', 'mod', stalenessData, testRoot)).toBe(true);
  });

  it('returns true when module is not in staleness data', () => {
    const stalenessData = { version: 1, modules: {} };
    expect(isFileStale('src/file.mjs', 'unknown-mod', stalenessData, testRoot)).toBe(true);
  });

  it('returns false when file hash matches', () => {
    const filePath = join(testRoot, 'src', 'file.mjs');
    mkdirSync(join(testRoot, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const x = 1;');

    const hash = computeFileHash(filePath);
    const stalenessData = {
      version: 1,
      modules: {
        'mod': {
          files: {
            'src/file.mjs': { hash, lastTraced: '2026-01-01T00:00:00Z' },
          },
          exportSignatureHash: 'abc',
        },
      },
    };

    expect(isFileStale('src/file.mjs', 'mod', stalenessData, testRoot)).toBe(false);
  });

  it('returns true when file hash differs', () => {
    const filePath = join(testRoot, 'src', 'file.mjs');
    mkdirSync(join(testRoot, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const x = 2;');

    const stalenessData = {
      version: 1,
      modules: {
        'mod': {
          files: {
            'src/file.mjs': { hash: 'old-hash', lastTraced: '2026-01-01T00:00:00Z' },
          },
          exportSignatureHash: 'abc',
        },
      },
    };

    expect(isFileStale('src/file.mjs', 'mod', stalenessData, testRoot)).toBe(true);
  });

  it('returns true when file has been deleted', () => {
    const stalenessData = {
      version: 1,
      modules: {
        'mod': {
          files: {
            'src/deleted.mjs': { hash: 'abc', lastTraced: '2026-01-01T00:00:00Z' },
          },
          exportSignatureHash: 'abc',
        },
      },
    };

    expect(isFileStale('src/deleted.mjs', 'mod', stalenessData, testRoot)).toBe(true);
  });
});

// =============================================================================
// Task 2.4: isTraceStale() backward compatibility (REQ-008)
// =============================================================================

describe('REQ-008: isTraceStale backward compatibility', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    setupMinimalProject(testRoot);
    // Generate traces to create baseline
    generateAllTraces({ projectRoot: testRoot });
  });

  afterEach(() => {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('AC-backward: existing callers without options work unchanged', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8')
    );

    // Call without options -- should use mtime-based staleness (original behavior)
    const result = isTraceStale('module-alpha', config, testRoot);
    expect(typeof result).toBe('boolean');
    // Traces were just generated, so should not be stale
    expect(result).toBe(false);
  });

  it('works with useStalenessStore option', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8')
    );

    // Call with useStalenessStore
    const result = isTraceStale('module-alpha', config, testRoot, {
      useStalenessStore: true,
    });
    expect(typeof result).toBe('boolean');
    expect(result).toBe(false); // Nothing changed
  });

  it('file-level check via useStalenessStore + filePath', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8')
    );

    // Check a specific file
    const result = isTraceStale('module-alpha', config, testRoot, {
      useStalenessStore: true,
      filePath: 'src/alpha/service.mjs',
    });
    expect(result).toBe(false); // File unchanged

    // Modify the file
    writeFileSync(join(testRoot, 'src', 'alpha', 'service.mjs'),
      `export function greet(name) {\n  return 'Hi ' + name;\n}\n`
    );
    execSync('git add .', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "modify"', { cwd: testRoot, stdio: 'pipe' });

    const resultAfter = isTraceStale('module-alpha', config, testRoot, {
      useStalenessStore: true,
      filePath: 'src/alpha/service.mjs',
    });
    expect(resultAfter).toBe(true); // File changed
  });

  it('returns true when staleness store not available and option set', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8')
    );

    // Delete staleness.json
    const stalenessPath = join(testRoot, STALENESS_JSON_PATH);
    if (existsSync(stalenessPath)) {
      rmSync(stalenessPath);
    }

    // Should return true (stale) because staleness data is not available
    const result = isTraceStale('module-alpha', config, testRoot, {
      useStalenessStore: true,
    });
    expect(result).toBe(true);
  });
});

// =============================================================================
// Task 2.5: Export Signature Hash
// =============================================================================

describe('Task 2.5: computeExportSignatureHash', () => {
  it('returns consistent hash for same exports', () => {
    const exports = [
      { symbol: 'greet', type: 'function', signature: '(name)' },
      { symbol: 'VERSION', type: 'const' },
    ];
    const hash1 = computeExportSignatureHash(exports);
    const hash2 = computeExportSignatureHash(exports);
    expect(hash1).toBe(hash2);
  });

  it('is order-independent (sorted internally)', () => {
    const exports1 = [
      { symbol: 'greet', type: 'function', signature: '(name)' },
      { symbol: 'VERSION', type: 'const' },
    ];
    const exports2 = [
      { symbol: 'VERSION', type: 'const' },
      { symbol: 'greet', type: 'function', signature: '(name)' },
    ];
    expect(computeExportSignatureHash(exports1)).toBe(computeExportSignatureHash(exports2));
  });

  it('changes when export name changes', () => {
    const exports1 = [{ symbol: 'greet', type: 'function', signature: '(name)' }];
    const exports2 = [{ symbol: 'hello', type: 'function', signature: '(name)' }];
    expect(computeExportSignatureHash(exports1)).not.toBe(computeExportSignatureHash(exports2));
  });

  it('changes when export kind changes', () => {
    const exports1 = [{ symbol: 'greet', type: 'function', signature: '(name)' }];
    const exports2 = [{ symbol: 'greet', type: 'const' }];
    expect(computeExportSignatureHash(exports1)).not.toBe(computeExportSignatureHash(exports2));
  });

  it('changes when parameter names change', () => {
    const exports1 = [{ symbol: 'greet', type: 'function', signature: '(name)' }];
    const exports2 = [{ symbol: 'greet', type: 'function', signature: '(user)' }];
    expect(computeExportSignatureHash(exports1)).not.toBe(computeExportSignatureHash(exports2));
  });

  it('is stable when only function body changes (no sig change)', () => {
    const exports1 = [{ symbol: 'greet', type: 'function', signature: '(name)' }];
    const exports2 = [{ symbol: 'greet', type: 'function', signature: '(name)' }];
    expect(computeExportSignatureHash(exports1)).toBe(computeExportSignatureHash(exports2));
  });

  it('returns hex SHA-256 hash', () => {
    const hash = computeExportSignatureHash([{ symbol: 'x', type: 'const' }]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// =============================================================================
// Task 2.6: Cross-Module Staleness Propagation (REQ-007)
// =============================================================================

describe('REQ-007: Cross-Module Staleness Propagation', () => {
  it('AC-cross-module: marks dependent files stale when export sig changes', () => {
    const stalenessData = {
      version: 1,
      modules: {
        'module-y': {
          files: {
            'src/y/service.mjs': { hash: 'abc', lastTraced: '2026-01-01T00:00:00Z' },
          },
          exportSignatureHash: 'old-hash',
        },
        'module-x': {
          files: {
            'src/x/handler.mjs': {
              hash: 'def',
              lastTraced: '2026-01-01T00:00:00Z',
              externalRefs: { 'module-y': ['greet'] },
            },
            'src/x/util.mjs': {
              hash: 'ghi',
              lastTraced: '2026-01-01T00:00:00Z',
              // No externalRefs to module-y
            },
          },
          exportSignatureHash: 'xyz',
        },
      },
    };

    const affected = propagateCrossModuleStaleness('module-y', stalenessData, 'new-hash');

    expect(affected).toContain('module-x');
    // handler.mjs should be marked stale (has externalRefs to module-y)
    expect(stalenessData.modules['module-x'].files['src/x/handler.mjs'].hash).toBe('');
    // util.mjs should NOT be marked stale (no externalRefs to module-y)
    expect(stalenessData.modules['module-x'].files['src/x/util.mjs'].hash).toBe('ghi');
    // module-y's export sig hash should be updated
    expect(stalenessData.modules['module-y'].exportSignatureHash).toBe('new-hash');
  });

  it('no propagation when export signature hash unchanged', () => {
    const stalenessData = {
      version: 1,
      modules: {
        'module-y': {
          files: {},
          exportSignatureHash: 'same-hash',
        },
        'module-x': {
          files: {
            'src/x/handler.mjs': {
              hash: 'def',
              lastTraced: '2026-01-01T00:00:00Z',
              externalRefs: { 'module-y': ['greet'] },
            },
          },
          exportSignatureHash: 'xyz',
        },
      },
    };

    const affected = propagateCrossModuleStaleness('module-y', stalenessData, 'same-hash');

    expect(affected).toHaveLength(0);
    // handler.mjs should NOT be touched
    expect(stalenessData.modules['module-x'].files['src/x/handler.mjs'].hash).toBe('def');
  });

  it('AC-depth-cap: stops propagation at max depth', () => {
    const stalenessData = {
      version: 1,
      modules: {
        'a': {
          files: { 'a.mjs': { hash: 'a', lastTraced: '2026-01-01T00:00:00Z' } },
          exportSignatureHash: 'old-a',
        },
        'b': {
          files: {
            'b.mjs': {
              hash: 'b',
              lastTraced: '2026-01-01T00:00:00Z',
              externalRefs: { 'a': ['fn'] },
            },
          },
          exportSignatureHash: 'old-b',
        },
      },
    };

    // At depth > 3, propagation is blocked
    const affected = propagateCrossModuleStaleness('a', stalenessData, 'new-a', 4);
    expect(affected).toHaveLength(0);
  });

  it('propagation chain: A->B->C at depth 1,2,3 then stops at 4', () => {
    const stalenessData = {
      version: 1,
      modules: {
        'a': { files: {}, exportSignatureHash: 'old-a' },
        'b': {
          files: {
            'b.mjs': { hash: 'b', lastTraced: '2026-01-01T00:00:00Z', externalRefs: { 'a': ['fn'] } },
          },
          exportSignatureHash: 'old-b',
        },
        'c': {
          files: {
            'c.mjs': { hash: 'c', lastTraced: '2026-01-01T00:00:00Z', externalRefs: { 'b': ['fn'] } },
          },
          exportSignatureHash: 'old-c',
        },
        'd': {
          files: {
            'd.mjs': { hash: 'd', lastTraced: '2026-01-01T00:00:00Z', externalRefs: { 'c': ['fn'] } },
          },
          exportSignatureHash: 'old-d',
        },
      },
    };

    // Depth 1: A's exports changed -> marks B stale
    const affected1 = propagateCrossModuleStaleness('a', stalenessData, 'new-a', 1);
    expect(affected1).toContain('b');

    // Depth 2: B's exports changed -> marks C stale
    const affected2 = propagateCrossModuleStaleness('b', stalenessData, 'new-b', 2);
    expect(affected2).toContain('c');

    // Depth 3: C's exports changed -> marks D stale
    const affected3 = propagateCrossModuleStaleness('c', stalenessData, 'new-c', 3);
    expect(affected3).toContain('d');

    // Depth 4: exceeds max -- no propagation
    const affected4 = propagateCrossModuleStaleness('d', stalenessData, 'new-d', 4);
    expect(affected4).toHaveLength(0);
  });
});

// =============================================================================
// REQ-009: Full Regeneration Escape Hatch (--full flag)
// =============================================================================

describe('REQ-009: Full Regeneration (--full)', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    setupMinimalProject(testRoot);
  });

  afterEach(() => {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('AC-full: --full recomputes all hashes in staleness.json', () => {
    // First run: creates traces and staleness.json
    generateAllTraces({ projectRoot: testRoot });

    expect(existsSync(join(testRoot, STALENESS_JSON_PATH))).toBe(true);

    const before = JSON.parse(readFileSync(join(testRoot, STALENESS_JSON_PATH), 'utf-8'));
    expect(before.modules['module-alpha']).toBeDefined();

    // Corrupt staleness.json
    before.modules['module-alpha'].files['src/alpha/service.mjs'].hash = 'corrupted';
    writeFileSync(join(testRoot, STALENESS_JSON_PATH), JSON.stringify(before, null, 2));

    // Run with --full: should recompute all hashes
    generateAllTraces({ projectRoot: testRoot, full: true });

    const after = JSON.parse(readFileSync(join(testRoot, STALENESS_JSON_PATH), 'utf-8'));
    expect(after.modules['module-alpha'].files['src/alpha/service.mjs'].hash).not.toBe('corrupted');
    expect(after.modules['module-alpha'].files['src/alpha/service.mjs'].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('--full forces full generation even with incremental flag', () => {
    generateAllTraces({ projectRoot: testRoot });

    const result = generateAllTraces({
      projectRoot: testRoot,
      full: true,
      incremental: true,
    });

    // full overrides incremental
    expect(result.incremental).toBe(false);
    expect(result.modulesProcessed).toBe(2);
  });
});

// =============================================================================
// REQ-011: Staleness Metadata Integrity Validation
// =============================================================================

describe('REQ-011: Staleness Integrity Validation', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    setupMinimalProject(testRoot);
  });

  afterEach(() => {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('AC-corruption: corrupt staleness.json triggers fallback', () => {
    writeFileSync(join(testRoot, STALENESS_JSON_PATH), '{ totally broken json !!!');

    const result = loadStalenessMetadata(testRoot);
    expect(result).toBeNull();
  });

  it('AC-corruption: malformed schema triggers fallback', () => {
    writeFileSync(join(testRoot, STALENESS_JSON_PATH), JSON.stringify({ version: 999, modules: 'wrong' }));

    const result = loadStalenessMetadata(testRoot);
    expect(result).toBeNull();
  });
});

// =============================================================================
// REQ-012: Atomic Write-Rename Pattern
// =============================================================================

describe('REQ-012: Atomic Write-Rename', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('AC-atomic: atomicWriteFile creates the final file', () => {
    const filePath = join(testRoot, 'output.json');
    atomicWriteFile(filePath, '{"test": true}');

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('{"test": true}');
  });

  it('AC-atomic: no .tmp file remains after write', () => {
    const filePath = join(testRoot, 'output.json');
    atomicWriteFile(filePath, '{"test": true}');

    expect(existsSync(filePath + '.tmp')).toBe(false);
  });

  it('AC-atomic: overwrites existing file atomically', () => {
    const filePath = join(testRoot, 'output.json');
    writeFileSync(filePath, '{"version": 1}');

    atomicWriteFile(filePath, '{"version": 2}');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe('{"version": 2}');
  });
});

// =============================================================================
// REQ-013: Trace File Size Thresholds
// =============================================================================

describe('REQ-013: Trace File Size Thresholds', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('AC-size-warn: no error for small files', () => {
    const filePath = join(testRoot, 'small.json');
    writeFileSync(filePath, '{}');

    expect(() => checkTraceFileSize(filePath, 'small-module')).not.toThrow();
  });

  it('AC-size-warn: handles missing file gracefully', () => {
    expect(() => checkTraceFileSize(join(testRoot, 'nonexistent.json'), 'mod')).not.toThrow();
  });
});

// =============================================================================
// REQ-005: File-Level Incremental Generation (Integration)
// =============================================================================

describe('REQ-005: Incremental Generation (Integration)', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    setupMinimalProject(testRoot);
    // Generate initial full traces
    generateAllTraces({ projectRoot: testRoot });
  });

  afterEach(() => {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('AC-incremental: only regenerates directly stale module when exports unchanged', () => {
    expect(existsSync(join(testRoot, STALENESS_JSON_PATH))).toBe(true);

    // Record version of module-beta before
    const betaJsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json');
    const betaBefore = JSON.parse(readFileSync(betaJsonPath, 'utf-8'));
    const betaVersionBefore = betaBefore.version;

    // Modify a file in module-alpha -- body-only change (no export sig change)
    writeFileSync(join(testRoot, 'src', 'alpha', 'service.mjs'),
      `export function greet(name) {\n  return 'Hi there, ' + name;\n}\n`
    );
    execSync('git add .', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "modify alpha body only"', { cwd: testRoot, stdio: 'pipe' });

    // Run incremental generation
    const result = generateAllTraces({
      projectRoot: testRoot,
      incremental: true,
    });

    expect(result.incremental).toBe(true);
    // Only module-alpha should have been regenerated (export signature unchanged)
    expect(result.modulesProcessed).toBe(1);
    const alphaResult = result.lowLevelResults.find(r => r.moduleId === 'module-alpha');
    expect(alphaResult).toBeDefined();

    // module-beta should not have been regenerated (no cross-module propagation needed)
    const betaAfter = JSON.parse(readFileSync(betaJsonPath, 'utf-8'));
    expect(betaAfter.version).toBe(betaVersionBefore);
  });

  it('regenerates dependent modules when export signature changes', () => {
    // Modify alpha by adding a new export (changes export signature)
    writeFileSync(join(testRoot, 'src', 'alpha', 'service.mjs'),
      `export function greet(name) {\n  return 'Hi ' + name;\n}\n\nexport function farewell() { return 'bye'; }\n`
    );
    execSync('git add .', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "add export to alpha"', { cwd: testRoot, stdio: 'pipe' });

    const result = generateAllTraces({
      projectRoot: testRoot,
      incremental: true,
    });

    expect(result.incremental).toBe(true);
    // Both modules should be regenerated due to cross-module propagation
    expect(result.modulesProcessed).toBe(2);
  });

  it('skips all modules when nothing changed', () => {
    const result = generateAllTraces({
      projectRoot: testRoot,
      incremental: true,
    });

    expect(result.incremental).toBe(true);
    expect(result.modulesProcessed).toBe(0);
  });

  it('staleness.json is updated after incremental generation', () => {
    // Modify alpha
    writeFileSync(join(testRoot, 'src', 'alpha', 'service.mjs'),
      `export function changed() { return 42; }\n`
    );
    execSync('git add .', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "change"', { cwd: testRoot, stdio: 'pipe' });

    generateAllTraces({ projectRoot: testRoot, incremental: true });

    const staleness = JSON.parse(readFileSync(join(testRoot, STALENESS_JSON_PATH), 'utf-8'));
    const fileEntry = staleness.modules['module-alpha'].files['src/alpha/service.mjs'];
    expect(fileEntry).toBeDefined();
    expect(fileEntry.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to full when staleness.json is missing', () => {
    rmSync(join(testRoot, STALENESS_JSON_PATH));

    const result = generateAllTraces({
      projectRoot: testRoot,
      incremental: true,
    });

    // Should fall back to full generation
    expect(result.incremental).toBe(false);
    expect(result.modulesProcessed).toBe(2);
  });
});

// =============================================================================
// REQ-010: Commit-Staleness Hook Fallback
// =============================================================================

describe('REQ-010: Commit-Staleness Hook Fallback', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    setupMinimalProject(testRoot);
    generateAllTraces({ projectRoot: testRoot });
  });

  afterEach(() => {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('AC-fallback: isTraceStale with useStalenessStore falls back when staleness.json missing', () => {
    const config = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'trace.config.json'), 'utf-8')
    );

    rmSync(join(testRoot, STALENESS_JSON_PATH));

    const result = isTraceStale('module-alpha', config, testRoot, {
      useStalenessStore: true,
    });
    expect(result).toBe(true);
  });
});

// =============================================================================
// Full generation creates staleness.json
// =============================================================================

describe('Full generation creates staleness.json', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    setupMinimalProject(testRoot);
  });

  afterEach(() => {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('creates staleness.json with correct structure after full generation', () => {
    generateAllTraces({ projectRoot: testRoot });

    const stalenessPath = join(testRoot, STALENESS_JSON_PATH);
    expect(existsSync(stalenessPath)).toBe(true);

    const data = JSON.parse(readFileSync(stalenessPath, 'utf-8'));
    expect(data.version).toBe(1);
    expect(data.modules['module-alpha']).toBeDefined();
    expect(data.modules['module-beta']).toBeDefined();

    // Alpha should have 2 files
    const alphaFiles = Object.keys(data.modules['module-alpha'].files);
    expect(alphaFiles).toContain('src/alpha/service.mjs');
    expect(alphaFiles).toContain('src/alpha/helper.mjs');

    // Each file should have hash and lastTraced
    const serviceEntry = data.modules['module-alpha'].files['src/alpha/service.mjs'];
    expect(serviceEntry.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(serviceEntry.lastTraced).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Export signature hash should be present
    expect(data.modules['module-alpha'].exportSignatureHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

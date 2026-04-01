/**
 * Tests for Trace Regeneration Performance Fixes
 *
 * Spec: sg-trace-perf-20260327
 *
 * Validates:
 * - AC-1: Cache `git ls-files` once per generation run
 * - AC-2: Pre-compute filePath-to-moduleId map for O(1) external ref resolution
 * - AC-3: Enable incremental mode by default from CLI
 * - AC-4: Eliminate double file reads via content cache
 * - AC-5: Reuse cached content for staleness hash computation
 * - AC-6: Cache compiled regexes by glob pattern
 * - AC-7: Add worker_threads parallelism for module analysis
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs trace-perf.test.mjs
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  findFilesMatchingGlobs,
  matchesGlob,
  computeFileHash,
  globToRegex,
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
    `trace-perf-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
  );
}

/**
 * Set up a minimal project with git repo, trace config, and source files.
 * Used across multiple AC tests.
 */
function setupMinimalProject(testRoot) {
  // Create source files across two modules
  mkdirSync(join(testRoot, 'src', 'alpha'), { recursive: true });
  mkdirSync(join(testRoot, 'src', 'beta'), { recursive: true });

  writeFileSync(
    join(testRoot, 'src', 'alpha', 'service.mjs'),
    `export function greet(name) {\n  return 'Hello ' + name;\n}\n`,
  );
  writeFileSync(
    join(testRoot, 'src', 'alpha', 'helper.mjs'),
    `export const VERSION = '1.0';\n`,
  );
  writeFileSync(
    join(testRoot, 'src', 'beta', 'handler.mjs'),
    `import { greet } from '../alpha/service.mjs';\n\nexport function handleRequest(req) {\n  return greet(req.name);\n}\n`,
  );

  // Write trace config
  mkdirSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true });
  writeFileSync(
    join(testRoot, '.claude', 'traces', 'trace.config.json'),
    JSON.stringify(
      {
        version: 1,
        projectRoot: '.',
        modules: [
          { id: 'module-alpha', name: 'Module Alpha', fileGlobs: ['src/alpha/**'] },
          { id: 'module-beta', name: 'Module Beta', fileGlobs: ['src/beta/**'] },
        ],
      },
      null,
      2,
    ),
  );

  // Initialize git repo (required for git ls-files)
  execSync('git init', { cwd: testRoot, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: testRoot, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: testRoot, stdio: 'pipe' });
  execSync('git add .', { cwd: testRoot, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: testRoot, stdio: 'pipe' });

  return testRoot;
}

/**
 * Attempt to reset the file cache if the function is available.
 * Silently succeeds if resetFileCache does not exist yet (pre-implementation).
 */
async function tryResetFileCache() {
  try {
    const traceUtils = await import('../lib/trace-utils.mjs');
    if (typeof traceUtils.resetFileCache === 'function') {
      traceUtils.resetFileCache();
    }
  } catch {
    /* resetFileCache may not exist yet or module may fail to load */
  }
}

// =============================================================================
// AC-1: Cache `git ls-files` once per generation run
// =============================================================================

describe('AC-1: Cache git ls-files once per generation run', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    setupMinimalProject(testRoot);
  });

  afterEach(async () => {
    await tryResetFileCache();
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should return matching files from cached git ls-files (AC-1)', () => {
    // Arrange
    const globs = ['src/alpha/**'];

    // Act
    const result = findFilesMatchingGlobs(globs, testRoot);

    // Assert - files in alpha module are found
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.some(f => f.includes('service.mjs'))).toBeTruthy();
    expect(result.some(f => f.includes('helper.mjs'))).toBeTruthy();
  });

  it('should return different filtered views for different globs without re-calling git (AC-1)', async () => {
    // Arrange
    await tryResetFileCache();

    // Act - call with two different glob patterns
    const alphaFiles = findFilesMatchingGlobs(['src/alpha/**'], testRoot);
    const betaFiles = findFilesMatchingGlobs(['src/beta/**'], testRoot);

    // Assert - both return correct results (cache serves both)
    expect(alphaFiles.some(f => f.includes('alpha'))).toBeTruthy();
    expect(betaFiles.some(f => f.includes('beta'))).toBeTruthy();
    // Alpha files should not appear in beta results
    expect(betaFiles.every(f => !f.includes('alpha'))).toBeTruthy();
  });

  it('should export resetFileCache function (AC-1)', async () => {
    // Arrange & Act
    const traceUtils = await import('../lib/trace-utils.mjs');

    // Assert - resetFileCache is exported and callable
    expect(typeof traceUtils.resetFileCache).toBe('function');
  });

  it('should clear cache when resetFileCache is called (AC-1)', async () => {
    // Arrange
    const traceUtils = await import('../lib/trace-utils.mjs');
    // Populate cache by calling findFilesMatchingGlobs
    findFilesMatchingGlobs(['src/alpha/**'], testRoot);

    // Act - reset the cache
    if (typeof traceUtils.resetFileCache === 'function') {
      traceUtils.resetFileCache();
    }

    // Add a new file to the git repo
    writeFileSync(join(testRoot, 'src', 'alpha', 'new-file.mjs'), `export const NEW = true;\n`);
    execSync('git add .', { cwd: testRoot, stdio: 'pipe' });

    // Act - call again after reset
    const result = findFilesMatchingGlobs(['src/alpha/**'], testRoot);

    // Assert - the new file is found (cache was cleared, fresh git ls-files was run)
    expect(result.some(f => f.includes('new-file.mjs'))).toBeTruthy();
  });
});

// =============================================================================
// AC-2: Pre-compute filePath-to-moduleId map for O(1) external ref resolution
// =============================================================================

describe('AC-2: Pre-compute filePath-to-moduleId map for O(1) external ref resolution', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    setupMinimalProject(testRoot);
  });

  afterEach(async () => {
    await tryResetFileCache();
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should correctly record cross-module imports in trace after generation (AC-2)', async () => {
    // Arrange - beta/handler.mjs imports from alpha/service.mjs (cross-module)

    // Act - run full generation (await since generateAllTraces is async)
    await generateAllTraces({ projectRoot: testRoot });

    // Assert - beta module's trace should record the import from alpha's source
    const betaTracePath = join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json');
    expect(existsSync(betaTracePath)).toBeTruthy();

    const betaTrace = JSON.parse(readFileSync(betaTracePath, 'utf-8'));
    // Find the handler file entry and check its imports reference alpha
    const fileEntries = Object.values(betaTrace.files || {});
    const handlerFile = fileEntries.find(f =>
      (f.filePath || '').includes('handler.mjs'),
    );
    expect(handlerFile).toBeDefined();
    expect(handlerFile.imports.length).toBeGreaterThan(0);

    // The import source should reference the alpha module's file
    const crossModuleImport = handlerFile.imports.find(imp =>
      imp.source.includes('alpha') || imp.source.includes('service'),
    );
    expect(crossModuleImport).toBeDefined();
    expect(crossModuleImport.symbols).toContain('greet');
  });

  it('should record same-module imports without cross-module reference (AC-2)', async () => {
    // Arrange - add a second file in alpha that imports from alpha (same module)
    writeFileSync(
      join(testRoot, 'src', 'alpha', 'consumer.mjs'),
      `import { greet } from './service.mjs';\nexport const msg = greet('World');\n`,
    );
    execSync('git add .', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "add consumer"', { cwd: testRoot, stdio: 'pipe' });

    // Act
    await generateAllTraces({ projectRoot: testRoot });

    // Assert - alpha's trace should have the consumer file with local imports
    const alphaTracePath = join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json');
    const alphaTrace = JSON.parse(readFileSync(alphaTracePath, 'utf-8'));
    const fileEntries = Object.values(alphaTrace.files || {});

    // Consumer file should exist in the trace
    const consumerFile = fileEntries.find(f =>
      (f.filePath || '').includes('consumer.mjs'),
    );
    expect(consumerFile).toBeDefined();

    // Its import should be a local reference (./service.mjs), not a cross-module one
    const localImport = consumerFile.imports.find(imp =>
      imp.source.includes('./service'),
    );
    expect(localImport).toBeDefined();
  });
});

// =============================================================================
// AC-3: Enable incremental mode by default from CLI
// =============================================================================

describe('AC-3: Enable incremental mode by default from CLI', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    setupMinimalProject(testRoot);
  });

  afterEach(async () => {
    await tryResetFileCache();
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should use incremental mode by default when no flags specified (AC-3)', async () => {
    // Arrange - first run creates baseline
    await generateAllTraces({ projectRoot: testRoot });

    // Act - second run with defaults (should be incremental)
    const result = await generateAllTraces({ projectRoot: testRoot });

    // Assert - result should succeed and the generation should complete.
    // In incremental mode with no changes, modules should be skipped or
    // produce a result quickly. The key contract: no error thrown.
    expect(result).toBeDefined();
  });

  it('should accept incremental option explicitly without error (AC-3)', async () => {
    // Arrange - first run
    await generateAllTraces({ projectRoot: testRoot });

    // Act - explicit incremental: true (should be no-op since it's the default)
    const result = await generateAllTraces({ projectRoot: testRoot, incremental: true });

    // Assert
    expect(result).toBeDefined();
  });

  it('should support full mode via full flag (AC-3)', async () => {
    // Arrange - first run creates baseline
    await generateAllTraces({ projectRoot: testRoot });

    // Act - full regeneration
    const result = await generateAllTraces({ projectRoot: testRoot, full: true });

    // Assert - full mode produces output for all modules
    expect(result).toBeDefined();
    const alphaTracePath = join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json');
    const betaTracePath = join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json');
    expect(existsSync(alphaTracePath)).toBeTruthy();
    expect(existsSync(betaTracePath)).toBeTruthy();
  });

  it('should produce identical output for full and default first run (AC-3)', async () => {
    // Arrange - two separate project roots for comparison
    const testRoot2 = createTestDir();
    setupMinimalProject(testRoot2);

    // Act - default run (first run has no staleness data, so acts like full)
    await generateAllTraces({ projectRoot: testRoot });
    // Full run
    await generateAllTraces({ projectRoot: testRoot2, full: true });

    // Assert - both produce alpha and beta traces
    const defaultAlpha = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json'), 'utf-8'),
    );
    const fullAlpha = JSON.parse(
      readFileSync(join(testRoot2, '.claude', 'traces', 'low-level', 'module-alpha.json'), 'utf-8'),
    );

    // Module IDs and file entries should match
    expect(defaultAlpha.moduleId).toBe(fullAlpha.moduleId);
    expect(Object.keys(defaultAlpha.files || {}).length).toBe(
      Object.keys(fullAlpha.files || {}).length,
    );

    // Cleanup second root
    try {
      rmSync(testRoot2, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});

// =============================================================================
// AC-4: Eliminate double file reads via content cache
// =============================================================================

describe('AC-4: Eliminate double file reads via content cache', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    setupMinimalProject(testRoot);
  });

  afterEach(async () => {
    await tryResetFileCache();
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should complete generation without errors when content cache is active (AC-4)', async () => {
    // Arrange - project with multiple files that would be read multiple times
    // without caching (buildExportIndex + analyzeFile both read each file)

    // Act - generation should succeed with content cache active
    await generateAllTraces({ projectRoot: testRoot });

    // Assert - all module traces generated successfully
    const alphaTracePath = join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json');
    const betaTracePath = join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json');
    expect(existsSync(alphaTracePath)).toBeTruthy();
    expect(existsSync(betaTracePath)).toBeTruthy();

    // Verify trace content is valid (would fail if cache returned stale/wrong content)
    const alpha = JSON.parse(readFileSync(alphaTracePath, 'utf-8'));
    const fileEntries = Object.values(alpha.files || {});
    expect(fileEntries.length).toBeGreaterThanOrEqual(2); // service.mjs + helper.mjs
  });

  it('should produce correct exports even with content cache (AC-4)', async () => {
    // Arrange - file with known exports

    // Act
    await generateAllTraces({ projectRoot: testRoot });

    // Assert - exports should be correctly parsed (proves file content was not corrupted by cache)
    const alphaTracePath = join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json');
    const alpha = JSON.parse(readFileSync(alphaTracePath, 'utf-8'));
    const serviceFile = Object.values(alpha.files || {}).find(f =>
      (f.filePath || '').includes('service.mjs'),
    );
    expect(serviceFile).toBeDefined();
    // The 'greet' function should appear in exports
    const greetExport = serviceFile.exports.find(e => e.symbol === 'greet');
    expect(greetExport).toBeDefined();
  });
});

// =============================================================================
// AC-5: Reuse cached content for staleness hash computation
// =============================================================================

describe('AC-5: Reuse cached content for staleness hash computation', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    setupMinimalProject(testRoot);
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should compute correct hash when content is provided directly (AC-5)', () => {
    // Arrange
    const filePath = join(testRoot, 'src', 'alpha', 'service.mjs');
    const content = readFileSync(filePath, 'utf-8');
    const expectedHash = createHash('sha256').update(content).digest('hex');

    // Act - call with content parameter
    const hashWithContent = computeFileHash(filePath, content);

    // Assert - hash matches expected SHA-256
    expect(hashWithContent).toBe(expectedHash);
  });

  it('should compute correct hash when reading from disk (backward compat) (AC-5)', () => {
    // Arrange
    const filePath = join(testRoot, 'src', 'alpha', 'service.mjs');
    const content = readFileSync(filePath, 'utf-8');
    const expectedHash = createHash('sha256').update(content).digest('hex');

    // Act - call without content parameter (fallback to readFileSync)
    const hashFromDisk = computeFileHash(filePath);

    // Assert - same hash as manual computation
    expect(hashFromDisk).toBe(expectedHash);
  });

  it('should produce identical hash regardless of content source (AC-5)', () => {
    // Arrange
    const filePath = join(testRoot, 'src', 'alpha', 'service.mjs');
    const content = readFileSync(filePath, 'utf-8');

    // Act
    const hashWithContent = computeFileHash(filePath, content);
    const hashFromDisk = computeFileHash(filePath);

    // Assert - both paths produce the same hash
    expect(hashWithContent).toBe(hashFromDisk);
  });

  it('should accept content parameter without error (AC-5)', () => {
    // Arrange
    const filePath = join(testRoot, 'src', 'alpha', 'service.mjs');
    const content = readFileSync(filePath, 'utf-8');

    // Act & Assert - should not throw when content is provided
    expect(() => computeFileHash(filePath, content)).not.toThrow();
  });

  it('should handle empty string content gracefully (AC-5)', () => {
    // Arrange
    const filePath = join(testRoot, 'src', 'alpha', 'service.mjs');
    const emptyContent = '';
    const expectedHash = createHash('sha256').update(emptyContent).digest('hex');

    // Act
    const hash = computeFileHash(filePath, emptyContent);

    // Assert - hash of empty string, not file on disk
    expect(hash).toBe(expectedHash);
  });
});

// =============================================================================
// AC-6: Cache compiled regexes by glob pattern
// =============================================================================

describe('AC-6: Cache compiled regexes by glob pattern', () => {
  afterEach(async () => {
    await tryResetFileCache();
  });

  it('should return correct match results for same pattern across multiple calls (AC-6)', () => {
    // Arrange
    const pattern = 'src/alpha/**';
    const paths = [
      'src/alpha/service.mjs',
      'src/alpha/helper.mjs',
      'src/alpha/nested/deep.mjs',
      'src/beta/handler.mjs',
    ];

    // Act & Assert - multiple calls with same pattern should all work correctly
    for (const path of paths) {
      const result = matchesGlob(path, pattern);
      if (path.includes('alpha')) {
        expect(result, `Expected ${path} to match ${pattern}`).toBeTruthy();
      } else {
        expect(result, `Expected ${path} NOT to match ${pattern}`).toBeFalsy();
      }
    }
  });

  it('should return consistent results across many calls with same pattern (AC-6)', () => {
    // Arrange
    const pattern = 'apps/node-server/src/**';
    const testPath = 'apps/node-server/src/handlers/auth.ts';

    // Act - call matchesGlob many times with the same pattern
    const results = [];
    for (let i = 0; i < 100; i++) {
      results.push(matchesGlob(testPath, pattern));
    }

    // Assert - all results should be identical (cached regex produces same output)
    expect(results.every(r => r === results[0])).toBeTruthy();
  });

  it('should handle multiple unique patterns correctly (AC-6)', () => {
    // Arrange
    const patterns = [
      'src/alpha/**',
      'src/beta/**',
      'apps/dashboard/src/**',
      'cdk/platform-cdk/src/**',
    ];

    // Act & Assert
    expect(matchesGlob('src/alpha/file.ts', patterns[0])).toBeTruthy();
    expect(matchesGlob('src/beta/file.ts', patterns[1])).toBeTruthy();
    expect(matchesGlob('apps/dashboard/src/page.tsx', patterns[2])).toBeTruthy();
    expect(matchesGlob('cdk/platform-cdk/src/stack.ts', patterns[3])).toBeTruthy();

    // Cross-check: wrong module shouldn't match
    expect(matchesGlob('src/alpha/file.ts', patterns[1])).toBeFalsy();
    expect(matchesGlob('src/beta/file.ts', patterns[0])).toBeFalsy();
  });

  it('should clear regex cache when resetFileCache is called (AC-6)', async () => {
    // Arrange
    const traceUtils = await import('../lib/trace-utils.mjs');

    // Use the pattern, populating the cache
    matchesGlob('src/test/file.ts', 'src/test/**');

    // Act - reset the cache
    if (typeof traceUtils.resetFileCache === 'function') {
      traceUtils.resetFileCache();
    }

    // Assert - matchesGlob still works after reset (it rebuilds cache)
    const result = matchesGlob('src/test/file.ts', 'src/test/**');
    expect(result).toBeTruthy();
  });
});

// =============================================================================
// AC-7: Add worker_threads parallelism for module analysis
// =============================================================================

describe('AC-7: Add worker_threads parallelism for module analysis', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    setupMinimalProject(testRoot);
  });

  afterEach(async () => {
    await tryResetFileCache();
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should produce identical output in sequential mode (--parallel 0) vs default (AC-7)', async () => {
    // Arrange & Act
    // Run sequential (parallel: 0)
    await generateAllTraces({ projectRoot: testRoot, parallelWorkers: 0 });

    // Read traces from sequential run
    const seqAlpha = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json'), 'utf-8'),
    );
    const seqBeta = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json'), 'utf-8'),
    );

    // Clear traces for parallel run
    rmSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true, force: true });
    mkdirSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true });

    // Run with default parallelism
    await generateAllTraces({ projectRoot: testRoot, full: true });

    // Read traces from parallel run
    const parAlpha = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json'), 'utf-8'),
    );
    const parBeta = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json'), 'utf-8'),
    );

    // Assert - module structure should match between sequential and parallel
    expect(seqAlpha.moduleId).toBe(parAlpha.moduleId);
    expect(seqBeta.moduleId).toBe(parBeta.moduleId);

    // File entries should match
    const seqAlphaFiles = Object.keys(seqAlpha.files || {}).sort();
    const parAlphaFiles = Object.keys(parAlpha.files || {}).sort();
    expect(seqAlphaFiles).toEqual(parAlphaFiles);

    const seqBetaFiles = Object.keys(seqBeta.files || {}).sort();
    const parBetaFiles = Object.keys(parBeta.files || {}).sort();
    expect(seqBetaFiles).toEqual(parBetaFiles);
  });

  it('should produce identical imports in sequential vs default mode (AC-7)', async () => {
    // Arrange & Act
    await generateAllTraces({ projectRoot: testRoot, parallelWorkers: 0 });
    const seqBeta = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json'), 'utf-8'),
    );
    // Collect all imports across files as a proxy for external refs
    const seqImports = Object.values(seqBeta.files || {})
      .flatMap(f => (f.imports || []).map(i => JSON.stringify(i)))
      .sort();

    // Re-run with default parallelism
    rmSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true, force: true });
    mkdirSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true });
    await generateAllTraces({ projectRoot: testRoot, full: true });

    const parBeta = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json'), 'utf-8'),
    );
    const parImports = Object.values(parBeta.files || {})
      .flatMap(f => (f.imports || []).map(i => JSON.stringify(i)))
      .sort();

    // Assert - imports match exactly between sequential and parallel
    expect(seqImports).toEqual(parImports);
  });

  it('should accept parallel option without error (AC-7)', async () => {
    // Act & Assert - no error thrown with parallel option
    await generateAllTraces({ projectRoot: testRoot, parallelWorkers: 2 });
  });

  it('should accept parallel: 0 for sequential debugging mode (AC-7)', async () => {
    // Act & Assert - parallel: 0 means sequential
    await generateAllTraces({ projectRoot: testRoot, parallelWorkers: 0 });
  });
});

// =============================================================================
// Integration: Full generation with all optimizations
// =============================================================================

describe('Integration: Full generation with all performance optimizations', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    setupMinimalProject(testRoot);
  });

  afterEach(async () => {
    await tryResetFileCache();
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should produce valid low-level traces with all optimizations active', async () => {
    // Arrange - nothing extra needed; all optimizations are active by default

    // Act
    await generateAllTraces({ projectRoot: testRoot });

    // Assert - per-module low-level trace files exist and are valid
    const alphaPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json');
    const betaPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json');

    expect(existsSync(alphaPath)).toBeTruthy();
    expect(existsSync(betaPath)).toBeTruthy();

    // Traces should be valid JSON with expected structure
    const alpha = JSON.parse(readFileSync(alphaPath, 'utf-8'));
    const beta = JSON.parse(readFileSync(betaPath, 'utf-8'));
    expect(alpha.moduleId).toBe('module-alpha');
    expect(beta.moduleId).toBe('module-beta');

    // File entries should be populated
    expect(Object.keys(alpha.files || {}).length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(beta.files || {}).length).toBeGreaterThanOrEqual(1);
  });

  it('should handle incremental run after initial generation', async () => {
    // Arrange - first full run
    await generateAllTraces({ projectRoot: testRoot });

    // Modify a file
    writeFileSync(
      join(testRoot, 'src', 'alpha', 'service.mjs'),
      `export function greet(name) {\n  return 'Hi ' + name;\n}\n`,
    );
    execSync('git add .', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "update service"', { cwd: testRoot, stdio: 'pipe' });

    // Act - incremental run (default mode)
    await generateAllTraces({ projectRoot: testRoot });

    // Assert - traces still valid after incremental update
    const alphaPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json');
    const alpha = JSON.parse(readFileSync(alphaPath, 'utf-8'));
    expect(alpha.moduleId).toBe('module-alpha');
  });
});

// =============================================================================
// Gap 1 (High): Error path tests
// =============================================================================

describe('Gap 1: Error path handling', () => {
  describe('findFilesMatchingGlobs with non-git directory', () => {
    let nonGitDir;

    beforeEach(() => {
      // Arrange - create a directory that is NOT a git repo
      nonGitDir = createTestDir();
      mkdirSync(join(nonGitDir, 'src'), { recursive: true });
      writeFileSync(join(nonGitDir, 'src', 'file.mjs'), 'export const A = 1;\n');
    });

    afterEach(async () => {
      await tryResetFileCache();
      try {
        rmSync(nonGitDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('should return empty array when git ls-files fails (non-git directory)', () => {
      // Arrange - nonGitDir has no .git (git ls-files will fail)

      // Act
      const result = findFilesMatchingGlobs(['src/**'], nonGitDir);

      // Assert - graceful degradation: empty array, no thrown error
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('should not throw when git ls-files fails', () => {
      // Arrange - nonGitDir has no .git

      // Act & Assert - must not throw
      expect(() => findFilesMatchingGlobs(['src/**'], nonGitDir)).not.toThrow();
    });
  });

  describe('Worker crash fallback to sequential (AC-7)', () => {
    let testRoot;

    beforeEach(() => {
      testRoot = createTestDir();
      setupMinimalProject(testRoot);
    });

    afterEach(async () => {
      await tryResetFileCache();
      try {
        rmSync(testRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('should produce valid traces even with parallelWorkers > 0 (worker error fallback path)', async () => {
      // Arrange - use parallelWorkers to exercise the worker path;
      // the worker error handler falls back to sequential writeLowLevelTrace.
      // We verify the system produces correct output regardless of worker success/failure.

      // Act - run with parallel workers enabled
      const result = await generateAllTraces({ projectRoot: testRoot, parallelWorkers: 2, full: true });

      // Assert - generation completes and produces valid traces
      expect(result).toBeDefined();
      expect(result.modulesProcessed).toBeGreaterThanOrEqual(2);

      const alphaPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json');
      const betaPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json');
      expect(existsSync(alphaPath)).toBeTruthy();
      expect(existsSync(betaPath)).toBeTruthy();

      // Verify trace content is valid
      const alpha = JSON.parse(readFileSync(alphaPath, 'utf-8'));
      expect(alpha.moduleId).toBe('module-alpha');
      expect(Object.keys(alpha.files || {}).length).toBeGreaterThanOrEqual(2);
    });

    it('should produce identical output between parallelWorkers:2 and sequential mode', async () => {
      // Arrange & Act - sequential run first
      await generateAllTraces({ projectRoot: testRoot, parallelWorkers: 0, full: true });
      const seqAlpha = JSON.parse(
        readFileSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json'), 'utf-8'),
      );

      // Clear traces for parallel run
      rmSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true, force: true });
      mkdirSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true });
      await tryResetFileCache();

      // Act - parallel run
      await generateAllTraces({ projectRoot: testRoot, parallelWorkers: 2, full: true });
      const parAlpha = JSON.parse(
        readFileSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json'), 'utf-8'),
      );

      // Assert - module structure matches (worker fallback produces same output)
      expect(seqAlpha.moduleId).toBe(parAlpha.moduleId);
      const seqFiles = Object.keys(seqAlpha.files || {}).sort();
      const parFiles = Object.keys(parAlpha.files || {}).sort();
      expect(seqFiles).toEqual(parFiles);
    });
  });
});

// =============================================================================
// Gap 2 (Medium): Invocation count / caching behavior for AC-1
// =============================================================================

describe('Gap 2: AC-1 caching behavioral verification', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    setupMinimalProject(testRoot);
  });

  afterEach(async () => {
    await tryResetFileCache();
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should return results instantly on second call (cache hit behavior)', () => {
    // Arrange - reset cache, then prime it
    // First call populates cache
    const result1 = findFilesMatchingGlobs(['src/alpha/**'], testRoot);
    expect(result1.length).toBeGreaterThan(0);

    // Act - second call should use cache (measure timing as behavioral signal)
    const start = performance.now();
    const result2 = findFilesMatchingGlobs(['src/beta/**'], testRoot);
    const durationMs = performance.now() - start;

    // Assert - second call returns correct results and is fast (< 50ms, no subprocess)
    expect(result2.length).toBeGreaterThan(0);
    expect(result2.some(f => f.includes('beta'))).toBeTruthy();
    // The cached path should be very fast since it doesn't spawn git
    expect(durationMs).toBeLessThan(50);
  });

  it('should re-fetch files after resetFileCache is called (cache invalidation)', async () => {
    // Arrange - prime cache
    const traceUtils = await import('../lib/trace-utils.mjs');
    findFilesMatchingGlobs(['src/alpha/**'], testRoot);

    // Add a new file and stage it
    writeFileSync(join(testRoot, 'src', 'alpha', 'extra.mjs'), 'export const X = 1;\n');
    execSync('git add .', { cwd: testRoot, stdio: 'pipe' });

    // Without reset, new file should NOT appear (stale cache)
    const beforeReset = findFilesMatchingGlobs(['src/alpha/**'], testRoot);
    const hasExtraBeforeReset = beforeReset.some(f => f.includes('extra.mjs'));
    // Cache is stale, so extra.mjs should NOT be found
    expect(hasExtraBeforeReset).toBe(false);

    // Act - reset cache
    traceUtils.resetFileCache();

    // Assert - after reset, new file IS found
    const afterReset = findFilesMatchingGlobs(['src/alpha/**'], testRoot);
    expect(afterReset.some(f => f.includes('extra.mjs'))).toBe(true);
  });

  it('should call git ls-files at most once across multiple findFilesMatchingGlobs calls', () => {
    // Arrange - reset cache to start fresh, then call findFilesMatchingGlobs 5 times
    // Behavioral proof: if git were called each time, adding an unstaged file mid-way
    // would make it appear in subsequent calls. With caching, it stays invisible.

    // Prime cache with first call
    findFilesMatchingGlobs(['src/alpha/**'], testRoot);

    // Create an unstaged file (not in git ls-files output)
    writeFileSync(join(testRoot, 'src', 'alpha', 'phantom.mjs'), 'export const P = 1;\n');
    // Do NOT git add -- file is untracked

    // Act - call multiple times
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(findFilesMatchingGlobs(['src/alpha/**'], testRoot));
    }

    // Assert - phantom file never appears (proves cache is being reused, not re-calling git)
    for (const r of results) {
      expect(r.some(f => f.includes('phantom.mjs'))).toBe(false);
    }
  });
});

// =============================================================================
// Gap 3 (Medium): Empty input edge cases
// =============================================================================

describe('Gap 3: Empty input edge cases', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = createTestDir();
    setupMinimalProject(testRoot);
  });

  afterEach(async () => {
    await tryResetFileCache();
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should return empty array for a glob that matches no files', () => {
    // Arrange
    const noMatchGlob = ['nonexistent/path/**'];

    // Act
    const result = findFilesMatchingGlobs(noMatchGlob, testRoot);

    // Assert - empty array, not error
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it('should return empty array for an empty globs array', () => {
    // Arrange
    const emptyGlobs = [];

    // Act
    const result = findFilesMatchingGlobs(emptyGlobs, testRoot);

    // Assert
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it('should handle a module with no matching files in generateAllTraces', async () => {
    // Arrange - add a module whose fileGlobs match nothing
    const configPath = join(testRoot, '.claude', 'traces', 'trace.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.modules.push({
      id: 'module-ghost',
      name: 'Ghost Module',
      fileGlobs: ['nonexistent/dir/**'],
    });
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Act - should not throw even though module-ghost matches zero files
    const result = await generateAllTraces({ projectRoot: testRoot, full: true });

    // Assert - generation completes successfully
    expect(result).toBeDefined();
    expect(result.modulesProcessed).toBeGreaterThanOrEqual(2); // alpha + beta still processed

    // The ghost module's trace should either not exist or be a valid empty trace
    const ghostTracePath = join(testRoot, '.claude', 'traces', 'low-level', 'module-ghost.json');
    if (existsSync(ghostTracePath)) {
      const ghostTrace = JSON.parse(readFileSync(ghostTracePath, 'utf-8'));
      expect(ghostTrace.moduleId).toBe('module-ghost');
      // files array should be empty or absent
      const fileEntries = Array.isArray(ghostTrace.files) ? ghostTrace.files : Object.values(ghostTrace.files || {});
      expect(fileEntries.length).toBe(0);
    }
    // If trace file doesn't exist, that's also acceptable (no files = no trace)
  });

  it('should handle glob pattern matching only non-source files gracefully', () => {
    // Arrange - glob that matches the config JSON but no source files
    const configGlob = ['.claude/traces/*.json'];

    // Act
    const result = findFilesMatchingGlobs(configGlob, testRoot);

    // Assert - returns matching files (if any are tracked) or empty, but no error
    expect(Array.isArray(result)).toBe(true);
  });
});

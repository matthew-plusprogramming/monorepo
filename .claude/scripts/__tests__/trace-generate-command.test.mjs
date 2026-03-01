/**
 * Integration tests for the full trace generation command (as-005)
 *
 * Tests: as-005-trace-generate-command (AC-5.1, AC-5.3, AC-5.4)
 *
 * Validates:
 * - AC-5.1: Running trace-generate.mjs produces high-level.json, high-level.md,
 *   and per-module low-level/<module-id>.json and low-level/<module-id>.md files.
 * - AC-5.3: If .claude/traces/ directory structure does not exist, the command creates it.
 * - AC-5.4: The command outputs a summary reporting modules processed and files generated.
 *
 * Run with: node --test .claude/scripts/__tests__/trace-generate-command.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { generateAllTraces } from '../trace-generate.mjs';
import { validateLowLevelTrace } from '../trace-generate.mjs';
import { validateHighLevelTrace } from '../lib/high-level-trace.mjs';

// =============================================================================
// Test Fixtures
// =============================================================================

/** Create a minimal trace config with 2 modules */
function createTestConfig() {
  return {
    version: 1,
    projectRoot: '.',
    modules: [
      {
        id: 'module-alpha',
        name: 'Module Alpha',
        description: 'First test module',
        fileGlobs: ['src/alpha/**'],
      },
      {
        id: 'module-beta',
        name: 'Module Beta',
        description: 'Second test module',
        fileGlobs: ['src/beta/**'],
      },
    ],
  };
}

/** Sample TypeScript source for testing */
const SAMPLE_SOURCE = `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadData(path: string): string {
  return readFileSync(join(__dirname, path), 'utf-8');
}

export class DataService {
  load(): string {
    return loadData('data.json');
  }
}

export const VERSION = '1.0.0';
`;

/** Set up a temp directory with git repo, config, and source files */
function setupTestProject() {
  const timestamp = Date.now();
  const testRoot = join(
    tmpdir(),
    `trace-cmd-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
  );

  // Create source directories and files
  mkdirSync(join(testRoot, 'src', 'alpha'), { recursive: true });
  mkdirSync(join(testRoot, 'src', 'beta'), { recursive: true });
  writeFileSync(join(testRoot, 'src', 'alpha', 'service.ts'), SAMPLE_SOURCE);
  writeFileSync(join(testRoot, 'src', 'alpha', 'index.ts'), `export { loadData, DataService } from './service.js';`);
  writeFileSync(join(testRoot, 'src', 'beta', 'handler.ts'), `
import { DataService } from '../alpha/service.js';
export function handleRequest(): void {
  const svc = new DataService();
  svc.load();
}
`);

  // Write trace config
  mkdirSync(join(testRoot, '.claude', 'traces'), { recursive: true });
  writeFileSync(
    join(testRoot, '.claude', 'traces', 'trace.config.json'),
    JSON.stringify(createTestConfig(), null, 2),
  );

  // Initialize git repo (required for file discovery)
  execSync('git init', { cwd: testRoot });
  execSync('git config user.email "test@test.com"', { cwd: testRoot });
  execSync('git config user.name "Test"', { cwd: testRoot });
  execSync('git add .', { cwd: testRoot });
  execSync('git commit -m "init"', { cwd: testRoot });

  return testRoot;
}

// =============================================================================
// AC-5.1: Full generation produces expected files
// =============================================================================

describe('AC-5.1: Full generation produces all expected trace files', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = setupTestProject();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should produce high-level.json', () => {
    generateAllTraces({ projectRoot: testRoot });

    const jsonPath = join(testRoot, '.claude', 'traces', 'high-level.json');
    assert.ok(existsSync(jsonPath), 'high-level.json should exist');

    const parsed = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    const validation = validateHighLevelTrace(parsed);
    assert.ok(validation.valid, `high-level.json should validate: ${validation.errors.join(', ')}`);
  });

  it('should produce high-level.md', () => {
    generateAllTraces({ projectRoot: testRoot });

    const mdPath = join(testRoot, '.claude', 'traces', 'high-level.md');
    assert.ok(existsSync(mdPath), 'high-level.md should exist');

    const content = readFileSync(mdPath, 'utf-8');
    assert.ok(content.includes('<!-- trace-id: high-level -->'), 'Should have trace-id metadata');
    assert.ok(content.includes('# Architecture Trace: High-Level'), 'Should have main heading');
    assert.ok(content.includes('## Module: Module Alpha'), 'Should have Module Alpha section');
    assert.ok(content.includes('## Module: Module Beta'), 'Should have Module Beta section');
  });

  it('should produce per-module low-level JSON files', () => {
    generateAllTraces({ projectRoot: testRoot });

    const alphaJsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json');
    const betaJsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json');

    assert.ok(existsSync(alphaJsonPath), 'module-alpha.json should exist');
    assert.ok(existsSync(betaJsonPath), 'module-beta.json should exist');

    // Validate JSON schema
    const alphaTrace = JSON.parse(readFileSync(alphaJsonPath, 'utf-8'));
    const alphaValidation = validateLowLevelTrace(alphaTrace);
    assert.ok(alphaValidation.valid, `module-alpha.json should validate: ${alphaValidation.errors.join(', ')}`);
    assert.equal(alphaTrace.moduleId, 'module-alpha');

    const betaTrace = JSON.parse(readFileSync(betaJsonPath, 'utf-8'));
    const betaValidation = validateLowLevelTrace(betaTrace);
    assert.ok(betaValidation.valid, `module-beta.json should validate: ${betaValidation.errors.join(', ')}`);
    assert.equal(betaTrace.moduleId, 'module-beta');
  });

  it('should produce per-module low-level markdown files', () => {
    generateAllTraces({ projectRoot: testRoot });

    const alphaMdPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.md');
    const betaMdPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.md');

    assert.ok(existsSync(alphaMdPath), 'module-alpha.md should exist');
    assert.ok(existsSync(betaMdPath), 'module-beta.md should exist');

    const alphaContent = readFileSync(alphaMdPath, 'utf-8');
    assert.ok(alphaContent.includes('<!-- trace-id: module-alpha -->'), 'Should have trace-id');
    assert.ok(alphaContent.includes('# Low-Level Trace: Module Alpha'), 'Should have heading');
    assert.ok(alphaContent.includes('## File: src/alpha/service.ts'), 'Should have service.ts entry');
    assert.ok(alphaContent.includes('## File: src/alpha/index.ts'), 'Should have index.ts entry');

    const betaContent = readFileSync(betaMdPath, 'utf-8');
    assert.ok(betaContent.includes('<!-- trace-id: module-beta -->'), 'Should have trace-id');
    assert.ok(betaContent.includes('## File: src/beta/handler.ts'), 'Should have handler.ts entry');
  });

  it('should produce exactly 6 trace files (2 high-level + 2x2 low-level)', () => {
    const result = generateAllTraces({ projectRoot: testRoot });

    assert.equal(result.filesGenerated, 6, 'Should generate 6 files total');
    assert.equal(result.modulesProcessed, 2, 'Should process 2 modules');

    // Verify all 6 files exist
    const expectedFiles = [
      join(testRoot, '.claude', 'traces', 'high-level.json'),
      join(testRoot, '.claude', 'traces', 'high-level.md'),
      join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json'),
      join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.md'),
      join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json'),
      join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.md'),
    ];

    for (const filePath of expectedFiles) {
      assert.ok(existsSync(filePath), `Expected file should exist: ${filePath}`);
    }
  });

  it('low-level traces should contain correct file entries from static analysis', () => {
    generateAllTraces({ projectRoot: testRoot });

    const alphaTrace = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json'), 'utf-8'),
    );

    // module-alpha has 2 source files
    assert.equal(alphaTrace.files.length, 2, 'Module Alpha should have 2 file entries');
    const filePaths = alphaTrace.files.map(f => f.filePath).sort();
    assert.deepEqual(filePaths, ['src/alpha/index.ts', 'src/alpha/service.ts']);

    // Verify service.ts has expected imports/exports
    const serviceEntry = alphaTrace.files.find(f => f.filePath === 'src/alpha/service.ts');
    assert.ok(serviceEntry, 'Should find service.ts entry');
    assert.ok(serviceEntry.exports.length > 0, 'service.ts should have exports');
    assert.ok(serviceEntry.imports.length > 0, 'service.ts should have imports');

    const exportSymbols = serviceEntry.exports.map(e => e.symbol);
    assert.ok(exportSymbols.includes('loadData'), 'Should export loadData');
    assert.ok(exportSymbols.includes('DataService'), 'Should export DataService');
    assert.ok(exportSymbols.includes('VERSION'), 'Should export VERSION');
  });
});

// =============================================================================
// AC-5.3: Directory auto-creation on first run
// =============================================================================

describe('AC-5.3: Directory auto-creation', () => {
  let testRoot;

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should create .claude/traces/ directory if it does not exist', () => {
    // Set up project without traces directory
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-dir-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );

    mkdirSync(join(testRoot, 'src', 'alpha'), { recursive: true });
    writeFileSync(join(testRoot, 'src', 'alpha', 'index.ts'), 'export const x = 1;');

    // Write config to a temporary location, then copy it during generation
    // Actually, config must exist for loadTraceConfig to work. Create traces dir minimally.
    mkdirSync(join(testRoot, '.claude', 'traces'), { recursive: true });
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      JSON.stringify(createTestConfig(), null, 2),
    );

    // Remove low-level directory to simulate first run
    assert.ok(!existsSync(join(testRoot, '.claude', 'traces', 'low-level')),
      'low-level/ should not exist yet');

    execSync('git init', { cwd: testRoot });
    execSync('git config user.email "test@test.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    generateAllTraces({ projectRoot: testRoot });

    // Verify directories were created
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'low-level')),
      'low-level/ should be created');
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'high-level.json')),
      'high-level.json should be created');
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json')),
      'module-alpha.json should be created');
  });

  it('should handle already-existing directory structure gracefully', () => {
    testRoot = setupTestProject();

    // First generation creates dirs
    generateAllTraces({ projectRoot: testRoot });

    // Second generation should work without error
    const result = generateAllTraces({ projectRoot: testRoot });
    assert.equal(result.modulesProcessed, 2, 'Should still process all modules');
  });
});

// =============================================================================
// AC-5.4: Summary output
// =============================================================================

describe('AC-5.4: Summary reports modules processed and files generated', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = setupTestProject();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should report correct modulesProcessed count', () => {
    const result = generateAllTraces({ projectRoot: testRoot });
    assert.equal(result.modulesProcessed, 2, 'Should report 2 modules');
  });

  it('should report correct filesGenerated count', () => {
    const result = generateAllTraces({ projectRoot: testRoot });
    // 2 high-level files + 2 modules * 2 files each = 6
    assert.equal(result.filesGenerated, 6, 'Should report 6 files generated');
  });

  it('should report positive durationMs', () => {
    const result = generateAllTraces({ projectRoot: testRoot });
    assert.ok(typeof result.durationMs === 'number', 'durationMs should be a number');
    assert.ok(result.durationMs >= 0, 'durationMs should be non-negative');
  });

  it('should report highLevelVersion', () => {
    const result = generateAllTraces({ projectRoot: testRoot });
    assert.equal(result.highLevelVersion, 1, 'First generation should be version 1');
  });

  it('should report per-module low-level results', () => {
    const result = generateAllTraces({ projectRoot: testRoot });

    assert.equal(result.lowLevelResults.length, 2, 'Should have 2 low-level results');

    const alphaResult = result.lowLevelResults.find(r => r.moduleId === 'module-alpha');
    const betaResult = result.lowLevelResults.find(r => r.moduleId === 'module-beta');

    assert.ok(alphaResult, 'Should have result for module-alpha');
    assert.ok(betaResult, 'Should have result for module-beta');

    assert.equal(alphaResult.fileCount, 2, 'module-alpha should have 2 files');
    assert.equal(betaResult.fileCount, 1, 'module-beta should have 1 file');
    assert.equal(alphaResult.version, 1, 'First gen version should be 1');
    assert.equal(betaResult.version, 1, 'First gen version should be 1');
  });

  it('should report null highLevelVersion when --low-level-only', () => {
    const result = generateAllTraces({ projectRoot: testRoot, lowLevelOnly: true });
    assert.equal(result.highLevelVersion, null, 'Should be null when low-level-only');
    // Files: only low-level (2 modules * 2 files = 4)
    assert.equal(result.filesGenerated, 4, 'Should generate 4 files in low-level-only mode');
  });
});

// =============================================================================
// Re-run behavior: version incrementing and file updates
// =============================================================================

describe('re-run behavior', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = setupTestProject();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should increment high-level version on re-run', () => {
    const result1 = generateAllTraces({ projectRoot: testRoot });
    assert.equal(result1.highLevelVersion, 1);

    const result2 = generateAllTraces({ projectRoot: testRoot });
    assert.equal(result2.highLevelVersion, 2, 'Second run should increment to version 2');
  });

  it('should increment low-level versions on re-run', () => {
    const result1 = generateAllTraces({ projectRoot: testRoot });
    const alphaV1 = result1.lowLevelResults.find(r => r.moduleId === 'module-alpha');
    assert.equal(alphaV1.version, 1);

    const result2 = generateAllTraces({ projectRoot: testRoot });
    const alphaV2 = result2.lowLevelResults.find(r => r.moduleId === 'module-alpha');
    assert.equal(alphaV2.version, 2, 'Low-level version should increment to 2');
  });

  it('should update files on re-run', () => {
    generateAllTraces({ projectRoot: testRoot });

    // Read version from high-level.json
    const jsonPath = join(testRoot, '.claude', 'traces', 'high-level.json');
    const v1 = JSON.parse(readFileSync(jsonPath, 'utf-8')).version;
    assert.equal(v1, 1);

    // Re-run
    generateAllTraces({ projectRoot: testRoot });

    const v2 = JSON.parse(readFileSync(jsonPath, 'utf-8')).version;
    assert.equal(v2, 2, 'File should be updated with new version');
  });

  it('should update markdown metadata on re-run', () => {
    generateAllTraces({ projectRoot: testRoot });

    const mdPath = join(testRoot, '.claude', 'traces', 'high-level.md');
    const md1 = readFileSync(mdPath, 'utf-8');
    assert.ok(md1.includes('<!-- trace-version: 1 -->'));

    generateAllTraces({ projectRoot: testRoot });

    const md2 = readFileSync(mdPath, 'utf-8');
    assert.ok(md2.includes('<!-- trace-version: 2 -->'), 'Markdown should reflect updated version');
  });
});

// =============================================================================
// CLI execution via child process
// =============================================================================

describe('CLI execution (child process)', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = setupTestProject();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should exit with code 0 and print summary to stdout', () => {
    // Get the absolute path to the script
    const scriptPath = join(process.cwd(), '.claude', 'scripts', 'trace-generate.mjs');

    const output = execSync(
      `node "${scriptPath}"`,
      {
        cwd: testRoot,
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: testRoot },
        timeout: 30000,
      },
    );

    // AC-5.4: Verify summary output
    assert.ok(output.includes('Trace generation complete'), 'Should print completion message');
    assert.ok(output.includes('Modules processed: 2'), 'Should report 2 modules');
    assert.ok(output.includes('Files generated: 6'), 'Should report 6 files');
    assert.ok(output.includes('Duration:'), 'Should report duration');
    assert.ok(output.includes('High-level trace: version 1'), 'Should report high-level version');
    assert.ok(output.includes('module-alpha:'), 'Should report module-alpha results');
    assert.ok(output.includes('module-beta:'), 'Should report module-beta results');
  });

  it('should produce all expected files when run via CLI', () => {
    const scriptPath = join(process.cwd(), '.claude', 'scripts', 'trace-generate.mjs');

    execSync(
      `node "${scriptPath}"`,
      {
        cwd: testRoot,
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: testRoot },
        timeout: 30000,
      },
    );

    // AC-5.1: Verify all expected files exist
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'high-level.json')));
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'high-level.md')));
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json')));
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.md')));
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json')));
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.md')));
  });

  it('should support --low-level-only flag', () => {
    const scriptPath = join(process.cwd(), '.claude', 'scripts', 'trace-generate.mjs');

    execSync(
      `node "${scriptPath}" --low-level-only`,
      {
        cwd: testRoot,
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: testRoot },
        timeout: 30000,
      },
    );

    // Low-level files should exist
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json')));
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json')));

    // High-level files should NOT exist (since it's --low-level-only)
    assert.ok(!existsSync(join(testRoot, '.claude', 'traces', 'high-level.json')),
      'high-level.json should NOT exist with --low-level-only');
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('edge cases', () => {
  let testRoot;

  afterEach(() => {
    try {
      if (testRoot) {
        rmSync(testRoot, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  });

  it('should handle config with no modules gracefully', () => {
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-edge-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );

    mkdirSync(join(testRoot, '.claude', 'traces'), { recursive: true });
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      JSON.stringify({ version: 1, projectRoot: '.', modules: [] }, null, 2),
    );

    execSync('git init', { cwd: testRoot });
    execSync('git config user.email "test@test.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const result = generateAllTraces({ projectRoot: testRoot });

    assert.equal(result.modulesProcessed, 0, 'No modules to process');
    assert.equal(result.filesGenerated, 2, 'Only high-level files generated');
    assert.equal(result.lowLevelResults.length, 0);
    assert.equal(result.highLevelVersion, 1);
  });

  it('should handle modules with no matching files', () => {
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-empty-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );

    mkdirSync(join(testRoot, '.claude', 'traces'), { recursive: true });
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      JSON.stringify({
        version: 1,
        projectRoot: '.',
        modules: [{
          id: 'empty-module',
          name: 'Empty Module',
          description: 'Module with no files',
          fileGlobs: ['src/nonexistent/**'],
        }],
      }, null, 2),
    );

    execSync('git init', { cwd: testRoot });
    execSync('git config user.email "test@test.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const result = generateAllTraces({ projectRoot: testRoot });

    assert.equal(result.modulesProcessed, 1);
    assert.equal(result.lowLevelResults[0].fileCount, 0, 'Empty module should have 0 files');

    // JSON should still be valid
    const trace = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'low-level', 'empty-module.json'), 'utf-8'),
    );
    const validation = validateLowLevelTrace(trace);
    assert.ok(validation.valid, `Empty module trace should validate: ${validation.errors.join(', ')}`);
    assert.equal(trace.files.length, 0);
  });
});

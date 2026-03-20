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
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs trace-generate-command.test.mjs
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
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
    expect(existsSync(jsonPath)).toBeTruthy();

    const parsed = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    const validation = validateHighLevelTrace(parsed);
    expect(validation.valid).toBeTruthy();
  });

  it('should produce high-level.md', () => {
    generateAllTraces({ projectRoot: testRoot });

    const mdPath = join(testRoot, '.claude', 'traces', 'high-level.md');
    expect(existsSync(mdPath)).toBeTruthy();

    const content = readFileSync(mdPath, 'utf-8');
    expect(content.includes('<!-- trace-id: high-level -->')).toBeTruthy();
    expect(content.includes('# Architecture Trace: High-Level')).toBeTruthy();
    expect(content.includes('## Module: Module Alpha')).toBeTruthy();
    expect(content.includes('## Module: Module Beta')).toBeTruthy();
  });

  it('should produce per-module low-level JSON files', () => {
    generateAllTraces({ projectRoot: testRoot });

    const alphaJsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json');
    const betaJsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json');

    expect(existsSync(alphaJsonPath)).toBeTruthy();
    expect(existsSync(betaJsonPath)).toBeTruthy();

    // Validate JSON schema
    const alphaTrace = JSON.parse(readFileSync(alphaJsonPath, 'utf-8'));
    const alphaValidation = validateLowLevelTrace(alphaTrace);
    expect(alphaValidation.valid).toBeTruthy();
    expect(alphaTrace.moduleId).toBe('module-alpha');

    const betaTrace = JSON.parse(readFileSync(betaJsonPath, 'utf-8'));
    const betaValidation = validateLowLevelTrace(betaTrace);
    expect(betaValidation.valid).toBeTruthy();
    expect(betaTrace.moduleId).toBe('module-beta');
  });

  it('should produce per-module low-level markdown files', () => {
    generateAllTraces({ projectRoot: testRoot });

    const alphaMdPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.md');
    const betaMdPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.md');

    expect(existsSync(alphaMdPath)).toBeTruthy();
    expect(existsSync(betaMdPath)).toBeTruthy();

    const alphaContent = readFileSync(alphaMdPath, 'utf-8');
    expect(alphaContent.includes('<!-- trace-id: module-alpha -->')).toBeTruthy();
    expect(alphaContent.includes('# Low-Level Trace: Module Alpha')).toBeTruthy();
    expect(alphaContent.includes('## File: src/alpha/service.ts')).toBeTruthy();
    expect(alphaContent.includes('## File: src/alpha/index.ts')).toBeTruthy();

    const betaContent = readFileSync(betaMdPath, 'utf-8');
    expect(betaContent.includes('<!-- trace-id: module-beta -->')).toBeTruthy();
    expect(betaContent.includes('## File: src/beta/handler.ts')).toBeTruthy();
  });

  it('should produce exactly 6 trace files (2 high-level + 2x2 low-level)', () => {
    const result = generateAllTraces({ projectRoot: testRoot });

    expect(result.filesGenerated).toBe(6);
    expect(result.modulesProcessed).toBe(2);

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
      expect(existsSync(filePath)).toBeTruthy();
    }
  });

  it('low-level traces should contain correct file entries from static analysis', () => {
    generateAllTraces({ projectRoot: testRoot });

    const alphaTrace = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json'), 'utf-8'),
    );

    // module-alpha has 2 source files
    expect(alphaTrace.files.length).toBe(2);
    const filePaths = alphaTrace.files.map(f => f.filePath).sort();
    expect(filePaths).toEqual(['src/alpha/index.ts', 'src/alpha/service.ts']);

    // Verify service.ts has expected imports/exports
    const serviceEntry = alphaTrace.files.find(f => f.filePath === 'src/alpha/service.ts');
    expect(serviceEntry).toBeTruthy();
    expect(serviceEntry.exports.length > 0).toBeTruthy();
    expect(serviceEntry.imports.length > 0).toBeTruthy();

    const exportSymbols = serviceEntry.exports.map(e => e.symbol);
    expect(exportSymbols.includes('loadData')).toBeTruthy();
    expect(exportSymbols.includes('DataService')).toBeTruthy();
    expect(exportSymbols.includes('VERSION')).toBeTruthy();
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
    expect(existsSync(join(testRoot, '.claude', 'traces', 'low-level'))).toBeFalsy();

    execSync('git init', { cwd: testRoot });
    execSync('git config user.email "test@test.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    generateAllTraces({ projectRoot: testRoot });

    // Verify directories were created
    expect(existsSync(join(testRoot, '.claude', 'traces', 'low-level'))).toBeTruthy();
    expect(existsSync(join(testRoot, '.claude', 'traces', 'high-level.json'))).toBeTruthy();
    expect(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json'))).toBeTruthy();
  });

  it('should handle already-existing directory structure gracefully', () => {
    testRoot = setupTestProject();

    // First generation creates dirs
    generateAllTraces({ projectRoot: testRoot });

    // Second generation should work without error
    const result = generateAllTraces({ projectRoot: testRoot });
    expect(result.modulesProcessed).toBe(2);
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
    expect(result.modulesProcessed).toBe(2);
  });

  it('should report correct filesGenerated count', () => {
    const result = generateAllTraces({ projectRoot: testRoot });
    // 2 high-level files + 2 modules * 2 files each = 6
    expect(result.filesGenerated).toBe(6);
  });

  it('should report positive durationMs', () => {
    const result = generateAllTraces({ projectRoot: testRoot });
    expect(typeof result.durationMs === 'number').toBeTruthy();
    expect(result.durationMs >= 0).toBeTruthy();
  });

  it('should report highLevelVersion', () => {
    const result = generateAllTraces({ projectRoot: testRoot });
    expect(result.highLevelVersion).toBe(1);
  });

  it('should report per-module low-level results', () => {
    const result = generateAllTraces({ projectRoot: testRoot });

    expect(result.lowLevelResults.length).toBe(2);

    const alphaResult = result.lowLevelResults.find(r => r.moduleId === 'module-alpha');
    const betaResult = result.lowLevelResults.find(r => r.moduleId === 'module-beta');

    expect(alphaResult).toBeTruthy();
    expect(betaResult).toBeTruthy();

    expect(alphaResult.fileCount).toBe(2);
    expect(betaResult.fileCount).toBe(1);
    expect(alphaResult.version).toBe(1);
    expect(betaResult.version).toBe(1);
  });

  it('should report null highLevelVersion when --low-level-only', () => {
    const result = generateAllTraces({ projectRoot: testRoot, lowLevelOnly: true });
    expect(result.highLevelVersion).toBe(null);
    // Files: only low-level (2 modules * 2 files = 4)
    expect(result.filesGenerated).toBe(4);
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
    expect(result1.highLevelVersion).toBe(1);

    const result2 = generateAllTraces({ projectRoot: testRoot });
    expect(result2.highLevelVersion).toBe(2);
  });

  it('should increment low-level versions on re-run', () => {
    const result1 = generateAllTraces({ projectRoot: testRoot });
    const alphaV1 = result1.lowLevelResults.find(r => r.moduleId === 'module-alpha');
    expect(alphaV1.version).toBe(1);

    const result2 = generateAllTraces({ projectRoot: testRoot });
    const alphaV2 = result2.lowLevelResults.find(r => r.moduleId === 'module-alpha');
    expect(alphaV2.version).toBe(2);
  });

  it('should update files on re-run', () => {
    generateAllTraces({ projectRoot: testRoot });

    // Read version from high-level.json
    const jsonPath = join(testRoot, '.claude', 'traces', 'high-level.json');
    const v1 = JSON.parse(readFileSync(jsonPath, 'utf-8')).version;
    expect(v1).toBe(1);

    // Re-run
    generateAllTraces({ projectRoot: testRoot });

    const v2 = JSON.parse(readFileSync(jsonPath, 'utf-8')).version;
    expect(v2).toBe(2);
  });

  it('should update markdown metadata on re-run', () => {
    generateAllTraces({ projectRoot: testRoot });

    const mdPath = join(testRoot, '.claude', 'traces', 'high-level.md');
    const md1 = readFileSync(mdPath, 'utf-8');
    expect(md1.includes('<!-- trace-version: 1 -->')).toBeTruthy();

    generateAllTraces({ projectRoot: testRoot });

    const md2 = readFileSync(mdPath, 'utf-8');
    expect(md2.includes('<!-- trace-version: 2 -->')).toBeTruthy();
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
    expect(output.includes('Trace generation complete')).toBeTruthy();
    expect(output.includes('Modules processed: 2')).toBeTruthy();
    expect(output.includes('Files generated: 6')).toBeTruthy();
    expect(output.includes('Duration:')).toBeTruthy();
    expect(output.includes('High-level trace: version 1')).toBeTruthy();
    expect(output.includes('module-alpha:')).toBeTruthy();
    expect(output.includes('module-beta:')).toBeTruthy();
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
    expect(existsSync(join(testRoot, '.claude', 'traces', 'high-level.json'))).toBeTruthy();
    expect(existsSync(join(testRoot, '.claude', 'traces', 'high-level.md'))).toBeTruthy();
    expect(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json'))).toBeTruthy();
    expect(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.md'))).toBeTruthy();
    expect(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json'))).toBeTruthy();
    expect(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.md'))).toBeTruthy();
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
    expect(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json'))).toBeTruthy();
    expect(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json'))).toBeTruthy();

    // High-level files should NOT exist (since it's --low-level-only)
    expect(existsSync(join(testRoot, '.claude', 'traces', 'high-level.json'))).toBeFalsy();
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

    expect(result.modulesProcessed).toBe(0);
    expect(result.filesGenerated).toBe(2);
    expect(result.lowLevelResults.length).toBe(0);
    expect(result.highLevelVersion).toBe(1);
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

    expect(result.modulesProcessed).toBe(1);
    expect(result.lowLevelResults[0].fileCount).toBe(0);

    // JSON should still be valid
    const trace = JSON.parse(
      readFileSync(join(testRoot, '.claude', 'traces', 'low-level', 'empty-module.json'), 'utf-8'),
    );
    const validation = validateLowLevelTrace(trace);
    expect(validation.valid).toBeTruthy();
    expect(trace.files.length).toBe(0);
  });
});

/**
 * Integration tests for single-module trace regeneration (as-006)
 *
 * Tests: as-006-trace-generate-module
 * - AC-5.2: Running `node .claude/scripts/trace-generate.mjs <module-id>` updates
 *   only the specified module's low-level files and the high-level trace.
 *   Other modules' low-level files are not modified.
 * - AC-6.1: If the specified module ID does not exist in trace.config.json,
 *   the command exits with a non-zero code and a descriptive error message
 *   listing available modules.
 *
 * Run with: node --test .claude/scripts/__tests__/trace-generate-module.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { generateAllTraces, validateLowLevelTrace } from '../trace-generate.mjs';
import { validateHighLevelTrace } from '../lib/high-level-trace.mjs';

// =============================================================================
// Test Fixtures
// =============================================================================

/** Create a test config with 3 modules for isolation testing */
function createThreeModuleConfig() {
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
      {
        id: 'module-gamma',
        name: 'Module Gamma',
        description: 'Third test module',
        fileGlobs: ['src/gamma/**'],
      },
    ],
  };
}

const SAMPLE_SOURCE_A = `
import { readFileSync } from 'node:fs';

export function loadAlpha(): string {
  return readFileSync('alpha.json', 'utf-8');
}

export class AlphaService {
  run(): void {}
}
`;

const SAMPLE_SOURCE_B = `
import { AlphaService } from '../alpha/service.js';

export function processBeta(): void {
  const svc = new AlphaService();
  svc.run();
}
`;

const SAMPLE_SOURCE_C = `
export const GAMMA_VERSION = '1.0.0';

export function gammaHelper(): string {
  return GAMMA_VERSION;
}
`;

/**
 * Set up a test project with 3 modules, generate all traces,
 * and return the root directory. This gives us a baseline where
 * all modules have existing traces we can check against.
 */
function setupProjectWithTraces() {
  const timestamp = Date.now();
  const testRoot = join(
    tmpdir(),
    `trace-module-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
  );

  // Create source directories and files
  mkdirSync(join(testRoot, 'src', 'alpha'), { recursive: true });
  mkdirSync(join(testRoot, 'src', 'beta'), { recursive: true });
  mkdirSync(join(testRoot, 'src', 'gamma'), { recursive: true });
  writeFileSync(join(testRoot, 'src', 'alpha', 'service.ts'), SAMPLE_SOURCE_A);
  writeFileSync(join(testRoot, 'src', 'beta', 'handler.ts'), SAMPLE_SOURCE_B);
  writeFileSync(join(testRoot, 'src', 'gamma', 'util.ts'), SAMPLE_SOURCE_C);

  // Write trace config
  mkdirSync(join(testRoot, '.claude', 'traces'), { recursive: true });
  writeFileSync(
    join(testRoot, '.claude', 'traces', 'trace.config.json'),
    JSON.stringify(createThreeModuleConfig(), null, 2),
  );

  // Initialize git repo (required for file discovery)
  execSync('git init', { cwd: testRoot });
  execSync('git config user.email "test@test.com"', { cwd: testRoot });
  execSync('git config user.name "Test"', { cwd: testRoot });
  execSync('git add .', { cwd: testRoot });
  execSync('git commit -m "init"', { cwd: testRoot });

  // Generate all traces first to establish baseline
  generateAllTraces({ projectRoot: testRoot });

  return testRoot;
}

// =============================================================================
// AC-5.2: Single-module generation updates only the target module
// =============================================================================

describe('AC-5.2: Single-module generation updates only the specified module', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = setupProjectWithTraces();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should update the targeted module low-level JSON', () => {
    // Record the initial version of module-alpha
    const alphaJsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json');
    const beforeAlpha = JSON.parse(readFileSync(alphaJsonPath, 'utf-8'));
    assert.equal(beforeAlpha.version, 1, 'Initial version should be 1');

    // Run single-module generation for module-alpha
    const result = generateAllTraces({
      projectRoot: testRoot,
      targetModuleId: 'module-alpha',
    });

    assert.equal(result.modulesProcessed, 1, 'Should process only 1 module');
    assert.equal(result.lowLevelResults.length, 1, 'Should have 1 low-level result');
    assert.equal(result.lowLevelResults[0].moduleId, 'module-alpha');

    // Verify module-alpha was updated (version incremented)
    const afterAlpha = JSON.parse(readFileSync(alphaJsonPath, 'utf-8'));
    assert.equal(afterAlpha.version, 2, 'Alpha version should increment to 2');
  });

  it('should update the targeted module low-level markdown', () => {
    const alphaMdPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.md');
    const beforeMd = readFileSync(alphaMdPath, 'utf-8');
    assert.ok(beforeMd.includes('<!-- trace-version: 1 -->'));

    generateAllTraces({
      projectRoot: testRoot,
      targetModuleId: 'module-alpha',
    });

    const afterMd = readFileSync(alphaMdPath, 'utf-8');
    assert.ok(afterMd.includes('<!-- trace-version: 2 -->'),
      'Markdown should reflect updated version');
  });

  it('should NOT modify other modules low-level JSON files', () => {
    const betaJsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json');
    const gammaJsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-gamma.json');

    // Record before state
    const beforeBeta = readFileSync(betaJsonPath, 'utf-8');
    const beforeGamma = readFileSync(gammaJsonPath, 'utf-8');

    // Run single-module generation for module-alpha only
    generateAllTraces({
      projectRoot: testRoot,
      targetModuleId: 'module-alpha',
    });

    // Verify beta and gamma are unchanged
    const afterBeta = readFileSync(betaJsonPath, 'utf-8');
    const afterGamma = readFileSync(gammaJsonPath, 'utf-8');

    assert.equal(afterBeta, beforeBeta,
      'module-beta.json should be unchanged after module-alpha regeneration');
    assert.equal(afterGamma, beforeGamma,
      'module-gamma.json should be unchanged after module-alpha regeneration');
  });

  it('should NOT modify other modules low-level markdown files', () => {
    const betaMdPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.md');
    const gammaMdPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-gamma.md');

    const beforeBetaMd = readFileSync(betaMdPath, 'utf-8');
    const beforeGammaMd = readFileSync(gammaMdPath, 'utf-8');

    generateAllTraces({
      projectRoot: testRoot,
      targetModuleId: 'module-alpha',
    });

    const afterBetaMd = readFileSync(betaMdPath, 'utf-8');
    const afterGammaMd = readFileSync(gammaMdPath, 'utf-8');

    assert.equal(afterBetaMd, beforeBetaMd,
      'module-beta.md should be unchanged');
    assert.equal(afterGammaMd, beforeGammaMd,
      'module-gamma.md should be unchanged');
  });

  it('should update the high-level trace when regenerating a single module', () => {
    const highJsonPath = join(testRoot, '.claude', 'traces', 'high-level.json');
    const beforeHigh = JSON.parse(readFileSync(highJsonPath, 'utf-8'));
    assert.equal(beforeHigh.version, 1);

    const result = generateAllTraces({
      projectRoot: testRoot,
      targetModuleId: 'module-alpha',
    });

    // High-level trace should be updated (version incremented)
    const afterHigh = JSON.parse(readFileSync(highJsonPath, 'utf-8'));
    assert.equal(afterHigh.version, 2,
      'High-level trace version should increment');
    assert.ok(result.highLevelVersion === 2,
      'Result should report high-level version 2');
  });

  it('should update high-level markdown when regenerating a single module', () => {
    const highMdPath = join(testRoot, '.claude', 'traces', 'high-level.md');
    const beforeMd = readFileSync(highMdPath, 'utf-8');
    assert.ok(beforeMd.includes('<!-- trace-version: 1 -->'));

    generateAllTraces({
      projectRoot: testRoot,
      targetModuleId: 'module-alpha',
    });

    const afterMd = readFileSync(highMdPath, 'utf-8');
    assert.ok(afterMd.includes('<!-- trace-version: 2 -->'),
      'High-level markdown version should increment');
  });

  it('should produce valid JSON for the regenerated module', () => {
    generateAllTraces({
      projectRoot: testRoot,
      targetModuleId: 'module-beta',
    });

    const betaJsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json');
    const trace = JSON.parse(readFileSync(betaJsonPath, 'utf-8'));
    const validation = validateLowLevelTrace(trace);
    assert.ok(validation.valid,
      `Regenerated module-beta.json should validate: ${validation.errors.join(', ')}`);
  });

  it('should produce valid high-level JSON after single-module regeneration', () => {
    generateAllTraces({
      projectRoot: testRoot,
      targetModuleId: 'module-gamma',
    });

    const highJsonPath = join(testRoot, '.claude', 'traces', 'high-level.json');
    const trace = JSON.parse(readFileSync(highJsonPath, 'utf-8'));
    const validation = validateHighLevelTrace(trace);
    assert.ok(validation.valid,
      `High-level JSON should validate after single-module regen: ${validation.errors.join(', ')}`);
  });

  it('should report correct filesGenerated count for single-module mode', () => {
    const result = generateAllTraces({
      projectRoot: testRoot,
      targetModuleId: 'module-alpha',
    });

    // Should generate: 2 high-level files (json + md) + 1 module * 2 files (json + md) = 4
    assert.equal(result.filesGenerated, 4,
      'Single module should generate 4 files (2 high-level + 2 low-level)');
  });

  it('should be faster than full generation', () => {
    // First, do a full regeneration and measure time
    const fullResult = generateAllTraces({ projectRoot: testRoot });

    // Then do single-module regeneration
    const singleResult = generateAllTraces({
      projectRoot: testRoot,
      targetModuleId: 'module-alpha',
    });

    // Single module should process fewer modules
    assert.ok(singleResult.modulesProcessed < fullResult.modulesProcessed,
      'Single-module should process fewer modules than full generation');
    assert.equal(singleResult.modulesProcessed, 1);
    assert.equal(fullResult.modulesProcessed, 3);
  });

  it('should work for each module individually', () => {
    // Test that we can target any of the 3 modules
    for (const moduleId of ['module-alpha', 'module-beta', 'module-gamma']) {
      const result = generateAllTraces({
        projectRoot: testRoot,
        targetModuleId: moduleId,
      });

      assert.equal(result.modulesProcessed, 1, `Should process only ${moduleId}`);
      assert.equal(result.lowLevelResults[0].moduleId, moduleId);
    }
  });
});

// =============================================================================
// AC-6.1: Invalid module ID error handling
// =============================================================================

describe('AC-6.1: Invalid module ID produces descriptive error with available modules', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = setupProjectWithTraces();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should throw error for unknown module ID', () => {
    assert.throws(
      () => generateAllTraces({
        projectRoot: testRoot,
        targetModuleId: 'nonexistent-module',
      }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('nonexistent-module'),
          'Error should mention the requested module ID');
        return true;
      },
    );
  });

  it('should list available module IDs in the error message', () => {
    try {
      generateAllTraces({
        projectRoot: testRoot,
        targetModuleId: 'nonexistent-module',
      });
      assert.fail('Should have thrown an error');
    } catch (err) {
      // Should list all 3 available modules
      assert.ok(err.message.includes('module-alpha'),
        'Error should list module-alpha as available');
      assert.ok(err.message.includes('module-beta'),
        'Error should list module-beta as available');
      assert.ok(err.message.includes('module-gamma'),
        'Error should list module-gamma as available');
      assert.ok(err.message.includes('Available modules'),
        'Error should have "Available modules" label');
    }
  });

  it('should exit with non-zero code when run via CLI with invalid module', () => {
    const scriptPath = join(process.cwd(), '.claude', 'scripts', 'trace-generate.mjs');

    try {
      execSync(
        `node "${scriptPath}" nonexistent-module`,
        {
          cwd: testRoot,
          encoding: 'utf-8',
          env: { ...process.env, CLAUDE_PROJECT_DIR: testRoot },
          timeout: 30000,
        },
      );
      assert.fail('Should have exited with non-zero code');
    } catch (err) {
      // execSync throws on non-zero exit code
      assert.ok(err.status !== 0, 'Should exit with non-zero code');
      assert.ok(err.stderr.includes('nonexistent-module'),
        'stderr should mention the invalid module');
      assert.ok(err.stderr.includes('Available modules'),
        'stderr should list available modules');
    }
  });

  it('should handle empty string module ID as full generation', () => {
    // Empty string is falsy in JS, so it behaves like no targetModuleId
    // (falls through to full generation mode)
    const result = generateAllTraces({
      projectRoot: testRoot,
      targetModuleId: '',
    });

    assert.equal(result.modulesProcessed, 3,
      'Empty string should fall back to full generation');
  });
});

// =============================================================================
// CLI execution for single-module mode
// =============================================================================

describe('CLI: single-module generation via command line', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = setupProjectWithTraces();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should accept module-id as positional argument', () => {
    const scriptPath = join(process.cwd(), '.claude', 'scripts', 'trace-generate.mjs');

    const output = execSync(
      `node "${scriptPath}" module-alpha`,
      {
        cwd: testRoot,
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: testRoot },
        timeout: 30000,
      },
    );

    assert.ok(output.includes('Trace generation complete'),
      'Should print completion message');
    assert.ok(output.includes('module-alpha'),
      'Should mention the targeted module');
    assert.ok(output.includes('Modules processed: 1'),
      'Should report 1 module processed');
  });

  it('should only update targeted module files via CLI', () => {
    const scriptPath = join(process.cwd(), '.claude', 'scripts', 'trace-generate.mjs');

    // Record before state of non-targeted modules
    const betaJsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json');
    const gammaJsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-gamma.json');
    const beforeBeta = readFileSync(betaJsonPath, 'utf-8');
    const beforeGamma = readFileSync(gammaJsonPath, 'utf-8');

    // Run CLI with module-alpha target
    execSync(
      `node "${scriptPath}" module-alpha`,
      {
        cwd: testRoot,
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: testRoot },
        timeout: 30000,
      },
    );

    // Verify non-targeted modules unchanged
    const afterBeta = readFileSync(betaJsonPath, 'utf-8');
    const afterGamma = readFileSync(gammaJsonPath, 'utf-8');

    assert.equal(afterBeta, beforeBeta,
      'module-beta.json should be unchanged after CLI module-alpha generation');
    assert.equal(afterGamma, beforeGamma,
      'module-gamma.json should be unchanged after CLI module-alpha generation');

    // Verify targeted module was updated
    const alphaJsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json');
    const afterAlpha = JSON.parse(readFileSync(alphaJsonPath, 'utf-8'));
    assert.equal(afterAlpha.version, 2,
      'module-alpha.json version should increment to 2');
  });

  it('backward compatibility: no args still runs full generation', () => {
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

    assert.ok(output.includes('Modules processed: 3'),
      'Full generation should process all 3 modules');
    assert.ok(output.includes('Trace generation complete.'),
      'Should show completion without module label');
  });
});

// =============================================================================
// Edge cases for single-module generation
// =============================================================================

describe('edge cases: single-module generation', () => {
  let testRoot;

  afterEach(() => {
    try {
      if (testRoot) {
        rmSync(testRoot, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  });

  it('should work when only the targeted module has source files', () => {
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-edge-module-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );

    mkdirSync(join(testRoot, 'src', 'alpha'), { recursive: true });
    writeFileSync(join(testRoot, 'src', 'alpha', 'index.ts'), 'export const x = 1;');

    mkdirSync(join(testRoot, '.claude', 'traces'), { recursive: true });
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      JSON.stringify(createThreeModuleConfig(), null, 2),
    );

    execSync('git init', { cwd: testRoot });
    execSync('git config user.email "test@test.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const result = generateAllTraces({
      projectRoot: testRoot,
      targetModuleId: 'module-alpha',
    });

    assert.equal(result.modulesProcessed, 1);
    assert.equal(result.lowLevelResults[0].fileCount, 1);

    // Verify only module-alpha files exist in low-level
    assert.ok(existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-alpha.json')));
    assert.ok(!existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json')),
      'module-beta should not have trace files');
    assert.ok(!existsSync(join(testRoot, '.claude', 'traces', 'low-level', 'module-gamma.json')),
      'module-gamma should not have trace files');
  });

  it('should work when targeted module has no matching files', () => {
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-empty-module-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );

    // No source files at all
    mkdirSync(join(testRoot, '.claude', 'traces'), { recursive: true });
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      JSON.stringify(createThreeModuleConfig(), null, 2),
    );

    execSync('git init', { cwd: testRoot });
    execSync('git config user.email "test@test.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const result = generateAllTraces({
      projectRoot: testRoot,
      targetModuleId: 'module-alpha',
    });

    assert.equal(result.modulesProcessed, 1);
    assert.equal(result.lowLevelResults[0].fileCount, 0,
      'Module with no files should still succeed with 0 files');
  });

  it('should handle repeated single-module regeneration (version incrementing)', () => {
    testRoot = setupProjectWithTraces();

    // Run single-module 3 times
    for (let i = 0; i < 3; i++) {
      generateAllTraces({
        projectRoot: testRoot,
        targetModuleId: 'module-beta',
      });
    }

    const betaJsonPath = join(testRoot, '.claude', 'traces', 'low-level', 'module-beta.json');
    const trace = JSON.parse(readFileSync(betaJsonPath, 'utf-8'));

    // Initial full gen = v1, then 3 single-module regens = v4
    assert.equal(trace.version, 4,
      'Version should increment with each regeneration (1 + 3 = 4)');
  });
});

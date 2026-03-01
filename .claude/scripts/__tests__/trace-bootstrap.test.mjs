/**
 * Tests for trace bootstrap functionality (as-013)
 *
 * Tests: as-013-trace-bootstrap (AC-13.1, AC-13.2, AC-13.3, AC-13.4)
 *
 * Validates:
 * - AC-13.1: Running trace generate in a project with no .claude/traces/ directory
 *   creates the directory structure and generates a trace.config.json with auto-detected modules.
 * - AC-13.2: Auto-detected modules are based on project structure (apps/, packages/, .claude/scripts/).
 * - AC-13.3: Bootstrap outputs a message to stdout prompting the user to review module boundaries.
 * - AC-13.4: After bootstrap, running trace generate again does NOT re-enter bootstrap mode.
 *
 * Run with: node --test .claude/scripts/__tests__/trace-bootstrap.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import {
  autoDetectModules,
  bootstrapTraceConfig,
  dirNameToModuleName,
  dirNameToModuleId,
  generateAllTraces,
} from '../trace-generate.mjs';

// =============================================================================
// Unit tests: dirNameToModuleName
// =============================================================================

describe('dirNameToModuleName', () => {
  it('should convert kebab-case to Title Case', () => {
    assert.equal(dirNameToModuleName('node-server'), 'Node Server');
  });

  it('should convert snake_case to Title Case', () => {
    assert.equal(dirNameToModuleName('agent_orchestrator'), 'Agent Orchestrator');
  });

  it('should handle single word', () => {
    assert.equal(dirNameToModuleName('core'), 'Core');
  });

  it('should handle already capitalized', () => {
    assert.equal(dirNameToModuleName('Utils'), 'Utils');
  });
});

// =============================================================================
// Unit tests: dirNameToModuleId
// =============================================================================

describe('dirNameToModuleId', () => {
  it('should return lowercase kebab-case', () => {
    assert.equal(dirNameToModuleId('node-server'), 'node-server');
  });

  it('should convert uppercase to lowercase', () => {
    assert.equal(dirNameToModuleId('MyApp'), 'myapp');
  });

  it('should convert underscores to hyphens', () => {
    assert.equal(dirNameToModuleId('agent_orchestrator'), 'agent-orchestrator');
  });

  it('should add prefix when provided', () => {
    assert.equal(dirNameToModuleId('core', 'pkg'), 'pkg-core');
  });

  it('should strip non-alphanumeric-hyphen characters', () => {
    assert.equal(dirNameToModuleId('my.app!'), 'myapp');
  });
});

// =============================================================================
// Unit tests: autoDetectModules
// =============================================================================

describe('autoDetectModules', () => {
  let testRoot;

  afterEach(() => {
    try {
      if (testRoot) {
        rmSync(testRoot, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  });

  it('should detect apps/ subdirectories as modules (AC-13.2)', () => {
    testRoot = join(
      tmpdir(),
      `trace-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'apps', 'node-server'), { recursive: true });
    mkdirSync(join(testRoot, 'apps', 'client-website'), { recursive: true });

    const modules = autoDetectModules(testRoot);

    const ids = modules.map((m) => m.id);
    assert.ok(ids.includes('node-server'), 'Should detect node-server');
    assert.ok(ids.includes('client-website'), 'Should detect client-website');

    const nodeServer = modules.find((m) => m.id === 'node-server');
    assert.deepEqual(nodeServer.fileGlobs, ['apps/node-server/**']);
  });

  it('should detect packages/ subdirectories as modules with pkg- prefix (AC-13.2)', () => {
    testRoot = join(
      tmpdir(),
      `trace-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'packages', 'core'), { recursive: true });
    mkdirSync(join(testRoot, 'packages', 'utils'), { recursive: true });

    const modules = autoDetectModules(testRoot);

    const ids = modules.map((m) => m.id);
    assert.ok(ids.includes('pkg-core'), 'Should detect pkg-core');
    assert.ok(ids.includes('pkg-utils'), 'Should detect pkg-utils');

    const pkgCore = modules.find((m) => m.id === 'pkg-core');
    assert.deepEqual(pkgCore.fileGlobs, ['packages/core/**']);
    assert.ok(pkgCore.name.includes('Package'), 'Name should include Package');
  });

  it('should detect .claude/scripts/ as a module (AC-13.2)', () => {
    testRoot = join(
      tmpdir(),
      `trace-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, '.claude', 'scripts'), { recursive: true });

    const modules = autoDetectModules(testRoot);

    const ids = modules.map((m) => m.id);
    assert.ok(ids.includes('claude-scripts'), 'Should detect claude-scripts');
  });

  it('should detect src/ as a fallback for non-monorepo projects', () => {
    testRoot = join(
      tmpdir(),
      `trace-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'src'), { recursive: true });

    const modules = autoDetectModules(testRoot);

    const ids = modules.map((m) => m.id);
    assert.ok(ids.includes('src'), 'Should detect src as a module');
  });

  it('should skip hidden directories in apps/', () => {
    testRoot = join(
      tmpdir(),
      `trace-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'apps', '.hidden'), { recursive: true });
    mkdirSync(join(testRoot, 'apps', 'visible'), { recursive: true });

    const modules = autoDetectModules(testRoot);

    const ids = modules.map((m) => m.id);
    assert.ok(
      !ids.some((id) => id.includes('hidden')),
      'Should not detect hidden directories',
    );
    assert.ok(ids.includes('visible'), 'Should detect visible directories');
  });

  it('should return empty array for project with no recognizable structure', () => {
    testRoot = join(
      tmpdir(),
      `trace-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testRoot, { recursive: true });

    const modules = autoDetectModules(testRoot);
    assert.equal(modules.length, 0, 'Should return no modules');
  });
});

// =============================================================================
// Integration tests: bootstrapTraceConfig
// =============================================================================

describe('bootstrapTraceConfig', () => {
  let testRoot;

  afterEach(() => {
    try {
      if (testRoot) {
        rmSync(testRoot, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  });

  it('should create trace.config.json with auto-detected modules (AC-13.1)', () => {
    testRoot = join(
      tmpdir(),
      `trace-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'apps', 'my-app'), { recursive: true });
    mkdirSync(join(testRoot, 'packages', 'shared'), { recursive: true });

    const { config, configPath } = bootstrapTraceConfig(testRoot);

    assert.ok(existsSync(configPath), 'trace.config.json should be created');
    assert.equal(config.version, 1);
    assert.equal(config.projectRoot, '.');
    assert.ok(config.modules.length > 0, 'Should have auto-detected modules');

    // Verify the file is valid JSON
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.equal(parsed.version, 1);
    assert.ok(Array.isArray(parsed.modules));
  });

  it('should create .claude/traces/ directory if it does not exist (AC-13.1)', () => {
    testRoot = join(
      tmpdir(),
      `trace-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'apps', 'my-app'), { recursive: true });

    assert.ok(
      !existsSync(join(testRoot, '.claude', 'traces')),
      'traces/ should not exist yet',
    );

    bootstrapTraceConfig(testRoot);

    assert.ok(
      existsSync(join(testRoot, '.claude', 'traces')),
      'traces/ should be created',
    );
    assert.ok(
      existsSync(join(testRoot, '.claude', 'traces', 'trace.config.json')),
      'trace.config.json should exist',
    );
  });

  it('should throw if trace.config.json already exists (AC-13.4)', () => {
    testRoot = join(
      tmpdir(),
      `trace-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, '.claude', 'traces'), { recursive: true });
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      '{"version":1,"modules":[]}',
    );

    assert.throws(
      () => bootstrapTraceConfig(testRoot),
      /already exists/,
      'Should throw when config already exists',
    );
  });
});

// =============================================================================
// Integration tests: --bootstrap flag via CLI
// =============================================================================

describe('--bootstrap CLI integration', () => {
  let testRoot;

  afterEach(() => {
    try {
      if (testRoot) {
        rmSync(testRoot, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  });

  it('should bootstrap and generate traces in a fresh project (AC-13.1, AC-13.3)', () => {
    testRoot = join(
      tmpdir(),
      `trace-bootstrap-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'apps', 'service-a', 'src'), { recursive: true });
    mkdirSync(join(testRoot, 'packages', 'lib'), { recursive: true });
    writeFileSync(
      join(testRoot, 'apps', 'service-a', 'src', 'index.ts'),
      'export const x = 1;',
    );
    writeFileSync(
      join(testRoot, 'packages', 'lib', 'index.ts'),
      'export const y = 2;',
    );

    // Initialize git repo (required for file discovery)
    execSync('git init', { cwd: testRoot });
    execSync('git config user.email "test@test.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const scriptPath = join(
      process.cwd(),
      '.claude',
      'scripts',
      'trace-generate.mjs',
    );

    const output = execSync(`node "${scriptPath}" --bootstrap`, {
      cwd: testRoot,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: testRoot },
      timeout: 30000,
    });

    // AC-13.3: Should prompt user to review
    assert.ok(
      output.includes('Bootstrap complete'),
      'Should print bootstrap message',
    );
    assert.ok(
      output.includes('Review and refine'),
      'Should prompt to review config',
    );
    assert.ok(
      output.includes('trace.config.json'),
      'Should mention config file',
    );

    // AC-13.1: Config should exist
    const configPath = join(
      testRoot,
      '.claude',
      'traces',
      'trace.config.json',
    );
    assert.ok(existsSync(configPath), 'trace.config.json should be created');

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.ok(config.modules.length > 0, 'Should have modules');

    // Should have generated trace files
    assert.ok(
      output.includes('Trace generation complete'),
      'Should complete generation',
    );
    assert.ok(
      existsSync(join(testRoot, '.claude', 'traces', 'high-level.json')),
      'high-level.json should exist after bootstrap',
    );
  });

  it('should not re-bootstrap when config exists (AC-13.4)', () => {
    testRoot = join(
      tmpdir(),
      `trace-bootstrap-rerun-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'apps', 'my-app', 'src'), { recursive: true });
    writeFileSync(
      join(testRoot, 'apps', 'my-app', 'src', 'index.ts'),
      'export const x = 1;',
    );

    // Pre-create config
    mkdirSync(join(testRoot, '.claude', 'traces'), { recursive: true });
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      JSON.stringify(
        {
          version: 1,
          projectRoot: '.',
          modules: [
            {
              id: 'my-app',
              name: 'My App',
              description: 'Test',
              fileGlobs: ['apps/my-app/**'],
            },
          ],
        },
        null,
        2,
      ),
    );

    // Initialize git repo
    execSync('git init', { cwd: testRoot });
    execSync('git config user.email "test@test.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const scriptPath = join(
      process.cwd(),
      '.claude',
      'scripts',
      'trace-generate.mjs',
    );

    const output = execSync(`node "${scriptPath}" --bootstrap`, {
      cwd: testRoot,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: testRoot },
      timeout: 30000,
    });

    // AC-13.4: Should skip bootstrap
    assert.ok(
      output.includes('already exists'),
      'Should note config already exists',
    );
    assert.ok(
      output.includes('Skipping bootstrap'),
      'Should skip bootstrap',
    );

    // Should still generate traces
    assert.ok(
      output.includes('Trace generation complete'),
      'Should still generate traces',
    );
  });

  it('should detect modules from project structure in output (AC-13.2)', () => {
    testRoot = join(
      tmpdir(),
      `trace-bootstrap-detect-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'apps', 'api-server'), { recursive: true });
    mkdirSync(join(testRoot, 'apps', 'web-client'), { recursive: true });
    mkdirSync(join(testRoot, 'packages', 'shared'), { recursive: true });

    // Need at least one file for git
    writeFileSync(
      join(testRoot, 'apps', 'api-server', 'index.ts'),
      'export const x = 1;',
    );

    execSync('git init', { cwd: testRoot });
    execSync('git config user.email "test@test.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const scriptPath = join(
      process.cwd(),
      '.claude',
      'scripts',
      'trace-generate.mjs',
    );

    const output = execSync(`node "${scriptPath}" --bootstrap`, {
      cwd: testRoot,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: testRoot },
      timeout: 30000,
    });

    // AC-13.2: Should list detected modules
    assert.ok(output.includes('api-server'), 'Should detect api-server');
    assert.ok(output.includes('web-client'), 'Should detect web-client');
    assert.ok(output.includes('pkg-shared'), 'Should detect pkg-shared');
  });
});

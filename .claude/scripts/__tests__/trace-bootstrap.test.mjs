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
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs trace-bootstrap.test.mjs
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
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
    expect(dirNameToModuleName('node-server')).toBe('Node Server');
  });

  it('should convert snake_case to Title Case', () => {
    expect(dirNameToModuleName('agent_orchestrator')).toBe('Agent Orchestrator');
  });

  it('should handle single word', () => {
    expect(dirNameToModuleName('core')).toBe('Core');
  });

  it('should handle already capitalized', () => {
    expect(dirNameToModuleName('Utils')).toBe('Utils');
  });
});

// =============================================================================
// Unit tests: dirNameToModuleId
// =============================================================================

describe('dirNameToModuleId', () => {
  it('should return lowercase kebab-case', () => {
    expect(dirNameToModuleId('node-server')).toBe('node-server');
  });

  it('should convert uppercase to lowercase', () => {
    expect(dirNameToModuleId('MyApp')).toBe('myapp');
  });

  it('should convert underscores to hyphens', () => {
    expect(dirNameToModuleId('agent_orchestrator')).toBe('agent-orchestrator');
  });

  it('should add prefix when provided', () => {
    expect(dirNameToModuleId('core', 'pkg')).toBe('pkg-core');
  });

  it('should strip non-alphanumeric-hyphen characters', () => {
    expect(dirNameToModuleId('my.app!')).toBe('myapp');
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
    expect(ids.includes('node-server')).toBeTruthy();
    expect(ids.includes('client-website')).toBeTruthy();

    const nodeServer = modules.find((m) => m.id === 'node-server');
    expect(nodeServer.fileGlobs).toEqual(['apps/node-server/**']);
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
    expect(ids.includes('pkg-core')).toBeTruthy();
    expect(ids.includes('pkg-utils')).toBeTruthy();

    const pkgCore = modules.find((m) => m.id === 'pkg-core');
    expect(pkgCore.fileGlobs).toEqual(['packages/core/**']);
    expect(pkgCore.name.includes('Package')).toBeTruthy();
  });

  it('should detect .claude/scripts/ as a module (AC-13.2)', () => {
    testRoot = join(
      tmpdir(),
      `trace-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, '.claude', 'scripts'), { recursive: true });

    const modules = autoDetectModules(testRoot);

    const ids = modules.map((m) => m.id);
    expect(ids.includes('claude-scripts')).toBeTruthy();
  });

  it('should detect src/ as a fallback for non-monorepo projects', () => {
    testRoot = join(
      tmpdir(),
      `trace-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'src'), { recursive: true });

    const modules = autoDetectModules(testRoot);

    const ids = modules.map((m) => m.id);
    expect(ids.includes('src')).toBeTruthy();
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
    expect(ids.some((id) => id.includes('hidden'))).toBeFalsy();
    expect(ids.includes('visible')).toBeTruthy();
  });

  it('should return empty array for project with no recognizable structure', () => {
    testRoot = join(
      tmpdir(),
      `trace-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testRoot, { recursive: true });

    const modules = autoDetectModules(testRoot);
    expect(modules.length).toBe(0);
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

    expect(existsSync(configPath)).toBeTruthy();
    expect(config.version).toBe(1);
    expect(config.projectRoot).toBe('.');
    expect(config.modules.length > 0).toBeTruthy();

    // Verify the file is valid JSON
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.modules)).toBeTruthy();
  });

  it('should create .claude/traces/ directory if it does not exist (AC-13.1)', () => {
    testRoot = join(
      tmpdir(),
      `trace-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, 'apps', 'my-app'), { recursive: true });

    expect(existsSync(join(testRoot, '.claude', 'traces'))).toBeFalsy();

    bootstrapTraceConfig(testRoot);

    expect(existsSync(join(testRoot, '.claude', 'traces'))).toBeTruthy();
    expect(existsSync(join(testRoot, '.claude', 'traces', 'trace.config.json'))).toBeTruthy();
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

    expect(() => bootstrapTraceConfig(testRoot)).toThrow(/already exists/);
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
    expect(output.includes('Bootstrap complete')).toBeTruthy();
    expect(output.includes('Review and refine')).toBeTruthy();
    expect(output.includes('trace.config.json')).toBeTruthy();

    // AC-13.1: Config should exist
    const configPath = join(
      testRoot,
      '.claude',
      'traces',
      'trace.config.json',
    );
    expect(existsSync(configPath)).toBeTruthy();

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.modules.length > 0).toBeTruthy();

    // Should have generated trace files
    expect(output.includes('Trace generation complete')).toBeTruthy();
    expect(existsSync(join(testRoot, '.claude', 'traces', 'high-level.json'))).toBeTruthy();
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
    expect(output.includes('already exists')).toBeTruthy();
    expect(output.includes('Skipping bootstrap')).toBeTruthy();

    // Should still generate traces
    expect(output.includes('Trace generation complete')).toBeTruthy();
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
    expect(output.includes('api-server')).toBeTruthy();
    expect(output.includes('web-client')).toBeTruthy();
    expect(output.includes('pkg-shared')).toBeTruthy();
  });
});

/**
 * Integration tests for trace-commit-staleness.mjs
 *
 * Tests: as-009-trace-commit-staleness (AC-8.1 through AC-8.5)
 *
 * Uses a temporary git repo with mock trace data to test:
 * - Fresh traces (exit 0) -- AC-8.1
 * - Stale traces (exit 2) -- AC-8.2
 * - Non-commit commands (exit 0) -- AC-8.3
 * - Untraced files only (exit 0) -- AC-8.4
 * - Missing trace system (exit 0) -- AC-8.5
 *
 * Run with: node --test .claude/scripts/__tests__/trace-commit-staleness.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the hook script under test */
const HOOK_SCRIPT = join(__dirname, '..', 'trace-commit-staleness.mjs');

/**
 * Run the hook script with given stdin JSON input and an overridden project root.
 *
 * @param {object} stdinData - JSON object to pipe to stdin
 * @param {string} projectRoot - Project root to set via CLAUDE_PROJECT_DIR
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
function runHook(stdinData, projectRoot) {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK_SCRIPT], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectRoot,
      },
      cwd: projectRoot,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });

    // Write stdin and close
    const input = JSON.stringify(stdinData);
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Create a sample trace.config.json for testing.
 */
function createTestConfig() {
  return {
    version: 1,
    projectRoot: '.',
    modules: [
      {
        id: 'app-core',
        name: 'App Core',
        description: 'Core application logic',
        fileGlobs: ['src/core/**'],
      },
      {
        id: 'app-ui',
        name: 'App UI',
        description: 'UI components',
        fileGlobs: ['src/ui/**'],
      },
    ],
  };
}

/**
 * Helper: create a test git repo with trace infrastructure.
 *
 * @param {string} testRoot - Root directory for the temp repo
 * @param {object} [options] - Setup options
 * @param {boolean} [options.skipTraceConfig] - Don't create trace.config.json
 * @param {boolean} [options.skipTracesDir] - Don't create .claude/traces/ directory
 */
function setupTestRepo(testRoot, options = {}) {
  // Create directory structure
  mkdirSync(join(testRoot, 'src', 'core'), { recursive: true });
  mkdirSync(join(testRoot, 'src', 'ui'), { recursive: true });
  mkdirSync(join(testRoot, 'docs'), { recursive: true });

  if (!options.skipTracesDir) {
    mkdirSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true });
  }

  // Initialize git repo
  execSync('git init', { cwd: testRoot, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: testRoot, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: testRoot, stdio: 'pipe' });

  // Create trace config
  if (!options.skipTraceConfig && !options.skipTracesDir) {
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      JSON.stringify(createTestConfig(), null, 2),
    );
  }

  // Create an initial commit so HEAD exists
  writeFileSync(join(testRoot, '.gitignore'), '');
  execSync('git add .gitignore', { cwd: testRoot, stdio: 'pipe' });
  execSync('git commit -m "initial commit"', { cwd: testRoot, stdio: 'pipe' });
}

/**
 * Helper: create a low-level trace file for a module.
 *
 * @param {string} testRoot - Temp project root
 * @param {string} moduleId - Module identifier
 * @param {string} lastGenerated - ISO timestamp for lastGenerated
 */
function createTraceFile(testRoot, moduleId, lastGenerated) {
  writeFileSync(
    join(testRoot, '.claude', 'traces', 'low-level', `${moduleId}.json`),
    JSON.stringify({
      moduleId,
      version: 1,
      lastGenerated,
      generatedBy: 'test',
      files: [],
    }),
  );
}

/**
 * Helper: create a source file, add and commit it.
 *
 * @param {string} testRoot - Temp project root
 * @param {string} filePath - Relative file path
 * @param {string} [content] - File content
 */
function commitFile(testRoot, filePath, content = 'export default {};') {
  const fullPath = join(testRoot, filePath);
  writeFileSync(fullPath, content);
  execSync(`git add "${filePath}"`, { cwd: testRoot, stdio: 'pipe' });
  execSync(`git commit -m "add ${filePath}"`, { cwd: testRoot, stdio: 'pipe' });
}

// ============================================================
// AC-8.3: Non-git-commit commands exit 0 immediately
// ============================================================

describe('AC-8.3: Non-git-commit Bash commands', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `trace-commit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestRepo(testRoot);
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should exit 0 for git status command', async () => {
    const result = await runHook(
      { tool_input: { command: 'git status' } },
      testRoot,
    );
    assert.equal(result.exitCode, 0);
  });

  it('should exit 0 for ls command', async () => {
    const result = await runHook(
      { tool_input: { command: 'ls -la' } },
      testRoot,
    );
    assert.equal(result.exitCode, 0);
  });

  it('should exit 0 for npm test command', async () => {
    const result = await runHook(
      { tool_input: { command: 'npm test' } },
      testRoot,
    );
    assert.equal(result.exitCode, 0);
  });

  it('should exit 0 for git diff command', async () => {
    const result = await runHook(
      { tool_input: { command: 'git diff HEAD~1' } },
      testRoot,
    );
    assert.equal(result.exitCode, 0);
  });

  it('should exit 0 for git log command', async () => {
    const result = await runHook(
      { tool_input: { command: 'git log --oneline -5' } },
      testRoot,
    );
    assert.equal(result.exitCode, 0);
  });

  it('should exit 0 for empty input', async () => {
    const result = await runHook({}, testRoot);
    assert.equal(result.exitCode, 0);
  });

  it('should exit 0 for malformed JSON stdin', async () => {
    // Send raw string via spawn instead of JSON
    const child = spawn('node', [HOOK_SCRIPT], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: testRoot },
      cwd: testRoot,
    });

    const exitCode = await new Promise((resolve) => {
      child.on('close', resolve);
      child.stdin.write('not valid json');
      child.stdin.end();
    });

    assert.equal(exitCode, 0);
  });

  it('should exit 0 for missing tool_input', async () => {
    const result = await runHook({ something_else: true }, testRoot);
    assert.equal(result.exitCode, 0);
  });
});

// ============================================================
// AC-8.5: No trace system configured
// ============================================================

describe('AC-8.5: Missing trace system', () => {
  let testRoot;

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should exit 0 when trace.config.json does not exist', async () => {
    testRoot = join(
      tmpdir(),
      `trace-commit-no-config-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestRepo(testRoot, { skipTraceConfig: true });

    // Commit a file in a traced module path (but no config to resolve it)
    commitFile(testRoot, 'src/core/index.ts');

    const result = await runHook(
      { tool_input: { command: 'git commit -m "test"' } },
      testRoot,
    );
    assert.equal(result.exitCode, 0);
  });

  it('should exit 0 when .claude/traces/ directory does not exist', async () => {
    testRoot = join(
      tmpdir(),
      `trace-commit-no-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestRepo(testRoot, { skipTracesDir: true, skipTraceConfig: true });

    commitFile(testRoot, 'src/core/index.ts');

    const result = await runHook(
      { tool_input: { command: 'git commit -m "test"' } },
      testRoot,
    );
    assert.equal(result.exitCode, 0);
  });
});

// ============================================================
// AC-8.1: Commit with fresh traces exits 0
// ============================================================

describe('AC-8.1: Commit with fresh traces', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `trace-commit-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestRepo(testRoot);
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should exit 0 when committed file module has fresh trace', async () => {
    // Create source file with old timestamp
    const srcFile = join(testRoot, 'src', 'core', 'service.ts');
    writeFileSync(srcFile, 'export class Service {}');
    const twoHoursAgo = new Date(Date.now() - 7200_000);
    utimesSync(srcFile, twoHoursAgo, twoHoursAgo);

    // Create a fresh trace (more recent than the source file)
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    createTraceFile(testRoot, 'app-core', oneHourAgo);

    // Add and commit the source file
    execSync('git add src/core/service.ts', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "add service"', { cwd: testRoot, stdio: 'pipe' });

    const result = await runHook(
      { tool_input: { command: 'git commit -m "add service"' } },
      testRoot,
    );
    assert.equal(result.exitCode, 0, `Expected exit 0 but got ${result.exitCode}. stderr: ${result.stderr}`);
  });

  it('should exit 0 when multiple modules all have fresh traces', async () => {
    // Create files in two modules with old timestamps
    const coreFile = join(testRoot, 'src', 'core', 'index.ts');
    const uiFile = join(testRoot, 'src', 'ui', 'button.tsx');
    writeFileSync(coreFile, 'export const x = 1;');
    writeFileSync(uiFile, 'export const Button = () => {};');

    const threeHoursAgo = new Date(Date.now() - 10800_000);
    utimesSync(coreFile, threeHoursAgo, threeHoursAgo);
    utimesSync(uiFile, threeHoursAgo, threeHoursAgo);

    // Fresh traces for both modules
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    createTraceFile(testRoot, 'app-core', oneHourAgo);
    createTraceFile(testRoot, 'app-ui', oneHourAgo);

    // Commit both files
    execSync('git add src/core/index.ts src/ui/button.tsx', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "add files"', { cwd: testRoot, stdio: 'pipe' });

    const result = await runHook(
      { tool_input: { command: 'git commit -m "add files"' } },
      testRoot,
    );
    assert.equal(result.exitCode, 0, `Expected exit 0 but got ${result.exitCode}. stderr: ${result.stderr}`);
  });
});

// ============================================================
// AC-8.2: Commit with stale traces exits 2
// ============================================================

describe('AC-8.2: Commit with stale traces', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `trace-commit-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestRepo(testRoot);
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should exit 2 when committed file module has stale trace', async () => {
    // Create a stale trace (old lastGenerated)
    const twoHoursAgo = new Date(Date.now() - 7200_000).toISOString();
    createTraceFile(testRoot, 'app-core', twoHoursAgo);

    // Create source file with current timestamp (newer than trace)
    const srcFile = join(testRoot, 'src', 'core', 'service.ts');
    writeFileSync(srcFile, 'export class Service {}');

    // Commit the file
    execSync('git add src/core/service.ts', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "add service"', { cwd: testRoot, stdio: 'pipe' });

    const result = await runHook(
      { tool_input: { command: 'git commit -m "add service"' } },
      testRoot,
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes('app-core'), 'Should mention stale module name');
    assert.ok(result.stderr.includes('BLOCKED'), 'Should include BLOCKED header');
    assert.ok(
      result.stderr.includes('trace-generate.mjs'),
      'Should suggest regeneration command',
    );
  });

  it('should list all stale modules in the error message', async () => {
    // Both modules have stale traces
    const twoHoursAgo = new Date(Date.now() - 7200_000).toISOString();
    createTraceFile(testRoot, 'app-core', twoHoursAgo);
    createTraceFile(testRoot, 'app-ui', twoHoursAgo);

    // Create files in both modules (newer than traces)
    writeFileSync(join(testRoot, 'src', 'core', 'a.ts'), 'export const a = 1;');
    writeFileSync(join(testRoot, 'src', 'ui', 'b.tsx'), 'export const B = () => {};');

    execSync('git add src/core/a.ts src/ui/b.tsx', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "add both"', { cwd: testRoot, stdio: 'pipe' });

    const result = await runHook(
      { tool_input: { command: 'git commit -m "add both"' } },
      testRoot,
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes('app-core'), 'Should list app-core module');
    assert.ok(result.stderr.includes('app-ui'), 'Should list app-ui module');
  });

  it('should exit 2 when trace file is missing entirely', async () => {
    // No trace file for app-core -> isTraceStale returns true
    // (trace file missing = stale)

    // Create and commit a source file
    writeFileSync(join(testRoot, 'src', 'core', 'index.ts'), 'export default {};');
    execSync('git add src/core/index.ts', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "add index"', { cwd: testRoot, stdio: 'pipe' });

    const result = await runHook(
      { tool_input: { command: 'git commit -m "add index"' } },
      testRoot,
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes('app-core'));
  });

  it('should include regeneration instructions per stale module', async () => {
    const twoHoursAgo = new Date(Date.now() - 7200_000).toISOString();
    createTraceFile(testRoot, 'app-core', twoHoursAgo);

    writeFileSync(join(testRoot, 'src', 'core', 'x.ts'), 'export const x = 1;');
    execSync('git add src/core/x.ts', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "add x"', { cwd: testRoot, stdio: 'pipe' });

    const result = await runHook(
      { tool_input: { command: 'git commit -m "add x"' } },
      testRoot,
    );
    assert.equal(result.exitCode, 2);
    assert.ok(
      result.stderr.includes('trace-generate.mjs app-core'),
      'Should suggest module-specific regeneration',
    );
  });
});

// ============================================================
// AC-8.4: Untraced files do not cause staleness errors
// ============================================================

describe('AC-8.4: Untraced files in commit', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `trace-commit-untraced-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestRepo(testRoot);
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should exit 0 when only untraced files are committed', async () => {
    // docs/ is not in any module's fileGlobs
    writeFileSync(join(testRoot, 'docs', 'README.md'), '# Docs');
    execSync('git add docs/README.md', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "add docs"', { cwd: testRoot, stdio: 'pipe' });

    const result = await runHook(
      { tool_input: { command: 'git commit -m "add docs"' } },
      testRoot,
    );
    assert.equal(result.exitCode, 0, 'Untraced-only commits should pass');
  });

  it('should only report stale traced modules, not untraced files', async () => {
    // Create stale trace for app-core
    const twoHoursAgo = new Date(Date.now() - 7200_000).toISOString();
    createTraceFile(testRoot, 'app-core', twoHoursAgo);

    // Commit both a traced file (stale) and an untraced file
    writeFileSync(join(testRoot, 'src', 'core', 'stale.ts'), 'export const stale = 1;');
    writeFileSync(join(testRoot, 'docs', 'notes.md'), '# Notes');

    execSync('git add src/core/stale.ts docs/notes.md', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "mixed commit"', { cwd: testRoot, stdio: 'pipe' });

    const result = await runHook(
      { tool_input: { command: 'git commit -m "mixed commit"' } },
      testRoot,
    );
    assert.equal(result.exitCode, 2, 'Should block because of stale traced module');
    assert.ok(result.stderr.includes('app-core'), 'Should mention stale module');
    assert.ok(!result.stderr.includes('docs'), 'Should not mention untraced files');
  });

  it('should exit 0 when untraced files committed alongside fresh traced modules', async () => {
    // Fresh trace for app-core
    const now = new Date().toISOString();
    createTraceFile(testRoot, 'app-core', now);

    // Create file with old mtime in traced module
    const coreFile = join(testRoot, 'src', 'core', 'fresh.ts');
    writeFileSync(coreFile, 'export const fresh = 1;');
    const threeHoursAgo = new Date(Date.now() - 10800_000);
    utimesSync(coreFile, threeHoursAgo, threeHoursAgo);

    // Also commit an untraced file
    writeFileSync(join(testRoot, 'docs', 'guide.md'), '# Guide');

    execSync('git add src/core/fresh.ts docs/guide.md', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "mixed fresh"', { cwd: testRoot, stdio: 'pipe' });

    const result = await runHook(
      { tool_input: { command: 'git commit -m "mixed fresh"' } },
      testRoot,
    );
    assert.equal(result.exitCode, 0, `Expected exit 0 but got ${result.exitCode}. stderr: ${result.stderr}`);
  });
});

// ============================================================
// Git commit command detection edge cases
// ============================================================

describe('Git commit command detection', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `trace-commit-detect-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestRepo(testRoot);
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should detect "git commit -m" as a commit command', async () => {
    // We just need it to NOT exit 0 for non-detection reasons
    // Create a stale module to verify it runs the check
    writeFileSync(join(testRoot, 'src', 'core', 'test.ts'), 'export const t = 1;');
    execSync('git add src/core/test.ts', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "detect test"', { cwd: testRoot, stdio: 'pipe' });

    const result = await runHook(
      { tool_input: { command: 'git commit -m "detect test"' } },
      testRoot,
    );
    // Should exit 2 because no trace file exists for app-core
    assert.equal(result.exitCode, 2, 'Should detect git commit -m');
  });

  it('should detect "git commit --amend" as a commit command', async () => {
    writeFileSync(join(testRoot, 'src', 'core', 'amend.ts'), 'export const a = 1;');
    execSync('git add src/core/amend.ts', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "to amend"', { cwd: testRoot, stdio: 'pipe' });

    const result = await runHook(
      { tool_input: { command: 'git commit --amend --no-edit' } },
      testRoot,
    );
    assert.equal(result.exitCode, 2, 'Should detect git commit --amend');
  });

  it('should detect chained command with git commit', async () => {
    writeFileSync(join(testRoot, 'src', 'core', 'chain.ts'), 'export const c = 1;');
    execSync('git add src/core/chain.ts', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "chain"', { cwd: testRoot, stdio: 'pipe' });

    const result = await runHook(
      { tool_input: { command: 'git add . && git commit -m "chain commit"' } },
      testRoot,
    );
    assert.equal(result.exitCode, 2, 'Should detect git commit in chained command');
  });

  it('should NOT detect "git committed" as a commit', async () => {
    const result = await runHook(
      { tool_input: { command: 'echo git committed something' } },
      testRoot,
    );
    assert.equal(result.exitCode, 0, 'Should not trigger on "git committed"');
  });
});

// ============================================================
// Mixed scenarios
// ============================================================

describe('Mixed scenarios', () => {
  let testRoot;

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `trace-commit-mixed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setupTestRepo(testRoot);
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should only report stale modules, not fresh ones', async () => {
    // app-core has fresh trace, app-ui has stale trace
    const now = new Date().toISOString();
    createTraceFile(testRoot, 'app-core', now);

    const twoHoursAgo = new Date(Date.now() - 7200_000).toISOString();
    createTraceFile(testRoot, 'app-ui', twoHoursAgo);

    // Create core file with old mtime (fresh relative to trace)
    const coreFile = join(testRoot, 'src', 'core', 'fresh.ts');
    writeFileSync(coreFile, 'export const f = 1;');
    const threeHoursAgo = new Date(Date.now() - 10800_000);
    utimesSync(coreFile, threeHoursAgo, threeHoursAgo);

    // Create UI file with current mtime (stale relative to trace)
    writeFileSync(join(testRoot, 'src', 'ui', 'stale.tsx'), 'export const S = () => {};');

    execSync('git add src/core/fresh.ts src/ui/stale.tsx', { cwd: testRoot, stdio: 'pipe' });
    execSync('git commit -m "mixed fresh and stale"', { cwd: testRoot, stdio: 'pipe' });

    const result = await runHook(
      { tool_input: { command: 'git commit -m "mixed"' } },
      testRoot,
    );
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes('app-ui'), 'Should list stale app-ui');
    assert.ok(!result.stderr.includes('app-core') || result.stderr.includes('App Core') === false,
      'Should not list fresh app-core as stale');
  });
});

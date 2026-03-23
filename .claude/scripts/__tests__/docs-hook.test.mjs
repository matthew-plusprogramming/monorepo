/**
 * Integration tests for PostToolUse hook behavior for structured docs
 *
 * Spec: sg-structured-docs
 * Covers: AC-9.1, AC-9.2, AC-9.3
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs docs-hook
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const SETTINGS_PATH = join(PROJECT_ROOT, '.claude', 'settings.json');

// ---------------------------------------------------------------------------
// AC-9.1: PostToolUse Hook Entry in settings.json
// ---------------------------------------------------------------------------

describe('PostToolUse Hook Configuration (AC-9.1)', () => {

  it('should have a PostToolUse hook entry in settings.json for .claude/docs/**/*.yaml (AC-9.1)', () => {
    // Arrange
    if (!existsSync(SETTINGS_PATH)) {
      expect.fail('settings.json does not exist at project root');
      return;
    }
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));

    // Act — find PostToolUse hooks
    const hooks = settings.hooks || {};
    const postToolUseHooks = hooks.PostToolUse || hooks.postToolUse || [];

    // If hooks are structured differently, check for the pattern
    let found = false;
    const allHooks = Array.isArray(postToolUseHooks)
      ? postToolUseHooks
      : Object.values(postToolUseHooks);

    for (const hook of allHooks) {
      const hookStr = typeof hook === 'string' ? hook : JSON.stringify(hook);
      if (hookStr.includes('.claude/docs') && hookStr.includes('yaml')) {
        found = true;
        break;
      }
    }

    // Also check if it's nested under a different structure
    if (!found && settings.hooks) {
      const hookJson = JSON.stringify(settings.hooks);
      if (hookJson.includes('docs-validate') && hookJson.includes('.yaml')) {
        found = true;
      }
    }

    // Assert
    expect(found).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-9.2 / AC-9.3: Hook Exit Codes
//
// We test the validator script directly with exit code assertions, since the
// hook entry delegates to docs-validate.mjs via hook-wrapper.
// ---------------------------------------------------------------------------

describe('Hook Exit Code Behavior', () => {
  const VALIDATE_SCRIPT = join(__dirname, '..', 'docs-validate.mjs');
  const validatorExists = existsSync(VALIDATE_SCRIPT);

  let tempDir;

  beforeEach(() => {
    tempDir = join(tmpdir(), `docs-hook-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function setupValidDocs(tempRoot) {
    const docsDir = join(tempRoot, '.claude', 'docs', 'structured');
    const flowsDir = join(docsDir, 'flows');
    mkdirSync(flowsDir, { recursive: true });
    mkdirSync(join(docsDir, 'generated'), { recursive: true });

    writeFileSync(join(docsDir, 'architecture.yaml'), `schema_version: 1
modules:
  - name: test-mod
    description: Test module
    path: src/**
    responsibilities:
      - Testing
    dependencies: []
`);
    writeFileSync(join(docsDir, 'glossary.yaml'), `schema_version: 1
terms: []
`);
    writeFileSync(join(flowsDir, 'index.yaml'), `schema_version: 1
flows: []
`);

    return docsDir;
  }

  function runValidatorAsHook(tempRoot) {
    return new Promise((resolve) => {
      const child = spawn('node', [VALIDATE_SCRIPT, '--root', tempRoot], {
        cwd: PROJECT_ROOT,
        env: { ...process.env, DOCS_ROOT: join(tempRoot, '.claude', 'docs', 'structured') },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => { resolve({ exitCode: code, stdout, stderr }); });
      child.stdin.end();
    });
  }

  // AC-9.3 (pass case): Clean validation → exit 0, no stderr
  it('should exit 0 with no blocking stderr on clean validation (AC-9.3)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    setupValidDocs(tempDir);

    // Act
    const { exitCode, stderr } = await runValidatorAsHook(tempDir);

    // Assert — exit 0, no error-level messages
    expect(exitCode).toBe(0);
    // Stderr may contain informational messages but not blocking errors
    expect(stderr).not.toMatch(/block|error.*schema.*violation/i);
  });

  // AC-9.2: Validation warning → exit 0 with structured stderr message
  it('should exit 0 with structured stderr message on validation warning (AC-9.2)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange — create docs with a stale .mmd (triggers warning, not error)
    const docsDir = setupValidDocs(tempDir);
    writeFileSync(
      join(docsDir, 'generated', 'architecture.mmd'),
      '%% source-hash: deadbeef\nflowchart TD\n  A --> B\n'
    );

    // Act
    const { exitCode, stdout, stderr } = await runValidatorAsHook(tempDir);

    // Assert — exit 0 (warnings do not block), output contains warning
    // In CLI mode (no --hook), warnings go to stdout; stderr may contain
    // git messages from glob checking in temp dirs without a git repo.
    expect(exitCode).toBe(0);
    const output = stdout + stderr;
    expect(output).toMatch(/warn|stale|mismatch/i);
  });

  // AC-9.3 (block case): Blocking validation error → exit 2
  it('should exit with non-zero code on blocking validation error (AC-9.3)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange — create invalid docs (missing required fields)
    const docsDir = join(tempDir, '.claude', 'docs', 'structured');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'architecture.yaml'), `schema_version: 1
modules:
  - description: Missing name field
    path: src/**
`);

    // Act
    const { exitCode } = await runValidatorAsHook(tempDir);

    // Assert — non-zero exit (the hook wrapper converts to exit 2)
    expect(exitCode).not.toBe(0);
  });
});

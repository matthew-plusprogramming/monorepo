/**
 * Unit tests for docs-scaffold.mjs — Directory scanning, module proposal, overwrite guard
 *
 * Spec: sg-structured-docs
 * Covers: AC-7.1, AC-7.2
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs docs-scaffold
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

const FIXTURES_DIR = join(__dirname, '..', '__fixtures__', 'structured-docs');
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const SCAFFOLD_SCRIPT = join(__dirname, '..', 'docs-scaffold.mjs');

// ---------------------------------------------------------------------------
// Helper: Run docs-scaffold.mjs against a temp project directory
// ---------------------------------------------------------------------------

function runScaffolder(tempRoot) {
  return new Promise((resolve) => {
    const child = spawn('node', [SCAFFOLD_SCRIPT, '--root', tempRoot], {
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

let tempDir;

beforeEach(() => {
  tempDir = join(tmpdir(), `docs-scaffold-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const scaffolderExists = existsSync(SCAFFOLD_SCRIPT);

// ============================================================================
// AC-7.1: Scaffolder Produces Draft from Directory Structure
// ============================================================================

describe('Scaffolder Draft Generation', () => {

  // AC-7.1: Produces draft architecture.yaml with TODO placeholders
  it('should produce draft architecture.yaml with TODO placeholders when no architecture exists (AC-7.1)', async () => {
    if (!scaffolderExists) { expect.fail('docs-scaffold.mjs not yet implemented'); return; }

    // Arrange — create a realistic project directory structure
    mkdirSync(join(tempDir, 'src', 'auth'), { recursive: true });
    mkdirSync(join(tempDir, 'src', 'api'), { recursive: true });
    mkdirSync(join(tempDir, 'src', 'utils'), { recursive: true });
    mkdirSync(join(tempDir, 'tests'), { recursive: true });
    mkdirSync(join(tempDir, '.claude', 'docs', 'structured'), { recursive: true });

    // Create some dummy files to make directories discoverable
    writeFileSync(join(tempDir, 'src', 'auth', 'index.ts'), '');
    writeFileSync(join(tempDir, 'src', 'api', 'router.ts'), '');
    writeFileSync(join(tempDir, 'src', 'utils', 'helpers.ts'), '');

    // Act
    const { exitCode, stdout, stderr } = await runScaffolder(tempDir);

    // Assert
    expect(exitCode).toBe(0);

    // Check that architecture.yaml was created
    const archPath = join(tempDir, '.claude', 'docs', 'structured', 'architecture.yaml');
    expect(existsSync(archPath)).toBe(true);

    const archContent = readFileSync(archPath, 'utf8');
    // Should contain schema_version
    expect(archContent).toMatch(/schema_version/);
    // Should contain modules
    expect(archContent).toMatch(/modules/);
    // Should contain TODO placeholders
    expect(archContent).toMatch(/TODO/);
  });

  it('should analyze project directory structure to infer candidate modules (AC-7.1)', async () => {
    if (!scaffolderExists) { expect.fail('docs-scaffold.mjs not yet implemented'); return; }

    // Arrange — create directory structure with meaningful names
    mkdirSync(join(tempDir, 'src', 'authentication'), { recursive: true });
    mkdirSync(join(tempDir, 'src', 'database'), { recursive: true });
    mkdirSync(join(tempDir, 'lib'), { recursive: true });
    mkdirSync(join(tempDir, '.claude', 'docs', 'structured'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'authentication', 'login.js'), '');
    writeFileSync(join(tempDir, 'src', 'database', 'models.js'), '');
    writeFileSync(join(tempDir, 'lib', 'utils.js'), '');

    // Act
    const { exitCode } = await runScaffolder(tempDir);

    // Assert
    expect(exitCode).toBe(0);
    const archPath = join(tempDir, '.claude', 'docs', 'structured', 'architecture.yaml');
    const content = readFileSync(archPath, 'utf8');

    // Should have proposed some modules from the directory structure
    expect(content).toMatch(/modules:/);
    expect(content).toMatch(/name:/);
  });

  it('should produce draft with schema_version 1 (AC-7.1)', async () => {
    if (!scaffolderExists) { expect.fail('docs-scaffold.mjs not yet implemented'); return; }

    // Arrange
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    mkdirSync(join(tempDir, '.claude', 'docs', 'structured'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'index.js'), '');

    // Act
    const { exitCode } = await runScaffolder(tempDir);

    // Assert
    expect(exitCode).toBe(0);
    const archPath = join(tempDir, '.claude', 'docs', 'structured', 'architecture.yaml');
    const content = readFileSync(archPath, 'utf8');
    expect(content).toMatch(/schema_version:\s*1/);
  });
});

// ============================================================================
// AC-7.2: Scaffolder Refuses to Overwrite Existing Content
// ============================================================================

describe('Scaffolder Overwrite Guard', () => {

  // AC-7.2: Refuses to overwrite existing content
  it('should refuse to overwrite when architecture.yaml has content (AC-7.2)', async () => {
    if (!scaffolderExists) { expect.fail('docs-scaffold.mjs not yet implemented'); return; }

    // Arrange — create architecture.yaml with existing modules
    const docsDir = join(tempDir, '.claude', 'docs', 'structured');
    mkdirSync(docsDir, { recursive: true });
    const existingContent = readFileSync(join(FIXTURES_DIR, 'valid-architecture.yaml'), 'utf8');
    writeFileSync(join(docsDir, 'architecture.yaml'), existingContent);

    // Act
    const { exitCode, stdout, stderr } = await runScaffolder(tempDir);

    // Assert — should refuse and not overwrite
    const output = stdout + stderr;
    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/already.*exist|already.*has|refuse|overwrite|content/i);

    // Verify original content is preserved
    const afterContent = readFileSync(join(docsDir, 'architecture.yaml'), 'utf8');
    expect(afterContent).toBe(existingContent);
  });

  it('should allow scaffolding when architecture.yaml exists but has zero modules (AC-7.1)', async () => {
    if (!scaffolderExists) { expect.fail('docs-scaffold.mjs not yet implemented'); return; }

    // Arrange — architecture.yaml with zero modules
    const docsDir = join(tempDir, '.claude', 'docs', 'structured');
    mkdirSync(docsDir, { recursive: true });
    const emptyArch = readFileSync(join(FIXTURES_DIR, 'architecture-zero-modules.yaml'), 'utf8');
    writeFileSync(join(docsDir, 'architecture.yaml'), emptyArch);

    // Create some project structure
    mkdirSync(join(tempDir, 'src', 'core'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'core', 'main.js'), '');

    // Act
    const { exitCode } = await runScaffolder(tempDir);

    // Assert — should run since zero modules means no real content
    expect(exitCode).toBe(0);
  });
});

// ============================================================================
// Scaffolder Ignore Patterns
// ============================================================================

describe('Scaffolder Ignore Patterns', () => {

  it('should ignore common non-source directories (node_modules, .git, etc.)', async () => {
    if (!scaffolderExists) { expect.fail('docs-scaffold.mjs not yet implemented'); return; }

    // Arrange
    mkdirSync(join(tempDir, 'src', 'main'), { recursive: true });
    mkdirSync(join(tempDir, 'node_modules', 'some-pkg'), { recursive: true });
    mkdirSync(join(tempDir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(tempDir, 'dist'), { recursive: true });
    mkdirSync(join(tempDir, '.claude', 'docs', 'structured'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'main', 'app.js'), '');
    writeFileSync(join(tempDir, 'node_modules', 'some-pkg', 'index.js'), '');

    // Act
    const { exitCode } = await runScaffolder(tempDir);

    // Assert
    expect(exitCode).toBe(0);
    const archPath = join(tempDir, '.claude', 'docs', 'structured', 'architecture.yaml');
    const content = readFileSync(archPath, 'utf8');

    // Should NOT include node_modules or .git as proposed modules
    expect(content).not.toMatch(/node_modules/);
    expect(content).not.toMatch(/\.git/);
  });
});

// ============================================================================
// Scaffolder Output Structure
// ============================================================================

describe('Scaffolder Output Structure', () => {

  it('should produce valid YAML that can be parsed', async () => {
    if (!scaffolderExists) { expect.fail('docs-scaffold.mjs not yet implemented'); return; }

    // Arrange
    mkdirSync(join(tempDir, 'src', 'services'), { recursive: true });
    mkdirSync(join(tempDir, '.claude', 'docs', 'structured'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'services', 'auth.js'), '');

    // Act
    const { exitCode } = await runScaffolder(tempDir);

    // Assert
    expect(exitCode).toBe(0);
    const archPath = join(tempDir, '.claude', 'docs', 'structured', 'architecture.yaml');
    const content = readFileSync(archPath, 'utf8');

    // Dynamically import yaml to verify valid YAML
    const { parse } = await import('yaml');
    const parsed = parse(content);
    expect(parsed).toBeDefined();
    expect(parsed.schema_version).toBe(1);
    expect(Array.isArray(parsed.modules)).toBe(true);
  });
});

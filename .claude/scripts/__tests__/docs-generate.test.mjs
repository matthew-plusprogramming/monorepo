/**
 * Unit tests for docs-generate.mjs — Mermaid generation, freshness hash, diagrams
 *
 * Spec: sg-structured-docs
 * Covers: AC-6.1, AC-6.2, AC-6.3, AC-6.4
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs docs-generate
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_DIR = join(__dirname, '..', '__fixtures__', 'structured-docs');
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const GENERATE_SCRIPT = join(__dirname, '..', 'docs-generate.mjs');

// ---------------------------------------------------------------------------
// Helper: Run docs-generate.mjs against a temp structured-docs directory
// ---------------------------------------------------------------------------

function runGenerator(tempRoot) {
  return new Promise((resolve) => {
    const child = spawn('node', [GENERATE_SCRIPT, '--root', tempRoot], {
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

/**
 * Creates a minimal valid structured docs directory tree for generation.
 */
function setupDocsForGeneration(tempDir, overrides = {}) {
  const docsDir = join(tempDir, '.claude', 'docs', 'structured');
  const flowsDir = join(docsDir, 'flows');
  const generatedDir = join(docsDir, 'generated');

  mkdirSync(flowsDir, { recursive: true });
  mkdirSync(generatedDir, { recursive: true });

  // Architecture
  const archContent = overrides.architecture ||
    readFileSync(join(FIXTURES_DIR, 'valid-architecture.yaml'), 'utf8');
  writeFileSync(join(docsDir, 'architecture.yaml'), archContent);

  // Flow index
  if (overrides.flowIndex !== false) {
    const indexContent = overrides.flowIndex ||
      readFileSync(join(FIXTURES_DIR, 'flows', 'valid-index.yaml'), 'utf8');
    writeFileSync(join(flowsDir, 'index.yaml'), indexContent);
  }

  // Flow files
  if (overrides.flowFiles !== false) {
    const flowContent = overrides.flowFile ||
      readFileSync(join(FIXTURES_DIR, 'flows', 'valid-flow.yaml'), 'utf8');
    writeFileSync(join(flowsDir, 'user-login.yaml'), flowContent);

    const regFlow = `schema_version: 1
name: user-registration
description: New user signup
steps:
  - order: 1
    module: api-router
    action: Receives POST /register
  - order: 2
    module: user-service
    action: Creates user record
`;
    writeFileSync(join(flowsDir, 'user-registration.yaml'), regFlow);
  }

  return { docsDir, flowsDir, generatedDir };
}

/**
 * Computes expected source hash (SHA-256 first 8 chars, LF-normalized).
 */
function expectedHash(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 8);
}

let tempDir;

beforeEach(() => {
  tempDir = join(tmpdir(), `docs-generate-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const generatorExists = existsSync(GENERATE_SCRIPT);

// ============================================================================
// AC-6.1: Architecture Diagram Generation
// ============================================================================

describe('Architecture Diagram Generation', () => {

  // AC-6.1: Generates architecture.mmd from architecture.yaml
  it('should produce generated/architecture.mmd with module dependency diagram (AC-6.1)', async () => {
    if (!generatorExists) { expect.fail('docs-generate.mjs not yet implemented'); return; }

    // Arrange
    const { generatedDir } = setupDocsForGeneration(tempDir);

    // Act
    const { exitCode } = await runGenerator(tempDir);

    // Assert
    expect(exitCode).toBe(0);
    const mmdPath = join(generatedDir, 'architecture.mmd');
    expect(existsSync(mmdPath)).toBe(true);

    const mmdContent = readFileSync(mmdPath, 'utf8');
    // Should be a flowchart with modules as nodes
    expect(mmdContent).toMatch(/flowchart/i);
    expect(mmdContent).toMatch(/auth-gateway/);
    expect(mmdContent).toMatch(/user-service/);
    expect(mmdContent).toMatch(/api-router/);
    // Should have dependency edges
    expect(mmdContent).toMatch(/-->/);
  });

  // AC-6.4: No-dependency modules produce valid mermaid with unconnected nodes
  it('should produce valid .mmd with unconnected nodes for modules without dependencies (AC-6.4)', async () => {
    if (!generatorExists) { expect.fail('docs-generate.mjs not yet implemented'); return; }

    // Arrange
    const noDepsArch = readFileSync(join(FIXTURES_DIR, 'architecture-no-deps.yaml'), 'utf8');
    const { generatedDir } = setupDocsForGeneration(tempDir, {
      architecture: noDepsArch,
      flowIndex: 'schema_version: 1\nflows: []\n',
      flowFiles: false,
    });

    // Act
    const { exitCode } = await runGenerator(tempDir);

    // Assert
    expect(exitCode).toBe(0);
    const mmdPath = join(generatedDir, 'architecture.mmd');
    expect(existsSync(mmdPath)).toBe(true);

    const mmdContent = readFileSync(mmdPath, 'utf8');
    // Should still be valid mermaid
    expect(mmdContent).toMatch(/flowchart/i);
    // Nodes present but no edges (no --> arrows between modules)
    expect(mmdContent).toMatch(/standalone-a/);
    expect(mmdContent).toMatch(/standalone-b/);
  });
});

// ============================================================================
// AC-6.2: Flow Diagram Generation
// ============================================================================

describe('Flow Diagram Generation', () => {

  // AC-6.2: Generates flow-<name>.mmd for each flow
  it('should produce flow-<name>.mmd for each flow YAML (AC-6.2)', async () => {
    if (!generatorExists) { expect.fail('docs-generate.mjs not yet implemented'); return; }

    // Arrange
    const { generatedDir } = setupDocsForGeneration(tempDir);

    // Act
    const { exitCode } = await runGenerator(tempDir);

    // Assert
    expect(exitCode).toBe(0);

    // Check flow diagrams exist for both flows in the index
    const loginMmd = join(generatedDir, 'flow-user-login.mmd');
    const regMmd = join(generatedDir, 'flow-user-registration.mmd');

    expect(existsSync(loginMmd)).toBe(true);
    expect(existsSync(regMmd)).toBe(true);

    // Verify content is sequence diagram format
    const loginContent = readFileSync(loginMmd, 'utf8');
    expect(loginContent).toMatch(/sequenceDiagram/i);
    // Should contain participants (modules)
    expect(loginContent).toMatch(/api-router|auth-gateway|user-service/);
  });

  it('should handle empty flow index gracefully (AC-6.2 edge)', async () => {
    if (!generatorExists) { expect.fail('docs-generate.mjs not yet implemented'); return; }

    // Arrange
    const { generatedDir } = setupDocsForGeneration(tempDir, {
      flowIndex: 'schema_version: 1\nflows: []\n',
      flowFiles: false,
    });

    // Act
    const { exitCode } = await runGenerator(tempDir);

    // Assert — should succeed, just no flow diagrams generated
    expect(exitCode).toBe(0);
    const files = readdirSync(generatedDir);
    const flowFiles = files.filter(f => f.startsWith('flow-'));
    expect(flowFiles).toHaveLength(0);
  });
});

// ============================================================================
// AC-6.3: Source Hash in Generated .mmd Files
// ============================================================================

describe('Source Hash Embedding', () => {

  // AC-6.3: Generated .mmd has source-hash first line
  it('should embed source-hash as first line of architecture.mmd (AC-6.3)', async () => {
    if (!generatorExists) { expect.fail('docs-generate.mjs not yet implemented'); return; }

    // Arrange
    const archContent = readFileSync(join(FIXTURES_DIR, 'valid-architecture.yaml'), 'utf8');
    const { docsDir, generatedDir } = setupDocsForGeneration(tempDir);

    // Act
    const { exitCode } = await runGenerator(tempDir);

    // Assert
    expect(exitCode).toBe(0);
    const mmdContent = readFileSync(join(generatedDir, 'architecture.mmd'), 'utf8');
    const firstLine = mmdContent.split('\n')[0];

    // First line must be %% source-hash: <8-char-hex>
    expect(firstLine).toMatch(/^%% source-hash: [0-9a-f]{8}$/);
  });

  it('should compute source-hash as SHA-256 first 8 chars of LF-normalized YAML (AC-6.3)', async () => {
    if (!generatorExists) { expect.fail('docs-generate.mjs not yet implemented'); return; }

    // Arrange
    const archContent = readFileSync(join(FIXTURES_DIR, 'valid-architecture.yaml'), 'utf8');
    const expected = expectedHash(archContent);
    const { generatedDir } = setupDocsForGeneration(tempDir);

    // Act
    const { exitCode } = await runGenerator(tempDir);

    // Assert
    expect(exitCode).toBe(0);
    const mmdContent = readFileSync(join(generatedDir, 'architecture.mmd'), 'utf8');
    const firstLine = mmdContent.split('\n')[0];
    const hashMatch = firstLine.match(/^%% source-hash: ([0-9a-f]{8})$/);
    expect(hashMatch).not.toBeNull();
    expect(hashMatch[1]).toBe(expected);
  });

  it('should embed per-flow source-hash in each flow .mmd (AC-6.3)', async () => {
    if (!generatorExists) { expect.fail('docs-generate.mjs not yet implemented'); return; }

    // Arrange
    const { flowsDir, generatedDir } = setupDocsForGeneration(tempDir);
    const flowContent = readFileSync(join(flowsDir, 'user-login.yaml'), 'utf8');
    const expectedFlowHash = expectedHash(flowContent);

    // Act
    const { exitCode } = await runGenerator(tempDir);

    // Assert
    expect(exitCode).toBe(0);
    const loginMmd = readFileSync(join(generatedDir, 'flow-user-login.mmd'), 'utf8');
    const firstLine = loginMmd.split('\n')[0];
    const hashMatch = firstLine.match(/^%% source-hash: ([0-9a-f]{8})$/);
    expect(hashMatch).not.toBeNull();
    expect(hashMatch[1]).toBe(expectedFlowHash);
  });
});

// ============================================================================
// Idempotency: Same input produces same output
// ============================================================================

describe('Idempotency', () => {

  it('should produce identical output on repeated runs', async () => {
    if (!generatorExists) { expect.fail('docs-generate.mjs not yet implemented'); return; }

    // Arrange
    const { generatedDir } = setupDocsForGeneration(tempDir);

    // Act — run twice
    await runGenerator(tempDir);
    const firstRun = readFileSync(join(generatedDir, 'architecture.mmd'), 'utf8');

    await runGenerator(tempDir);
    const secondRun = readFileSync(join(generatedDir, 'architecture.mmd'), 'utf8');

    // Assert — identical
    expect(firstRun).toBe(secondRun);
  });
});

// ============================================================================
// Circular Dependencies in Mermaid Output
// ============================================================================

describe('Circular Dependencies in Mermaid', () => {

  it('should render circular dependencies without errors (AC-4.4 / AC-6.1)', async () => {
    if (!generatorExists) { expect.fail('docs-generate.mjs not yet implemented'); return; }

    // Arrange
    const circularArch = readFileSync(
      join(FIXTURES_DIR, 'architecture-circular-deps.yaml'), 'utf8'
    );
    const { generatedDir } = setupDocsForGeneration(tempDir, {
      architecture: circularArch,
      flowIndex: 'schema_version: 1\nflows: []\n',
      flowFiles: false,
    });

    // Act
    const { exitCode } = await runGenerator(tempDir);

    // Assert — should succeed
    expect(exitCode).toBe(0);
    const mmdContent = readFileSync(join(generatedDir, 'architecture.mmd'), 'utf8');
    expect(mmdContent).toMatch(/flowchart/i);
    expect(mmdContent).toMatch(/module-a/);
    expect(mmdContent).toMatch(/module-b/);
    expect(mmdContent).toMatch(/module-c/);
  });
});

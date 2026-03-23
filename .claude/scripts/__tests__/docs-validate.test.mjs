/**
 * Unit tests for docs-validate.mjs — Schema validation, cross-references,
 * staleness detection, size limits, schema versioning
 *
 * Spec: sg-structured-docs
 * Covers: AC-1.1 through AC-1.7, AC-2.1 through AC-2.3, AC-3.1, AC-3.2,
 *         AC-4.1 through AC-4.5, AC-5.1 through AC-5.3, AC-6.5, AC-7.3,
 *         AC-11.6, AC-11.7
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs docs-validate
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_DIR = join(__dirname, '..', '__fixtures__', 'structured-docs');
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const VALIDATE_SCRIPT = join(__dirname, '..', 'docs-validate.mjs');

// ---------------------------------------------------------------------------
// Helper: Run docs-validate.mjs against a temp structured-docs directory
// ---------------------------------------------------------------------------

/**
 * Sets up a temporary .claude/docs/structured/ directory tree with given files,
 * then runs docs-validate.mjs pointed at it. Returns { exitCode, stdout, stderr }.
 */
function runValidator(tempRoot, stdinOverride) {
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
    if (stdinOverride) {
      child.stdin.write(typeof stdinOverride === 'string' ? stdinOverride : JSON.stringify(stdinOverride));
    }
    child.stdin.end();
  });
}

/**
 * Creates a minimal valid structured docs directory tree in tempDir.
 */
function setupValidStructuredDocs(tempDir, overrides = {}) {
  const docsDir = join(tempDir, '.claude', 'docs', 'structured');
  const flowsDir = join(docsDir, 'flows');
  const generatedDir = join(docsDir, 'generated');

  mkdirSync(flowsDir, { recursive: true });
  mkdirSync(generatedDir, { recursive: true });

  // Default valid architecture
  const archContent = overrides.architecture ||
    readFileSync(join(FIXTURES_DIR, 'valid-architecture.yaml'), 'utf8');
  writeFileSync(join(docsDir, 'architecture.yaml'), archContent);

  // Default valid glossary
  if (overrides.glossary !== false) {
    const glossaryContent = overrides.glossary ||
      readFileSync(join(FIXTURES_DIR, 'valid-glossary.yaml'), 'utf8');
    writeFileSync(join(docsDir, 'glossary.yaml'), glossaryContent);
  }

  // Default valid flows
  if (overrides.flowIndex !== false) {
    const indexContent = overrides.flowIndex ||
      readFileSync(join(FIXTURES_DIR, 'flows', 'valid-index.yaml'), 'utf8');
    writeFileSync(join(flowsDir, 'index.yaml'), indexContent);
  }

  if (overrides.flowFiles !== false) {
    const flowContent = overrides.flowFiles ||
      readFileSync(join(FIXTURES_DIR, 'flows', 'valid-flow.yaml'), 'utf8');
    // The valid-index references user-login.yaml and user-registration.yaml
    writeFileSync(join(flowsDir, 'user-login.yaml'), flowContent);
    // Create a minimal second flow for user-registration
    const regFlow = overrides.flowRegistration || `schema_version: 1
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

  // Optional: decisions
  if (overrides.decisions) {
    writeFileSync(join(docsDir, 'decisions.yaml'), overrides.decisions);
  }

  // Optional: runbooks
  if (overrides.runbooks) {
    writeFileSync(join(docsDir, 'runbooks.yaml'), overrides.runbooks);
  }

  return { docsDir, flowsDir, generatedDir };
}

let tempDir;

beforeEach(() => {
  tempDir = join(tmpdir(), `docs-validate-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Skip guard: if docs-validate.mjs doesn't exist yet, all tests fail explicitly
// ---------------------------------------------------------------------------

const validatorExists = existsSync(VALIDATE_SCRIPT);

// ============================================================================
// AC-1.x: Schema Validation for All 5 Document Types
// ============================================================================

describe('Schema Validation', () => {

  // AC-1.1: schema.yaml defines validation rules for all 5 doc types
  it('should validate all 5 document types without errors when valid (AC-1.1)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange — set up all 5 doc types
    const decisions = readFileSync(join(FIXTURES_DIR, 'valid-decisions.yaml'), 'utf8');
    const runbooks = readFileSync(join(FIXTURES_DIR, 'valid-runbooks.yaml'), 'utf8');
    setupValidStructuredDocs(tempDir, { decisions, runbooks });

    // Act
    const { exitCode, stderr } = await runValidator(tempDir);

    // Assert — no errors
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/error/i);
  });

  // AC-1.2: Valid architecture.yaml passes schema validation
  it('should accept valid architecture.yaml with schema_version, modules, name, description, path, responsibilities (AC-1.2)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    setupValidStructuredDocs(tempDir);

    // Act
    const { exitCode, stderr } = await runValidator(tempDir);

    // Assert
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/schema.*violation/i);
  });

  // AC-1.3: Valid glossary.yaml passes schema validation
  it('should accept valid glossary.yaml with term and definition fields (AC-1.3)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    setupValidStructuredDocs(tempDir);

    // Act
    const { exitCode, stderr } = await runValidator(tempDir);

    // Assert
    expect(exitCode).toBe(0);
  });

  // AC-1.4: Valid flows/index.yaml passes schema validation
  it('should accept valid flows/index.yaml with name, file, description (AC-1.4)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    setupValidStructuredDocs(tempDir);

    // Act
    const { exitCode, stderr } = await runValidator(tempDir);

    // Assert
    expect(exitCode).toBe(0);
  });

  // AC-1.5: Valid flow YAML passes schema validation
  it('should accept valid flow YAML with schema_version, name, description, steps (AC-1.5)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    setupValidStructuredDocs(tempDir);

    // Act
    const { exitCode, stderr } = await runValidator(tempDir);

    // Assert
    expect(exitCode).toBe(0);
  });

  // AC-1.6: Valid decisions.yaml passes schema validation
  it('should accept valid decisions.yaml with id, title, status, date, context, options, chosen, consequences (AC-1.6)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    const decisions = readFileSync(join(FIXTURES_DIR, 'valid-decisions.yaml'), 'utf8');
    setupValidStructuredDocs(tempDir, { decisions });

    // Act
    const { exitCode, stderr } = await runValidator(tempDir);

    // Assert
    expect(exitCode).toBe(0);
  });

  // AC-1.7: Valid runbooks.yaml passes schema validation
  it('should accept valid runbooks.yaml with name, description, steps with order and action (AC-1.7)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    const runbooks = readFileSync(join(FIXTURES_DIR, 'valid-runbooks.yaml'), 'utf8');
    setupValidStructuredDocs(tempDir, { runbooks });

    // Act
    const { exitCode, stderr } = await runValidator(tempDir);

    // Assert
    expect(exitCode).toBe(0);
  });
});

// ============================================================================
// AC-2.x: Schema Version Validation
// ============================================================================

describe('Schema Version Validation', () => {

  // AC-2.1: Current schema_version emits no warnings
  it('should emit no version warnings for schema_version 1 (AC-2.1)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    setupValidStructuredDocs(tempDir);

    // Act
    const { exitCode, stdout, stderr } = await runValidator(tempDir);

    // Assert
    const output = stdout + stderr;
    expect(output).not.toMatch(/schema.version.*warn/i);
    expect(output).not.toMatch(/deprecated.*schema/i);
    expect(exitCode).toBe(0);
  });

  // AC-2.2: Older schema_version emits warning (not error)
  it('should emit warning for older schema_version (AC-2.2)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange — use empty flows/glossary to avoid cross-reference errors
    // from architecture modules not matching flow step references
    const oldSchemaArch = readFileSync(join(FIXTURES_DIR, 'old-schema-version.yaml'), 'utf8');
    setupValidStructuredDocs(tempDir, {
      architecture: oldSchemaArch,
      flowIndex: 'schema_version: 1\nflows: []\n',
      flowFiles: false,
      glossary: 'schema_version: 1\nterms: []\n',
    });

    // Act
    const { exitCode, stdout, stderr } = await runValidator(tempDir);

    // Assert — should warn but not error (exit 0)
    const output = stdout + stderr;
    expect(output).toMatch(/warn/i);
    expect(exitCode).toBe(0);
  });

  // AC-2.3: Unknown schema_version emits error
  it('should emit error for unknown schema_version (AC-2.3)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    const unknownSchemaArch = readFileSync(join(FIXTURES_DIR, 'unknown-schema-version.yaml'), 'utf8');
    setupValidStructuredDocs(tempDir, { architecture: unknownSchemaArch });

    // Act
    const { exitCode, stdout, stderr } = await runValidator(tempDir);

    // Assert — should error (non-zero exit)
    const output = stdout + stderr;
    expect(output).toMatch(/error/i);
    expect(exitCode).not.toBe(0);
  });
});

// ============================================================================
// AC-3.x: Extensibility and Required Fields
// ============================================================================

describe('Extensibility and Required Fields', () => {

  // AC-3.1: Additional properties do not cause errors
  it('should allow additional properties beyond the schema (AC-3.1)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange — use empty flows/glossary to avoid cross-reference errors
    // from architecture modules not matching flow step references
    const extraPropsArch = readFileSync(join(FIXTURES_DIR, 'architecture-extra-props.yaml'), 'utf8');
    setupValidStructuredDocs(tempDir, {
      architecture: extraPropsArch,
      flowIndex: 'schema_version: 1\nflows: []\n',
      flowFiles: false,
      glossary: 'schema_version: 1\nterms: []\n',
    });

    // Act
    const { exitCode, stdout, stderr } = await runValidator(tempDir);

    // Assert — no errors for extra properties
    expect(exitCode).toBe(0);
    const output = stdout + stderr;
    expect(output).not.toMatch(/additional.*propert/i);
    expect(output).not.toMatch(/unknown.*field/i);
  });

  // AC-3.2: Missing required field reports schema violation
  it('should report schema violation when required field is missing (AC-3.2)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    const missingNameArch = readFileSync(
      join(FIXTURES_DIR, 'invalid-architecture-missing-name.yaml'), 'utf8'
    );
    setupValidStructuredDocs(tempDir, { architecture: missingNameArch });

    // Act
    const { exitCode, stdout, stderr } = await runValidator(tempDir);

    // Assert
    const output = stdout + stderr;
    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/name/i); // references the missing field
    expect(output).toMatch(/schema.*violation|required|missing/i);
  });
});

// ============================================================================
// AC-4.x: Cross-Reference Validation
// ============================================================================

describe('Cross-Reference Validation', () => {

  // AC-4.1: Flow referencing nonexistent module reports error
  it('should report error when flow step references nonexistent module (AC-4.1)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    const danglingFlow = readFileSync(join(FIXTURES_DIR, 'dangling-flow.yaml'), 'utf8');
    const flowIndex = `schema_version: 1
flows:
  - name: broken-flow
    file: broken-flow.yaml
    description: Broken flow
`;
    const { flowsDir } = setupValidStructuredDocs(tempDir, {
      flowIndex,
      flowFiles: false,
    });
    writeFileSync(join(flowsDir, 'broken-flow.yaml'), danglingFlow);

    // Act
    const { exitCode, stdout, stderr } = await runValidator(tempDir);

    // Assert
    const output = stdout + stderr;
    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/nonexistent-service|also-missing/);
    expect(output).toMatch(/cross.reference|module.*not.*found|does not exist/i);
  });

  // AC-4.2: Glossary see_also with missing term reports warning
  it('should report warning when glossary see_also references nonexistent term (AC-4.2)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    const danglingGlossary = readFileSync(
      join(FIXTURES_DIR, 'glossary-dangling-see-also.yaml'), 'utf8'
    );
    setupValidStructuredDocs(tempDir, { glossary: danglingGlossary });

    // Act
    const { exitCode, stdout, stderr } = await runValidator(tempDir);

    // Assert — warning, not error (exit 0)
    const output = stdout + stderr;
    expect(output).toMatch(/nonexistent-term/);
    expect(output).toMatch(/warn/i);
  });

  // AC-4.3: Flow index referencing missing file reports error
  it('should report error when flow index references nonexistent file (AC-4.3)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    const danglingIndex = readFileSync(
      join(FIXTURES_DIR, 'flows', 'dangling-index.yaml'), 'utf8'
    );
    const { flowsDir } = setupValidStructuredDocs(tempDir, {
      flowIndex: danglingIndex,
      flowFiles: false,
    });
    // Create only the existing flow file, not the missing one
    const validFlow = readFileSync(join(FIXTURES_DIR, 'flows', 'valid-flow.yaml'), 'utf8');
    writeFileSync(join(flowsDir, 'valid-flow.yaml'), validFlow);

    // Act
    const { exitCode, stdout, stderr } = await runValidator(tempDir);

    // Assert
    const output = stdout + stderr;
    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/missing\.yaml/);
  });

  // AC-4.4: Circular deps accepted with informational note
  it('should accept circular dependencies and emit informational note (AC-4.4)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    const circularArch = readFileSync(
      join(FIXTURES_DIR, 'architecture-circular-deps.yaml'), 'utf8'
    );
    setupValidStructuredDocs(tempDir, {
      architecture: circularArch,
      flowIndex: 'schema_version: 1\nflows: []\n',
      flowFiles: false,
      glossary: 'schema_version: 1\nterms: []\n',
    });

    // Act
    const { exitCode, stdout, stderr } = await runValidator(tempDir);

    // Assert — accepted (exit 0) with informational note about cycles
    const output = stdout + stderr;
    expect(exitCode).toBe(0);
    expect(output).toMatch(/circular|cycle/i);
    expect(output).toMatch(/module-a|module-b|module-c/);
  });

  // AC-4.5: Zero-match module glob emits warning
  it('should emit warning when module path glob matches zero files (AC-4.5)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange — architecture with glob pointing to nonexistent path.
    // Must initialize a git repo in the temp dir because the glob checker
    // uses `git ls-files` and silently skips when not in a git repo.
    const archWithBadGlob = `schema_version: 1
modules:
  - name: ghost-module
    description: Module with path that matches nothing
    path: src/nonexistent-directory-that-does-not-exist/**
    responsibilities:
      - Nothing
    dependencies: []
`;
    setupValidStructuredDocs(tempDir, {
      architecture: archWithBadGlob,
      flowIndex: 'schema_version: 1\nflows: []\n',
      flowFiles: false,
      glossary: 'schema_version: 1\nterms: []\n',
    });

    // Initialize a git repo so git ls-files works
    execSync('git init && git add -A && git commit --allow-empty -m "init"', {
      cwd: tempDir,
      stdio: 'pipe',
    });

    // Act
    const { exitCode, stdout, stderr } = await runValidator(tempDir);

    // Assert — warning, not error
    const output = stdout + stderr;
    expect(output).toMatch(/ghost-module/);
    expect(output).toMatch(/warn|zero.*match|no.*files/i);
  });
});

// ============================================================================
// AC-5.x: Parse Error Handling
// ============================================================================

describe('Parse Error Handling', () => {

  // AC-5.1: Malformed YAML reports file path and line
  it('should report file path and line context for malformed YAML (AC-5.1)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    const malformedContent = readFileSync(join(FIXTURES_DIR, 'malformed.yaml'), 'utf8');
    const { docsDir } = setupValidStructuredDocs(tempDir);
    writeFileSync(join(docsDir, 'architecture.yaml'), malformedContent);

    // Act
    const { exitCode, stdout, stderr } = await runValidator(tempDir);

    // Assert
    const output = stdout + stderr;
    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/architecture\.yaml/); // reports file path
    expect(output).toMatch(/parse|syntax/i); // indicates parse issue
  });

  // AC-5.2: Parse errors categorized distinctly from schema violations
  it('should categorize parse errors distinctly from schema violations (AC-5.2)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    const malformedContent = readFileSync(join(FIXTURES_DIR, 'malformed.yaml'), 'utf8');
    const { docsDir } = setupValidStructuredDocs(tempDir);
    writeFileSync(join(docsDir, 'architecture.yaml'), malformedContent);

    // Act
    const { exitCode, stdout, stderr } = await runValidator(tempDir);

    // Assert — should say "parse error" not "schema violation"
    const output = stdout + stderr;
    expect(output).toMatch(/parse.*error/i);
  });

  // AC-5.3: Parse failure exits with non-zero code
  it('should exit with non-zero code on parse failure (AC-5.3)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    const malformedContent = readFileSync(join(FIXTURES_DIR, 'malformed.yaml'), 'utf8');
    const { docsDir } = setupValidStructuredDocs(tempDir);
    writeFileSync(join(docsDir, 'architecture.yaml'), malformedContent);

    // Act
    const { exitCode } = await runValidator(tempDir);

    // Assert
    expect(exitCode).not.toBe(0);
  });
});

// ============================================================================
// AC-6.5: Stale .mmd Source Hash Warning
// ============================================================================

describe('Staleness Detection', () => {

  // AC-6.5: Stale .mmd source hash triggers warning
  it('should warn when .mmd source hash does not match current YAML (AC-6.5)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    const { docsDir, generatedDir } = setupValidStructuredDocs(tempDir);

    // Create a generated .mmd file with a stale hash
    const staleHash = 'deadbeef';
    writeFileSync(
      join(generatedDir, 'architecture.mmd'),
      `%% source-hash: ${staleHash}\nflowchart TD\n  A --> B\n`
    );

    // Act
    const { exitCode, stdout, stderr } = await runValidator(tempDir);

    // Assert — warning about stale hash (exit 0 since warnings don't block)
    const output = stdout + stderr;
    expect(output).toMatch(/stale|mismatch|overwritten|outdated/i);
  });
});

// ============================================================================
// AC-7.3: Zero-Module Architecture Emits Scaffolder Nudge
// ============================================================================

describe('Scaffolder Nudge', () => {

  // AC-7.3: Zero-module architecture emits nudge
  it('should emit scaffolder nudge for zero-module architecture (AC-7.3)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange
    const emptyArch = readFileSync(
      join(FIXTURES_DIR, 'architecture-zero-modules.yaml'), 'utf8'
    );
    setupValidStructuredDocs(tempDir, {
      architecture: emptyArch,
      flowIndex: 'schema_version: 1\nflows: []\n',
      flowFiles: false,
      glossary: 'schema_version: 1\nterms: []\n',
    });

    // Act
    const { exitCode, stdout, stderr } = await runValidator(tempDir);

    // Assert — nudge, not error (exit 0)
    const output = stdout + stderr;
    expect(exitCode).toBe(0);
    expect(output).toMatch(/scaffold|nudge|no.*modules/i);
  });
});

// ============================================================================
// AC-11.6 / AC-11.7: Input Size Limits
// ============================================================================

describe('Input Size Limits', () => {

  // AC-11.6: Rejects architecture with >500 modules
  it('should reject architecture with more than 500 modules (AC-11.6)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange — generate architecture with 501 modules
    let modules = '';
    for (let i = 0; i < 501; i++) {
      modules += `  - name: module-${i}\n    description: Module ${i}\n    path: src/m${i}/**\n    responsibilities:\n      - Feature ${i}\n    dependencies: []\n`;
    }
    const oversizedArch = `schema_version: 1\nmodules:\n${modules}`;
    setupValidStructuredDocs(tempDir, {
      architecture: oversizedArch,
      flowIndex: 'schema_version: 1\nflows: []\n',
      flowFiles: false,
      glossary: 'schema_version: 1\nterms: []\n',
    });

    // Act
    const { exitCode, stdout, stderr } = await runValidator(tempDir);

    // Assert
    const output = stdout + stderr;
    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/500|limit|too many|size/i);
  });

  // AC-11.7: Rejects flow index with >100 flows
  it('should reject flow index with more than 100 flows (AC-11.7)', async () => {
    if (!validatorExists) { expect.fail('docs-validate.mjs not yet implemented'); return; }

    // Arrange — generate flow index with 101 flows
    let flows = '';
    for (let i = 0; i < 101; i++) {
      flows += `  - name: flow-${i}\n    file: flow-${i}.yaml\n    description: Flow ${i}\n`;
    }
    const oversizedIndex = `schema_version: 1\nflows:\n${flows}`;
    setupValidStructuredDocs(tempDir, {
      architecture: 'schema_version: 1\nmodules:\n  - name: m1\n    description: M1\n    path: src/**\n    responsibilities:\n      - F\n    dependencies: []\n',
      flowIndex: oversizedIndex,
      flowFiles: false,
      glossary: 'schema_version: 1\nterms: []\n',
    });

    // Act
    const { exitCode, stdout, stderr } = await runValidator(tempDir);

    // Assert
    const output = stdout + stderr;
    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/100|limit|too many|size/i);
  });
});

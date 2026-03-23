/**
 * Unit tests for structured docs template files
 *
 * Spec: sg-structured-docs
 * Covers: AC-8.1
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs docs-templates
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const TEMPLATES_DIR = join(PROJECT_ROOT, '.claude', 'templates', 'structured-docs');

// ============================================================================
// AC-8.1: Templates Contain Scaffolder Nudge Header Comments
// ============================================================================

describe('Template Header Comments (AC-8.1)', () => {

  it('should have architecture.yaml template with header comment directing to scaffolder (AC-8.1)', () => {
    // Arrange
    const templatePath = join(TEMPLATES_DIR, 'architecture.yaml');
    if (!existsSync(templatePath)) {
      expect.fail('architecture.yaml template does not exist at .claude/templates/structured-docs/');
      return;
    }

    // Act
    const content = readFileSync(templatePath, 'utf8');

    // Assert — should contain comment pointing to docs-scaffold.mjs
    expect(content).toMatch(/docs-scaffold|scaffold/i);
    expect(content).toMatch(/^#/m); // starts with a comment line
  });

  it('should have flows/index.yaml template with header comment (AC-8.1)', () => {
    // Arrange
    const templatePath = join(TEMPLATES_DIR, 'flows', 'index.yaml');
    if (!existsSync(templatePath)) {
      expect.fail('flows/index.yaml template does not exist at .claude/templates/structured-docs/flows/');
      return;
    }

    // Act
    const content = readFileSync(templatePath, 'utf8');

    // Assert
    expect(content).toMatch(/docs-scaffold|scaffold/i);
    expect(content).toMatch(/^#/m);
  });

  it('should have glossary.yaml template with header comment (AC-8.1)', () => {
    // Arrange
    const templatePath = join(TEMPLATES_DIR, 'glossary.yaml');
    if (!existsSync(templatePath)) {
      expect.fail('glossary.yaml template does not exist at .claude/templates/structured-docs/');
      return;
    }

    // Act
    const content = readFileSync(templatePath, 'utf8');

    // Assert
    expect(content).toMatch(/docs-scaffold|scaffold/i);
    expect(content).toMatch(/^#/m);
  });

  it('should have schema_version in all templates (AC-8.1)', () => {
    // Arrange
    const archTemplate = join(TEMPLATES_DIR, 'architecture.yaml');
    const glossaryTemplate = join(TEMPLATES_DIR, 'glossary.yaml');

    const templates = [archTemplate, glossaryTemplate].filter(existsSync);

    if (templates.length === 0) {
      expect.fail('No template files found');
      return;
    }

    // Act & Assert
    for (const templatePath of templates) {
      const content = readFileSync(templatePath, 'utf8');
      expect(content).toMatch(/schema_version/);
    }
  });

  it('should have empty collections in templates (AC-8.1)', () => {
    // Arrange
    const archTemplate = join(TEMPLATES_DIR, 'architecture.yaml');

    if (!existsSync(archTemplate)) {
      expect.fail('architecture.yaml template does not exist');
      return;
    }

    // Act
    const content = readFileSync(archTemplate, 'utf8');

    // Assert — should have modules key with empty list or minimal content
    expect(content).toMatch(/modules/);
  });
});

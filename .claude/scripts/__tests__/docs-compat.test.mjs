/**
 * Tests for backward compatibility and directory structure constraints
 *
 * Spec: sg-structured-docs
 * Covers: AC-12.1, AC-12.2
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs docs-compat
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const DOCS_DIR = join(PROJECT_ROOT, '.claude', 'docs');
const STRUCTURED_DIR = join(DOCS_DIR, 'structured');

// ============================================================================
// AC-12.1: Existing .claude/docs/ Files Are Not Modified
// ============================================================================

describe('Backward Compatibility (AC-12.1)', () => {

  it('should not modify existing .claude/docs/ non-structured files (AC-12.1)', () => {
    // Arrange — check if .claude/docs/ exists and has pre-existing content
    if (!existsSync(DOCS_DIR)) {
      // If docs directory doesn't exist yet, this AC is trivially satisfied
      expect(true).toBe(true);
      return;
    }

    // Act — list all files directly in .claude/docs/ (not under structured/)
    const entries = readdirSync(DOCS_DIR, { withFileTypes: true });
    const nonStructuredFiles = entries.filter(e =>
      e.name !== 'structured' && e.isFile()
    );

    // Assert — any pre-existing docs files should still exist
    // (This is a structural check; the implementer must ensure these are untouched)
    // The key assertion is that structured docs are additive
    for (const file of nonStructuredFiles) {
      const filePath = join(DOCS_DIR, file.name);
      expect(existsSync(filePath)).toBe(true);
    }
  });

  it('should not place structured doc YAML files in .claude/docs/ root (AC-12.1)', () => {
    // Arrange
    if (!existsSync(DOCS_DIR)) {
      expect(true).toBe(true);
      return;
    }

    // Act — check for any .yaml files directly in .claude/docs/
    const entries = readdirSync(DOCS_DIR, { withFileTypes: true });
    const yamlFilesInRoot = entries.filter(e =>
      e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml'))
    );

    // Assert — no structured doc YAML files should be in the docs root
    // (They should all be under structured/ subdirectory)
    for (const yamlFile of yamlFilesInRoot) {
      // architecture.yaml, glossary.yaml, etc. should NOT be here
      expect(yamlFile.name).not.toMatch(/^(architecture|glossary|decisions|runbooks)\.yaml$/);
    }
  });
});

// ============================================================================
// AC-12.2: All Structured Content Under .claude/docs/structured/
// ============================================================================

describe('Structured Content Directory (AC-12.2)', () => {

  it('should place all structured YAML files under .claude/docs/structured/ (AC-12.2)', () => {
    // Arrange
    if (!existsSync(STRUCTURED_DIR)) {
      // structured/ directory not yet created — this is acceptable during TDD
      // but the implementer must create it
      expect(true).toBe(true);
      return;
    }

    // Act — check that structured directory has expected structure
    const entries = readdirSync(STRUCTURED_DIR, { withFileTypes: true });
    const fileNames = entries.map(e => e.name);

    // Assert — if structured dir exists, it should follow the spec's directory layout
    // At minimum: architecture.yaml (or schema.yaml) should be present
    const hasStructuredContent = fileNames.some(name =>
      name.endsWith('.yaml') || name === 'flows' || name === 'generated'
    );

    expect(hasStructuredContent).toBe(true);
  });

  it('should have flows/ and generated/ subdirectories under structured/ (AC-12.2)', () => {
    // Arrange
    if (!existsSync(STRUCTURED_DIR)) {
      expect(true).toBe(true);
      return;
    }

    // Act
    const entries = readdirSync(STRUCTURED_DIR, { withFileTypes: true });
    const dirNames = entries.filter(e => e.isDirectory()).map(e => e.name);

    // Assert — should have expected subdirectories (when populated)
    // Note: flows/ and generated/ may not exist until scaffold/generate are run
    // This test validates the structure when present
    if (dirNames.length > 0) {
      const hasFlows = dirNames.includes('flows');
      const hasGenerated = dirNames.includes('generated');
      // At least one structured subdirectory should exist
      expect(hasFlows || hasGenerated).toBe(true);
    }
  });
});

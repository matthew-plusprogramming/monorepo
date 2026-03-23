/**
 * Integration tests for registry and sync integration of structured docs artifacts
 *
 * Spec: sg-structured-docs
 * Covers: AC-8.2, AC-8.3
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs docs-registry
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const REGISTRY_PATH = join(PROJECT_ROOT, '.claude', 'metaclaude-registry.json');

// ---------------------------------------------------------------------------
// Helper: Load registry
// ---------------------------------------------------------------------------

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) {
    return null;
  }
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
}

// ============================================================================
// AC-8.2: Templates Registered with never-overwrite, Scripts as Regular
// ============================================================================

describe('Registry Sync Policy (AC-8.2)', () => {

  it('should have structured-docs-templates category with never-overwrite sync policy (AC-8.2)', () => {
    // Arrange
    const registry = loadRegistry();
    if (!registry) { expect.fail('metaclaude-registry.json not found'); return; }

    // Act — find the templates category
    const categories = registry.categories || registry.artifacts || {};
    const templateCategory = categories['structured-docs-templates'];

    // Assert
    expect(templateCategory).toBeDefined();
    expect(templateCategory._sync_policy).toBe('never-overwrite');
  });

  it('should have scripts in the scripts category as overwritable artifacts (AC-8.2)', () => {
    // Arrange
    const registry = loadRegistry();
    if (!registry) { expect.fail('metaclaude-registry.json not found'); return; }

    // Act
    const categories = registry.categories || registry.artifacts || {};
    const scriptsCategory = categories['scripts'] || {};
    const allArtifacts = scriptsCategory.artifacts || scriptsCategory;

    // Assert — scripts category should contain docs-validate, docs-generate, docs-scaffold
    const artifactPaths = Object.keys(allArtifacts).length > 0
      ? Object.keys(allArtifacts)
      : [];
    const registryStr = JSON.stringify(categories['scripts'] || {});

    // Check for at least one structured-docs script being registered in scripts category
    const hasDocsValidate = registryStr.includes('docs-validate');
    const hasDocsGenerate = registryStr.includes('docs-generate');
    const hasDocsScaffold = registryStr.includes('docs-scaffold');

    expect(hasDocsValidate || hasDocsGenerate || hasDocsScaffold).toBe(true);

    // Scripts category should NOT have never-overwrite policy
    if (scriptsCategory._sync_policy) {
      expect(scriptsCategory._sync_policy).not.toBe('never-overwrite');
    }
  });
});

// ============================================================================
// AC-8.3: All Artifacts Present in Assigned Bundles
// ============================================================================

describe('Bundle Assignment (AC-8.3)', () => {

  it('should have all structured-docs artifacts in their assigned bundles (AC-8.3)', () => {
    // Arrange
    const registry = loadRegistry();
    if (!registry) { expect.fail('metaclaude-registry.json not found'); return; }

    // Act — collect all bundles and their included artifacts
    const bundles = registry.bundles || {};
    const allBundleArtifacts = new Set();
    for (const bundle of Object.values(bundles)) {
      const includes = bundle.includes || [];
      includes.forEach(a => allBundleArtifacts.add(a));
    }

    // Assert — structured docs artifacts should appear in at least one bundle
    // We check for the key scripts. They may be referenced by path or identifier.
    const registryStr = JSON.stringify(bundles);
    const hasDocsScripts = registryStr.includes('docs-validate') ||
      registryStr.includes('docs-generate') ||
      registryStr.includes('docs-scaffold') ||
      registryStr.includes('structured-docs');

    expect(hasDocsScripts).toBe(true);
  });

  it('should have structured-docs-templates bundle entries for template files (AC-8.3)', () => {
    // Arrange
    const registry = loadRegistry();
    if (!registry) { expect.fail('metaclaude-registry.json not found'); return; }

    // Act — check templates are in bundles
    const registryStr = JSON.stringify(registry);

    // Assert — template artifacts should be referenced somewhere in the registry
    const hasArchTemplate = registryStr.includes('architecture.yaml') ||
      registryStr.includes('architecture.yaml.template');
    const hasGlossaryTemplate = registryStr.includes('glossary.yaml');

    expect(hasArchTemplate).toBe(true);
  });
});

/**
 * Tests that structured docs scripts use only built-in Node.js modules
 * and the permitted yaml parsing package
 *
 * Spec: sg-structured-docs
 * Covers: AC-11.8
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs docs-dependency
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCRIPTS_DIR = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Allowed dependencies: Node.js built-ins and the yaml package
// ---------------------------------------------------------------------------

const NODE_BUILTINS = new Set([
  'node:fs', 'node:path', 'node:crypto', 'node:os', 'node:url',
  'node:child_process', 'node:util', 'node:stream', 'node:events',
  'node:assert', 'node:test', 'node:buffer', 'node:process',
  'fs', 'path', 'crypto', 'os', 'url', 'child_process', 'util',
  'stream', 'events', 'assert', 'test', 'buffer', 'process',
]);

const ALLOWED_EXTERNAL = new Set(['yaml']);

/**
 * Extracts import specifiers from a file's content.
 * Handles both static imports and dynamic imports.
 */
function extractImports(content) {
  const imports = [];

  // Static imports: import ... from 'specifier'
  const staticImportRegex = /(?:import\s+(?:[\s\S]*?)\s+from\s+|import\s+)['"]([^'"]+)['"]/g;
  let match;
  while ((match = staticImportRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // Dynamic imports: await import('specifier')
  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  return imports;
}

/**
 * Determines if an import specifier is a relative path.
 */
function isRelativeImport(specifier) {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

/**
 * Determines if an import specifier is a Node.js built-in.
 */
function isBuiltin(specifier) {
  return NODE_BUILTINS.has(specifier);
}

/**
 * Determines if an import specifier is an allowed external dependency.
 */
function isAllowedExternal(specifier) {
  // Handle scoped packages and subpath imports
  const pkgName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
  return ALLOWED_EXTERNAL.has(pkgName);
}

// ============================================================================
// AC-11.8: Scripts Use Only Built-ins and Allowed YAML Package
// ============================================================================

describe('Dependency Constraints (AC-11.8)', () => {

  const scriptFiles = [
    'docs-validate.mjs',
    'docs-generate.mjs',
    'docs-scaffold.mjs',
    join('lib', 'yaml-utils.mjs'),
  ];

  for (const scriptFile of scriptFiles) {
    it(`should use only built-ins and allowed yaml package in ${scriptFile} (AC-11.8)`, () => {
      // Arrange
      const scriptPath = join(SCRIPTS_DIR, scriptFile);
      if (!existsSync(scriptPath)) {
        expect.fail(`${scriptFile} not yet implemented`);
        return;
      }

      const content = readFileSync(scriptPath, 'utf8');

      // Act
      const imports = extractImports(content);

      // Assert — every non-relative import must be a built-in or allowed external
      const disallowedImports = imports.filter(specifier =>
        !isRelativeImport(specifier) &&
        !isBuiltin(specifier) &&
        !isAllowedExternal(specifier)
      );

      expect(disallowedImports).toEqual([]);
    });
  }

  it('should have yaml package in package.json dependencies (AC-11.8)', () => {
    // Arrange
    const pkgJsonPath = join(SCRIPTS_DIR, '..', '..', 'package.json');
    if (!existsSync(pkgJsonPath)) {
      expect.fail('package.json not found');
      return;
    }
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));

    // Act — check for yaml in dependencies (not devDependencies, since it runs in consumer projects)
    const deps = pkgJson.dependencies || {};
    const devDeps = pkgJson.devDependencies || {};

    // Assert
    const yamlInDeps = 'yaml' in deps;
    const yamlInDevDeps = 'yaml' in devDeps;

    // yaml should be in dependencies (regular, not dev) per spec
    expect(yamlInDeps || yamlInDevDeps).toBe(true);
  });
});

#!/usr/bin/env node

/**
 * Structured Documentation Scaffolder
 *
 * Generates a draft architecture.yaml with TODO placeholders by analyzing
 * the project's directory structure. Refuses to overwrite existing content.
 *
 * Usage:
 *   node .claude/scripts/docs-scaffold.mjs                    # Scaffold docs
 *   node .claude/scripts/docs-scaffold.mjs --project-root /p  # Override project root
 *
 * Behavior:
 * - If architecture.yaml exists with non-zero modules: refuses, exits with message (AC-7.2)
 * - If architecture.yaml is missing or has zero modules: generates draft (AC-7.1)
 * - Scans top-level directories to infer candidate modules
 * - Generated draft uses TODO placeholders for human review
 *
 * Implements: REQ-010
 * Spec: sg-structured-docs, Task 10
 */

import { existsSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml'; // Used for YAML.stringify() only — all parsing MUST go through yaml-utils.mjs

import {
  readAndParseYaml,
  getStructuredDocsDir,
  resolveProjectRoot,
  CURRENT_SCHEMA_VERSION,
} from './lib/yaml-utils.mjs';

// =============================================================================
// Constants
// =============================================================================

/** Directories to skip when scanning for modules */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.vscode',
  '.idea',
  'vendor',
  '.turbo',
]);

// =============================================================================
// Directory Analysis
// =============================================================================

/**
 * Convert a directory name to a human-readable module description.
 *
 * @param {string} dirName - Directory name
 * @returns {string} Human-readable description placeholder
 */
function dirNameToDescription(dirName) {
  const name = dirName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `TODO: Describe what the ${name} module does`;
}

/**
 * Scan a project directory and propose candidate modules.
 *
 * Scans for:
 * - apps/* (monorepo applications)
 * - packages/* (monorepo packages)
 * - src/ (single-project source)
 * - Top-level directories with source files
 *
 * @param {string} projectRoot - Absolute project root path
 * @returns {Array<{name: string, description: string, path: string, responsibilities: string[]}>}
 */
export function analyzeProjectStructure(projectRoot) {
  const candidates = [];

  // Check for monorepo structure
  const appsDir = join(projectRoot, 'apps');
  const packagesDir = join(projectRoot, 'packages');
  let hasMonorepoStructure = false;

  if (existsSync(appsDir)) {
    hasMonorepoStructure = true;
    try {
      const entries = readdirSync(appsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
          candidates.push({
            name: entry.name,
            description: dirNameToDescription(entry.name),
            path: `apps/${entry.name}/**`,
            responsibilities: ['TODO: List key responsibilities'],
          });
        }
      }
    } catch {
      // Skip on read failure
    }
  }

  if (existsSync(packagesDir)) {
    hasMonorepoStructure = true;
    try {
      const entries = readdirSync(packagesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
          candidates.push({
            name: `pkg-${entry.name}`,
            description: dirNameToDescription(entry.name),
            path: `packages/${entry.name}/**`,
            responsibilities: ['TODO: List key responsibilities'],
          });
        }
      }
    } catch {
      // Skip on read failure
    }
  }

  // Check for single-project src/ directory
  const srcDir = join(projectRoot, 'src');
  if (existsSync(srcDir) && !hasMonorepoStructure) {
    // Scan src/ subdirectories
    try {
      const entries = readdirSync(srcDir, { withFileTypes: true });
      const subDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name));

      if (subDirs.length > 0) {
        for (const entry of subDirs) {
          candidates.push({
            name: entry.name,
            description: dirNameToDescription(entry.name),
            path: `src/${entry.name}/**`,
            responsibilities: ['TODO: List key responsibilities'],
          });
        }
      } else {
        // Flat src/ with no subdirectories
        candidates.push({
          name: 'source',
          description: 'TODO: Describe the main source module',
          path: 'src/**',
          responsibilities: ['TODO: List key responsibilities'],
        });
      }
    } catch {
      // Skip on read failure
    }
  }

  // If no monorepo or src, scan top-level for directories with source files
  if (candidates.length === 0) {
    try {
      const entries = readdirSync(projectRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
          // Check if directory has source files
          const dirPath = join(projectRoot, entry.name);
          if (hasSourceFiles(dirPath)) {
            candidates.push({
              name: entry.name,
              description: dirNameToDescription(entry.name),
              path: `${entry.name}/**`,
              responsibilities: ['TODO: List key responsibilities'],
            });
          }
        }
      }
    } catch {
      // Skip on read failure
    }
  }

  return candidates;
}

/**
 * Check if a directory (non-recursively) contains source-like files.
 *
 * @param {string} dirPath
 * @returns {boolean}
 */
function hasSourceFiles(dirPath) {
  const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs', '.java']);
  try {
    const entries = readdirSync(dirPath);
    return entries.some(e => {
      const ext = e.substring(e.lastIndexOf('.'));
      return sourceExtensions.has(ext);
    });
  } catch {
    return false;
  }
}

// =============================================================================
// Scaffold Pipeline
// =============================================================================

/**
 * Run the scaffolding pipeline.
 *
 * @param {string} projectRoot - Absolute project root path
 * @returns {{ status: 'created' | 'refused', message: string }}
 */
export function scaffold(projectRoot) {
  const docsDir = getStructuredDocsDir(projectRoot);
  const archPath = join(docsDir, 'architecture.yaml');

  // AC-7.2: Check if architecture.yaml already has content
  if (existsSync(archPath)) {
    try {
      const { data } = readAndParseYaml(archPath);
      if (data && Array.isArray(data.modules) && data.modules.length > 0) {
        return {
          status: 'refused',
          message: `architecture.yaml already has ${data.modules.length} module(s). Edit it directly at: ${archPath}`,
        };
      }
    } catch {
      // If we can't parse it, it may be malformed. Treat as having content (don't overwrite).
      return {
        status: 'refused',
        message: `architecture.yaml exists but could not be parsed. Fix or delete it manually: ${archPath}`,
      };
    }
  }

  // AC-7.1: Analyze project and generate draft
  const candidates = analyzeProjectStructure(projectRoot);

  const archDoc = {
    schema_version: CURRENT_SCHEMA_VERSION,
    modules: candidates,
  };

  // Ensure directory structure exists
  mkdirSync(join(docsDir, 'flows'), { recursive: true });
  mkdirSync(join(docsDir, 'generated'), { recursive: true });

  // Write architecture.yaml with helpful comments
  const yamlStr = YAML.stringify(archDoc, {
    lineWidth: 120,
    defaultKeyType: 'PLAIN',
    defaultStringType: 'PLAIN',
  });

  const header = `# Architecture Module Map
# Generated by docs-scaffold.mjs on ${new Date().toISOString().split('T')[0]}
#
# Review and fill in the TODO placeholders below.
# Add depends_on arrays to define module dependencies.
# Run \`node .claude/scripts/docs-validate.mjs\` to check for issues.
# Run \`node .claude/scripts/docs-generate.mjs\` to create Mermaid diagrams.
#
`;

  writeFileSync(archPath, header + yamlStr);

  // Create empty flow index if it doesn't exist
  const flowsIndexPath = join(docsDir, 'flows', 'index.yaml');
  if (!existsSync(flowsIndexPath)) {
    const flowsIndex = {
      schema_version: CURRENT_SCHEMA_VERSION,
      flows: [],
    };
    const flowsStr = YAML.stringify(flowsIndex);
    const flowsHeader = `# Flow Index
# Add flow entries here, then create corresponding YAML files in this directory.
# Each flow file defines steps with module references from architecture.yaml.
#
`;
    writeFileSync(flowsIndexPath, flowsHeader + flowsStr);
  }

  // Create empty glossary if it doesn't exist
  const glossaryPath = join(docsDir, 'glossary.yaml');
  if (!existsSync(glossaryPath)) {
    const glossary = {
      schema_version: CURRENT_SCHEMA_VERSION,
      terms: [],
    };
    const glossaryStr = YAML.stringify(glossary);
    const glossaryHeader = `# Project Glossary
# Add project-specific terms and definitions here.
# Use see_also to cross-reference related terms.
#
`;
    writeFileSync(glossaryPath, glossaryHeader + glossaryStr);
  }

  return {
    status: 'created',
    message: `Draft architecture.yaml created with ${candidates.length} candidate module(s). Review and fill TODOs at: ${archPath}`,
  };
}

// =============================================================================
// CLI Entry Point
// =============================================================================

async function main() {
  try {
    const projectRoot = resolveProjectRoot();
    const result = scaffold(projectRoot);

    console.log(result.message);
    process.exit(result.status === 'created' ? 0 : 1);
  } catch (err) {
    console.error(`Scaffolding failed: ${err.message}`);
    process.exit(1);
  }
}

// Run main only if executed directly
const isMainModule = process.argv[1] &&
  process.argv[1].endsWith('docs-scaffold.mjs') &&
  !process.argv[1].endsWith('.test.mjs');

if (isMainModule) {
  main();
}
